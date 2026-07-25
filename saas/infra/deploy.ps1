param(
    [string]$Tag = 'latest',
    [switch]$SkipBuild,
    [switch]$SkipApim,
    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$TenantId = '<tenant-id>'
$SubscriptionId = '<subscription-id>'
$ResourceGroup = '<service-resource-group>'
$Location = 'swedencentral'
$DeploymentName = 'asmdb-platform'
$InfraDir = Split-Path -Parent $PSCommandPath
$RepoRoot = (Resolve-Path (Join-Path $InfraDir '..\..')).Path
$TemplateFile = Join-Path $InfraDir 'main.bicep'
$InstanceDockerfile = Join-Path $RepoRoot 'saas\sidecar\Dockerfile'
$ControlPlaneDockerfile = Join-Path $RepoRoot 'saas\controlplane\Dockerfile'

function Require-AzCli {
    if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
        throw 'Azure CLI (az) was not found on PATH. Install it and run az login before deploying.'
    }
}

function Invoke-AzJson([string[]]$Arguments) {
    $output = & az @Arguments --only-show-errors --output json 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($output | Out-String) }
    if ([string]::IsNullOrWhiteSpace(($output | Out-String))) { return $null }
    return ($output | Out-String | ConvertFrom-Json)
}

function Invoke-Az([string[]]$Arguments) {
    & az @Arguments --only-show-errors
    if ($LASTEXITCODE -ne 0) { throw "az $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
}

function Get-OutputValue($Outputs, [string]$Name) {
    return $Outputs.$Name.value
}

function Test-ExistingEnvironmentCanMovePrivate {
    try {
        $env = Invoke-AzJson @('containerapp', 'env', 'show', '--name', 'asmdb-env', '--resource-group', $ResourceGroup)
    }
    catch {
        return
    }
    if (-not $env) { return }

    $infraSubnetId = $null
    if ($env.properties -and $env.properties.vnetConfiguration) {
        $infraSubnetId = $env.properties.vnetConfiguration.infrastructureSubnetId
    }

    if ([string]::IsNullOrWhiteSpace($infraSubnetId)) {
        $message = @"
Container Apps environment 'asmdb-env' already exists without VNet integration.
Azure cannot add vnetConfiguration/internal ingress to an existing non-VNet Container Apps environment in place.
Delete the apps in that environment first (asmdb-cp and any db-* instance apps), then delete 'asmdb-env', and rerun this script.
"@
        if ($WhatIf) {
            Write-Warning $message
        }
        else {
            throw $message
        }
    }
}

function Get-DeploymentErrorSummary {
    $operations = Invoke-AzJson @(
        'deployment', 'operation', 'group', 'list',
        '--resource-group', $ResourceGroup,
        '--name', $DeploymentName,
        '--query', "[?properties.provisioningState=='Failed'].{resource:properties.targetResource.resourceName,status:properties.statusMessage}",
        '--output', 'json'
    )
    if ($operations) { return ($operations | ConvertTo-Json -Depth 20) }
    return 'No failed deployment operation details were returned by Azure.'
}

function Invoke-GroupDeployment([string]$Description, [string]$ControlPlaneImage) {
    $parameters = @("tag=$Tag", "location=$Location", "deployApim=$(-not $SkipApim)")
    if (-not [string]::IsNullOrWhiteSpace($ControlPlaneImage)) {
        $parameters += "controlPlaneImage=$ControlPlaneImage"
    }

    Write-Host ''
    Write-Host $Description
    if (-not $SkipApim) {
        Write-Host 'APIM Developer SKU creation commonly takes 30-45 minutes. Waiting with a 90-minute budget and printing progress...'
    }

    $deploymentArgs = @(
        'deployment', 'group', 'create',
        '--resource-group', $ResourceGroup,
        '--name', $DeploymentName,
        '--template-file', $TemplateFile,
        '--parameters'
    ) + $parameters + @('--no-wait')
    Invoke-Az $deploymentArgs

    $deadline = (Get-Date).AddMinutes(90)
    $started = Get-Date
    do {
        Start-Sleep -Seconds 30
        $deployment = Invoke-AzJson @('deployment', 'group', 'show', '--resource-group', $ResourceGroup, '--name', $DeploymentName)
        $state = $deployment.properties.provisioningState
        $elapsed = [int]((Get-Date) - $started).TotalMinutes
        Write-Host ("Deployment state: {0} (elapsed {1} min)" -f $state, $elapsed)

        if ($state -eq 'Succeeded') { return $deployment }
        if ($state -in @('Failed', 'Canceled')) {
            throw "Deployment '$DeploymentName' $state. $((Get-DeploymentErrorSummary))"
        }
    } while ((Get-Date) -lt $deadline)

    throw "Deployment '$DeploymentName' did not complete within 90 minutes."
}

Require-AzCli

$account = Invoke-AzJson @('account', 'show')
if (-not $account) { throw 'Azure CLI is not logged in. Run az login --tenant <tenant-id> first.' }
if ($account.tenantId -ne $TenantId) {
    throw "Azure CLI is logged into tenant '$($account.tenantId)', expected '$TenantId'. Run az login --tenant $TenantId."
}
if ($account.id -ne $SubscriptionId) {
    Invoke-Az @('account', 'set', '--subscription', $SubscriptionId)
    $account = Invoke-AzJson @('account', 'show')
    if ($account.id -ne $SubscriptionId -or $account.tenantId -ne $TenantId) {
        throw "Failed to select subscription '$SubscriptionId' in tenant '$TenantId'."
    }
}

$group = Invoke-AzJson @('group', 'show', '--name', $ResourceGroup)
if (-not $group) { throw "Resource group '$ResourceGroup' does not exist. It must be created before running this script." }
if ($group.location -ne $Location) { throw "Resource group '$ResourceGroup' is in '$($group.location)', expected '$Location'." }

Test-ExistingEnvironmentCanMovePrivate

if ($WhatIf) {
    $whatIfParameters = @("tag=$Tag", "location=$Location", "deployApim=$(-not $SkipApim)")
    $whatIfArgs = @(
        'deployment', 'group', 'what-if',
        '--resource-group', $ResourceGroup,
        '--name', $DeploymentName,
        '--template-file', $TemplateFile,
        '--parameters'
    ) + $whatIfParameters
    Invoke-Az $whatIfArgs
    return
}

$deployment = Invoke-GroupDeployment 'Deploying infrastructure with placeholder control-plane image...' $null
$outputs = $deployment.properties.outputs
$registryName = Get-OutputValue $outputs 'registryName'
$registryLoginServer = Get-OutputValue $outputs 'registryLoginServer'
$controlPlaneImage = "$registryLoginServer/asmdb-controlplane:$Tag"

if (-not $SkipBuild) {
    if (-not (Test-Path -LiteralPath $InstanceDockerfile)) { throw "Missing Dockerfile: $InstanceDockerfile. The sidecar image cannot be built yet." }
    if (-not (Test-Path -LiteralPath $ControlPlaneDockerfile)) { throw "Missing Dockerfile: $ControlPlaneDockerfile. The control-plane image cannot be built yet." }

    Push-Location $RepoRoot
    try {
        Invoke-Az @('acr', 'build', '--registry', $registryName, '--image', "asmdb-instance:$Tag", '--file', 'saas\sidecar\Dockerfile', '.')
        Invoke-Az @('acr', 'build', '--registry', $registryName, '--image', "asmdb-controlplane:$Tag", '--file', 'saas\controlplane\Dockerfile', '.')
    }
    finally {
        Pop-Location
    }
}

$deployment = Invoke-GroupDeployment 'Deploying real control-plane image...' $controlPlaneImage
$outputs = $deployment.properties.outputs
$controlPlaneFqdn = Get-OutputValue $outputs 'controlPlaneFqdn'
$controlPlaneInternalFqdn = Get-OutputValue $outputs 'controlPlaneInternalFqdn'
$apimGatewayUrl = Get-OutputValue $outputs 'apimGatewayUrl'
$instanceStorageName = Get-OutputValue $outputs 'instanceStorageName'
$instancePublicBase = Get-OutputValue $outputs 'instancePublicBase'

Invoke-Az @(
    'containerapp', 'update',
    '--name', 'asmdb-cp',
    '--resource-group', $ResourceGroup,
    '--set-env-vars', "ASMDB_PUBLIC_BASE=$instancePublicBase", "ASMDB_ENV_STORAGE=$instanceStorageName"
)

$deadline = (Get-Date).AddMinutes(10)
do {
    Start-Sleep -Seconds 10
    $app = Invoke-AzJson @('containerapp', 'show', '--name', 'asmdb-cp', '--resource-group', $ResourceGroup)
    $ready = @($app.properties.latestReadyRevisionName, $app.properties.latestRevisionName) | Where-Object { $_ } | Select-Object -First 1
    $provisioningState = $app.properties.provisioningState
    if ($app.properties.latestReadyRevisionName -eq $app.properties.latestRevisionName -and $provisioningState -eq 'Succeeded') { break }
} while ((Get-Date) -lt $deadline)

if ($app.properties.latestReadyRevisionName -ne $app.properties.latestRevisionName -or $app.properties.provisioningState -ne 'Succeeded') {
    throw "Container App revision did not become healthy within 10 minutes. Latest='$($app.properties.latestRevisionName)', ready='$($app.properties.latestReadyRevisionName)', state='$($app.properties.provisioningState)'."
}

$url = $apimGatewayUrl
Write-Host ''
Write-Host 'asmdb Cloud deployment ready'
if ($SkipApim) {
    Write-Host 'APIM was skipped; no public site URL was deployed.'
}
else {
    Write-Host "Site URL:          $url"
}
Write-Host "Control plane:     https://$controlPlaneInternalFqdn (private)"
Write-Host "Instance base URL: $instancePublicBase"
Write-Host "Instance storage:  $instanceStorageName"
Write-Host "Registry:          $registryName ($registryLoginServer)"
Write-Host ''
Write-Host 'Create a database:'
if (-not $SkipApim) {
    Write-Host "curl -X POST '$url/api/v1/databases' -H 'Content-Type: application/json' -d '{`"name`":`"my-notes`",`"tier`":`"free`"}'"
}
