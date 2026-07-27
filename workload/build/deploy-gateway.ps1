#Requires -Version 7.0
<#
.SYNOPSIS
Builds and deploys the asmDB CDC gateway Container App.

.DESCRIPTION
Deploys only new CDC gateway resources into <service-resource-group>. The live asmDB instance
storage registration is copied into a separate read-only NFS Azure Files
environment storage named asmdb-data-ro; the existing asmdb-data registration is
not modified. NFS Azure Files Container Apps mounts use server/shareName and do
not require an account key.
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string]$SubscriptionId = '<subscription-id>',
    [string]$ResourceGroup = '<service-resource-group>',
    [string]$Location = 'swedencentral',
    [string]$EnvironmentName = 'asmdb-env',
    [string]$WritableStorageName = 'asmdb-data',
    [string]$ReadOnlyStorageName = 'asmdb-data-ro',
    [string]$RegistryName = '<registry>',
    [string]$IdentityName = 'asmdb-mi',
    [string]$ContainerAppName = 'asmdb-cdc-gateway',
    [string]$ImageRepository = 'asmdb-cdc-gateway',
    [string]$ImageTag = ("{0:yyyyMMddHHmmss}" -f (Get-Date)),
    [string]$GatewayToken = '',
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$GatewayRoot = Join-Path $RepoRoot 'workload\cdc-gateway'
$ScratchRoot = Join-Path $PSScriptRoot '.gateway-deploy'
$MountPath = '/mnt/asmdb'
$TargetPort = 8080
$StorageApiVersion = '2024-10-02-preview'
$ContainerAppApiVersion = '2024-03-01'

function Write-Step { param([string]$Message) Write-Host "  -> $Message" -ForegroundColor Green }
function Write-Ok { param([string]$Message) Write-Host "  OK $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "  !  $Message" -ForegroundColor Yellow }

function Assert-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name is required."
    }
}

function Invoke-External {
    param(
        [string]$FilePath,
        [string[]]$ArgumentList,
        [string]$Description,
        [switch]$SkipWhenWhatIf
    )
    if ($SkipWhenWhatIf -and $WhatIfPreference) {
        if ($PSCmdlet.ShouldProcess($Description, "$FilePath $($ArgumentList -join ' ')")) { }
        return ''
    }
    Write-Step $Description
    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE"
    }
}

function Invoke-Az {
    param(
        [string[]]$ArgumentList,
        [string]$Description,
        [switch]$SkipWhenWhatIf
    )
    Invoke-External 'az' ($ArgumentList + @('--subscription', $SubscriptionId, '--only-show-errors')) $Description -SkipWhenWhatIf:$SkipWhenWhatIf
}

function ConvertTo-BodyFile {
    param($Body, [string]$Name)
    if (-not (Test-Path $ScratchRoot)) {
        New-Item -ItemType Directory -Path $ScratchRoot | Out-Null
    }
    $path = Join-Path $ScratchRoot $Name
    $json = $Body | ConvertTo-Json -Depth 100
    [IO.File]::WriteAllText($path, $json, (New-Object Text.UTF8Encoding $false))
    return $path
}

function Invoke-AzRestWithBody {
    param(
        [ValidateSet('PUT','PATCH')]
        [string]$Method,
        [string]$Uri,
        $Body,
        [string]$Description
    )
    if ($WhatIfPreference) {
        Invoke-Az @('rest','--method',$Method,'--uri',$Uri,'--headers','Content-Type=application/json','--body','<generated-json>') $Description -SkipWhenWhatIf
        return
    }
    $bodyFile = ConvertTo-BodyFile -Body $Body -Name (([Guid]::NewGuid().ToString()) + '.json')
    try {
        Invoke-Az @('rest','--method',$Method,'--uri',$Uri,'--headers','Content-Type=application/json','--body',"@$bodyFile") $Description -SkipWhenWhatIf
    } finally {
        Remove-Item $bodyFile -Force -ErrorAction SilentlyContinue
    }
}

function Get-AzJson {
    param([string[]]$ArgumentList, [string]$Description)
    Write-Step $Description
    $json = & az @($ArgumentList + @('--subscription', $SubscriptionId, '--only-show-errors', '-o', 'json'))
    if ($LASTEXITCODE -ne 0) { throw "$Description failed with exit code $LASTEXITCODE" }
    if ([string]::IsNullOrWhiteSpace($json)) { return $null }
    return $json | ConvertFrom-Json
}

function New-StrongToken {
    $bytes = [byte[]]::new(48)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
}

try {
    Assert-Command 'az'
    if (-not (Test-Path (Join-Path $GatewayRoot 'Dockerfile'))) {
        throw "Dockerfile not found in $GatewayRoot"
    }

    Invoke-Az @('account','set') 'Select Azure subscription' -SkipWhenWhatIf

    $env = Get-AzJson @('containerapp','env','show','--resource-group',$ResourceGroup,'--name',$EnvironmentName) "Read Container Apps environment $EnvironmentName"
    $registry = Get-AzJson @('acr','show','--resource-group',$ResourceGroup,'--name',$RegistryName) "Read ACR $RegistryName"
    $identity = Get-AzJson @('identity','show','--resource-group',$ResourceGroup,'--name',$IdentityName) "Read managed identity $IdentityName"
    $writableStorage = Get-AzJson @('containerapp','env','storage','show','--resource-group',$ResourceGroup,'--name',$EnvironmentName,'--storage-name',$WritableStorageName) "Read existing storage $WritableStorageName"

    if ($null -eq $writableStorage.properties.nfsAzureFile) {
        throw "$WritableStorageName is not an NFS Azure Files environment storage; refusing to guess a mount."
    }
    $nfs = $writableStorage.properties.nfsAzureFile
    if ([string]::IsNullOrWhiteSpace([string]$nfs.server) -or [string]::IsNullOrWhiteSpace([string]$nfs.shareName)) {
        throw "$WritableStorageName does not expose server/shareName; refusing to guess a mount."
    }

    $loginServer = [string]$registry.loginServer
    $identityId = [string]$identity.id
    $environmentId = [string]$env.id
    $image = "$loginServer/$ImageRepository`:$ImageTag"
    $storageUri = "https://management.azure.com/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.App/managedEnvironments/$EnvironmentName/storages/$ReadOnlyStorageName`?api-version=$StorageApiVersion"
    $appUri = "https://management.azure.com/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.App/containerApps/$ContainerAppName`?api-version=$ContainerAppApiVersion"

    $roStorageBody = @{
        properties = @{
            nfsAzureFile = @{
                server = [string]$nfs.server
                shareName = [string]$nfs.shareName
                accessMode = 'ReadOnly'
            }
        }
    }
    if ($PSCmdlet.ShouldProcess($ReadOnlyStorageName, "Create/update read-only NFS Azure Files environment storage")) {
        Invoke-AzRestWithBody -Method PUT -Uri $storageUri -Body $roStorageBody -Description "Ensure read-only storage $ReadOnlyStorageName"
    }

    if ($PSCmdlet.ShouldProcess($image, "Build and push CDC gateway image with ACR Tasks")) {
        Invoke-Az @('acr','build','--registry',$RegistryName,'--image',"$ImageRepository`:$ImageTag",'--file',(Join-Path $GatewayRoot 'Dockerfile'),$GatewayRoot) "Build and push $image" -SkipWhenWhatIf
    }

    $effectiveToken = if ([string]::IsNullOrWhiteSpace($GatewayToken)) { New-StrongToken } else { $GatewayToken }
    $appBody = @{
        location = $Location
        identity = @{
            type = 'UserAssigned'
            userAssignedIdentities = @{
                $identityId = @{}
            }
        }
        properties = @{
            managedEnvironmentId = $environmentId
            configuration = @{
                activeRevisionsMode = 'Single'
                ingress = @{
                    external = $true
                    targetPort = $TargetPort
                    transport = 'Auto'
                    allowInsecure = $false
                    traffic = @(
                        @{
                            latestRevision = $true
                            weight = 100
                        }
                    )
                }
                registries = @(
                    @{
                        server = $loginServer
                        identity = $identityId
                    }
                )
                secrets = @(
                    @{
                        name = 'gateway-token'
                        value = $effectiveToken
                    }
                )
            }
            template = @{
                containers = @(
                    @{
                        name = 'cdc-gateway'
                        image = $image
                        env = @(
                            @{ name = 'ASMDB_SHARE_ROOT'; value = $MountPath },
                            @{ name = 'ASMDB_GATEWAY_TOKEN'; secretRef = 'gateway-token' },
                            @{ name = 'PORT'; value = [string]$TargetPort }
                        )
                        resources = @{
                            cpu = 0.25
                            memory = '0.5Gi'
                        }
                        volumeMounts = @(
                            @{
                                volumeName = 'asmdb-share'
                                mountPath = $MountPath
                            }
                        )
                    }
                )
                volumes = @(
                    @{
                        name = 'asmdb-share'
                        storageType = 'NfsAzureFile'
                        storageName = $ReadOnlyStorageName
                    }
                )
                scale = @{
                    minReplicas = 1
                    maxReplicas = 1
                }
            }
        }
    }
    if ($PSCmdlet.ShouldProcess($ContainerAppName, "Create/update CDC gateway Container App")) {
        Invoke-AzRestWithBody -Method PUT -Uri $appUri -Body $appBody -Description "Ensure Container App $ContainerAppName"
    }

    if ($WhatIfPreference) {
        Write-Warn 'WhatIf complete; no Azure resources were changed.'
        Write-Host "Planned image: $image"
        return
    }

    $app = Get-AzJson @('containerapp','show','--resource-group',$ResourceGroup,'--name',$ContainerAppName) "Read deployed Container App"
    $fqdn = [string]$app.properties.configuration.ingress.fqdn
    $url = "https://$fqdn"

    Write-Host ''
    Write-Ok "Gateway URL: $url"
    Write-Host "Bearer token (store in Key Vault; it is shown only by this script run): $effectiveToken"
} finally {
    Remove-Item $ScratchRoot -Recurse -Force -ErrorAction SilentlyContinue
}
