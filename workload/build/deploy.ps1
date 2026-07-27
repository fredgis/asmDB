#Requires -Version 7.0
<#!
.SYNOPSIS
Builds, packages, and deploys the asmDB Analytical Capabilities Fabric workload.

.DESCRIPTION
Eight SkyNav-style phases: validate prerequisites, Azure login/context, Entra app registration,
infrastructure, build, backend deploy, frontend deploy, and NuGet packaging. Use -WhatIf for a
static end-to-end dry run. Use -Only to run a single phase during iteration.
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [ValidateSet('all','validate','login','entra','infrastructure','build','backend','frontend','pack')]
    [string]$Only = 'all',

    [string]$SubscriptionId = '<subscription-id>',
    [string]$ResourceGroup = '<analytics-resource-group>',
    [string]$Location = 'swedencentral',
    # Static Web Apps is not offered in every region: at the time of writing it
    # is limited to centralus, eastus2, westus2, westeurope and eastasia, so it
    # cannot follow $Location into swedencentral. A resource may sit in a
    # different region from its resource group, so the group stays put.
    [string]$StaticWebAppLocation = 'westeurope',
    [string]$AppServicePlan = 'plan-asmdb-analytical',
    [string]$BackendAppName = 'asmdb-analytical-backend',
    [string]$StaticWebAppName = 'asmdb-analytical-frontend',
    [string]$CustomDomain = 'REPLACE-ME.fe.workload.asmdb.cloud',
    [string]$EntraAppName = 'asmDB Analytical Capabilities',
    [string]$TenantId = '',
    [string]$AppId = '',
    [string]$BackendUrl = '',
    [string]$FrontendUrl = '',
    [string]$NuGetVersion = '1.0.0',
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
    [switch]$Strict
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$AllowedManifestAssetExtensions = @('.png', '.jpg', '.jpeg')
$MaxManifestAssetBytes = 1572864
$PowerBiServiceAppId = '00000009-0000-0000-c000-000000000000'
$RequiredPowerBiScopes = @('Workspace.Read.All', 'Item.Read.All', 'Item.ReadWrite.All')

$ManifestRoot = Join-Path $RepoRoot 'workload\manifest'
$ItemsRoot = Join-Path $ManifestRoot 'items'
$BuildRoot = Join-Path $RepoRoot 'workload\build'
$SettingsPath = Join-Path $BuildRoot 'workload.settings.json'
$Settings = Get-Content $SettingsPath -Raw | ConvertFrom-Json
$WorkloadId = [string]$Settings.workloadId
$ItemName = [string]$Settings.itemName
$AppIdUri = ([string]$Settings.appIdUriTemplate).Replace('{WorkloadId}', $WorkloadId)
$FrontendRoot = Join-Path $RepoRoot 'workload\frontend'
$BackendRoot = Join-Path $RepoRoot 'workload\backend'
$PackageRoot = Join-Path $BuildRoot 'package'
$NuspecPath = Join-Path $BuildRoot 'Workload.nuspec'
$NupkgPath = Join-Path $BuildRoot "out\$WorkloadId.$NuGetVersion.nupkg"
$ZeroGuid = '00000000-0000-0000-0000-000000000000'

function Write-Phase { param([string]$Number, [string]$Title) Write-Host "`n$('=' * 72)" -ForegroundColor Cyan; Write-Host "Phase $Number - $Title" -ForegroundColor Cyan; Write-Host "$('=' * 72)" -ForegroundColor Cyan }
function Write-Step { param([string]$Message) Write-Host "  -> $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "  !  $Message" -ForegroundColor Yellow }
function Write-Ok { param([string]$Message) Write-Host "  OK $Message" -ForegroundColor Green }

function Assert-Command {
    param([string]$Name, [switch]$OptionalWhenWhatIf)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        if ($WhatIfPreference -and $OptionalWhenWhatIf) {
            Write-Warn "$Name not found; dry run continues, but real deployment requires it."
            return
        }
        throw "$Name is required. Install it before running deploy.ps1."
    }
    Write-Ok "$Name found"
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
    Invoke-External 'az' ($ArgumentList + @('--subscription', $SubscriptionId)) $Description -SkipWhenWhatIf:$SkipWhenWhatIf
}

function Get-ManifestJsonStrings {
    param($Value)
    if ($null -eq $Value) { return @() }
    if ($Value -is [string]) { return @($Value) }
    $results = @()
    if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
        foreach ($item in $Value) { $results += Get-ManifestJsonStrings -Value $item }
        return $results
    }
    if ($Value.PSObject -and @($Value.PSObject.Properties).Count -gt 0) {
        foreach ($prop in $Value.PSObject.Properties) { $results += Get-ManifestJsonStrings -Value $prop.Value }
    }
    return $results
}

function Test-ValidManifestVideoUrl {
    param([string]$Url)
    if ([string]::IsNullOrWhiteSpace($Url)) { return $false }
    return ($Url -match '^https://(www\.)?youtube\.com/embed/[^/?#]+' -or $Url -match '^https://player\.vimeo\.com/video/\d+')
}

function Assert-ManifestPackagingInputs {
    param(
        [string]$ManifestRoot = (Join-Path $RepoRoot 'workload\manifest'),
        [string]$ItemsRoot = (Join-Path (Join-Path $RepoRoot 'workload\manifest') 'items')
    )
    $assetsSourceDir = Join-Path $ManifestRoot 'assets'
    if (-not (Test-Path $assetsSourceDir)) { throw "Manifest assets directory not found: $assetsSourceDir" }

    $jsonFiles = @((Join-Path $ManifestRoot 'Product.json'))
    if (Test-Path $ItemsRoot) { $jsonFiles += Get-ChildItem $ItemsRoot -Recurse -Filter '*.json' | Select-Object -ExpandProperty FullName }

    foreach ($asset in Get-ChildItem $assetsSourceDir -File) {
        $extension = $asset.Extension.ToLowerInvariant()
        if ($extension -notin $AllowedManifestAssetExtensions) { throw "Unsupported manifest asset extension: $($asset.FullName). Allowed: $($AllowedManifestAssetExtensions -join ', ')" }
        if ($asset.Length -gt $MaxManifestAssetBytes) { throw "Manifest asset too large: $($asset.FullName) ($($asset.Length) bytes > $MaxManifestAssetBytes)" }
    }

    foreach ($jsonPath in $jsonFiles) {
        $json = Get-Content $jsonPath -Raw | ConvertFrom-Json
        $assetReferences = Get-ManifestJsonStrings -Value $json | Where-Object { $_ -like 'assets/*' } | Sort-Object -Unique
        foreach ($assetReference in $assetReferences) {
            $assetName = [System.IO.Path]::GetFileName($assetReference)
            $assetPath = Join-Path $assetsSourceDir $assetName
            if (-not (Test-Path $assetPath)) { throw "Manifest asset missing: '$assetReference' referenced by $jsonPath" }
            $assetFile = Get-Item $assetPath
            if ($assetFile.Extension.ToLowerInvariant() -notin $AllowedManifestAssetExtensions) { throw "Unsupported referenced asset extension: $assetReference" }
            if ($assetFile.Length -gt $MaxManifestAssetBytes) { throw "Referenced asset too large: $assetReference ($($assetFile.Length) bytes > $MaxManifestAssetBytes)" }
        }
        if (($json.PSObject.Properties.Name -contains 'productDetail') -and $json.productDetail.slideMedia) {
            foreach ($media in $json.productDetail.slideMedia) {
                if (($null -ne $media.mediaType) -and ([int]$media.mediaType -eq 1) -and -not (Test-ValidManifestVideoUrl -Url ([string]$media.source))) {
                    throw "Invalid slideMedia video URL '$($media.source)'. Use YouTube or Vimeo embed URLs only."
                }
            }
        }
    }
    Write-Ok 'Manifest packaging inputs passed Fabric upload constraints'
}

function Get-ReleasePlaceholders {
    $files = @(
        (Join-Path $ManifestRoot 'WorkloadManifest.xml'),
        (Join-Path $ManifestRoot 'Product.json')
    )
    if (Test-Path $ItemsRoot) {
        $files += Get-ChildItem $ItemsRoot -Recurse -Include '*.json','*.xml' | Select-Object -ExpandProperty FullName
    }
    $findings = @()
    foreach ($file in $files) {
        $content = Get-Content $file -Raw
        if ($content -match 'REPLACE-ME') { $findings += "$file contains REPLACE-ME" }
        if ($content -match [regex]::Escape($ZeroGuid)) { $findings += "$file contains the all-zero AppId GUID" }
    }
    return $findings
}

function Assert-ReleasePlaceholders {
    $findings = @(Get-ReleasePlaceholders)
    if ($findings.Count -eq 0) { return }
    $message = "Release placeholders remain:`n - $($findings -join "`n - ")"
    if ($Strict) { throw $message }
    Write-Warn "$message`n     Use -Strict for release packaging; it will fail until these are replaced."
}

function Set-WorkloadManifestValues {
    param([string]$ResolvedAppId, [string]$ResolvedFrontendUrl)
    $manifestPath = Join-Path $ManifestRoot 'WorkloadManifest.xml'
    [xml]$manifest = Get-Content $manifestPath -Raw
    $manifest.WorkloadManifestConfiguration.Workload.RemoteServiceConfiguration.CloudServiceConfiguration.AADFEApp.AppId = $ResolvedAppId
    $manifest.WorkloadManifestConfiguration.Workload.RemoteServiceConfiguration.CloudServiceConfiguration.Endpoints.ServiceEndpoint.Url = $ResolvedFrontendUrl
    if ($PSCmdlet.ShouldProcess($manifestPath, "Patch AppId=$ResolvedAppId and Frontend=$ResolvedFrontendUrl")) {
        $settings = New-Object System.Xml.XmlWriterSettings
        $settings.Indent = $true
        $settings.Encoding = New-Object System.Text.UTF8Encoding($false)
        $writer = [System.Xml.XmlWriter]::Create($manifestPath, $settings)
        try { $manifest.Save($writer) } finally { $writer.Dispose() }
    }
}

function Get-AzAccountTenantId {
    try {
        $account = az account show --subscription $SubscriptionId --output json 2>$null | ConvertFrom-Json
        return [string]$account.tenantId
    } catch {
        if ($WhatIfPreference) { Write-Warn 'Not signed in to Azure; dry run continues.'; return '00000000-0000-0000-0000-000000000000' }
        throw 'Azure CLI is not signed in. Run az login or let the login phase do it.'
    }
}

function Get-AnalyticsResourceGroup {
    try {
        $groupJson = az group show --subscription $SubscriptionId --name $ResourceGroup --output json 2>$null
        if (-not $groupJson) { return $null }
        return ($groupJson | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Assert-AnalyticsResourceGroup {
    $group = Get-AnalyticsResourceGroup
    if (-not $group) {
        throw "Resource group '$ResourceGroup' was not found in subscription '$SubscriptionId'. Refusing to create it automatically; create/choose the correct isolated analytics group before deployment."
    }
    Write-Ok "Resource group $ResourceGroup exists in $($group.location) under subscription $SubscriptionId"
    if ($group.location -ne $Location) {
        Write-Warn "Requested location is $Location, but the existing resource group is in $($group.location). Azure resources will be deployed into the existing group."
    }
    return $group
}

function Get-PowerBiScopeId {
    param([string]$ScopeValue)
    $scopeId = az ad sp show --id $PowerBiServiceAppId --query "oauth2PermissionScopes[?value=='$ScopeValue'].id | [0]" -o tsv
    if ([string]::IsNullOrWhiteSpace($scopeId)) { throw "Could not resolve Power BI delegated permission: $ScopeValue" }
    return $scopeId
}

function Test-Phase { param([string]$Phase) return ($Only -eq 'all' -or $Only -eq $Phase) }

if (Test-Phase 'validate') {
    Write-Phase '0' 'Validate prerequisites and local inputs'
    Assert-Command 'node'
    $nodeVersion = (node --version).TrimStart('v')
    if ([version]$nodeVersion -lt [version]'20.0.0') { throw "Node.js 20+ required; found $nodeVersion" }
    Write-Ok "Node.js $nodeVersion"
    if ($PSVersionTable.PSVersion.Major -lt 7) { throw "PowerShell 7+ required; found $($PSVersionTable.PSVersion)" }
    Write-Ok "PowerShell $($PSVersionTable.PSVersion)"
    Assert-Command 'npm'
    Assert-Command 'az'
    Assert-Command 'nuget' -OptionalWhenWhatIf
    if (-not (Test-Path $NuspecPath)) { throw "Missing nuspec: $NuspecPath" }
    if (-not (Test-Path $FrontendRoot)) { throw "Missing frontend: $FrontendRoot" }
    if (-not (Test-Path $BackendRoot)) { throw "Missing backend: $BackendRoot" }
    Assert-ManifestPackagingInputs -ManifestRoot $ManifestRoot -ItemsRoot $ItemsRoot
    Assert-ReleasePlaceholders
}

if (Test-Phase 'login') {
    Write-Phase '1' 'Azure login and context'
    if ($WhatIfPreference) {
        $null = Get-AzAccountTenantId
    } else {
        try { $null = az account show --output none 2>$null } catch { Invoke-External 'az' @('login') 'Azure interactive login' }
    }
    $resolvedTenant = if ($TenantId) { $TenantId } else { Get-AzAccountTenantId }
    Write-Ok "Tenant: $resolvedTenant"
    try {
        $null = Assert-AnalyticsResourceGroup
    } catch {
        throw $_
    }
}

if (Test-Phase 'entra') {
    Write-Phase '2' 'Dedicated Entra app registration'
    $resolvedTenant = if ($TenantId) { $TenantId } else { Get-AzAccountTenantId }
    $redirectUris = @(
        'http://localhost:60006/close',
        "https://app.fabric.microsoft.com/workloadSignIn/$resolvedTenant/$WorkloadId",
        "https://app.powerbi.com/workloadSignIn/$resolvedTenant/$WorkloadId",
        "https://$CustomDomain/close"
    )
    if ($WhatIfPreference) {
        $AppId = if ($AppId) { $AppId } else { '00000000-0000-0000-0000-000000000000' }
        Write-Warn "Would create/update multitenant SPA '$EntraAppName' with PKCE redirects and no client secret."
    } else {
        $existing = az ad app list --display-name $EntraAppName --query '[0]' -o json | ConvertFrom-Json
        if ($existing) {
            $AppId = [string]$existing.appId
            $objectId = [string]$existing.id
            Write-Ok "Using existing Entra app $AppId"
        } else {
            $created = az ad app create --display-name $EntraAppName --sign-in-audience AzureADMultipleOrgs --enable-id-token-issuance true --enable-access-token-issuance true -o json | ConvertFrom-Json
            $AppId = [string]$created.appId
            $objectId = [string]$created.id
            Write-Ok "Created Entra app $AppId"
        }
        $resourceAccess = @()
        foreach ($scope in $RequiredPowerBiScopes) { $resourceAccess += @{ id = (Get-PowerBiScopeId -ScopeValue $scope); type = 'Scope' } }
        $body = @{
            signInAudience = 'AzureADMultipleOrgs'
            spa = @{ redirectUris = $redirectUris }
            identifierUris = @($AppIdUri)
            requiredResourceAccess = @(@{ resourceAppId = $PowerBiServiceAppId; resourceAccess = $resourceAccess })
        } | ConvertTo-Json -Depth 10
        Invoke-External 'az' @('rest','--method','PATCH','--uri',"https://graph.microsoft.com/v1.0/applications/$objectId",'--headers','Content-Type=application/json','--body',$body) 'Patch SPA redirects and Power BI delegated permissions'
        Invoke-External 'az' @('ad','app','permission','admin-consent','--id',$AppId) 'Grant admin consent for Power BI delegated permissions'
    }
    $FrontendUrl = if ($FrontendUrl) { $FrontendUrl } else { "https://$CustomDomain" }
    Set-WorkloadManifestValues -ResolvedAppId $AppId -ResolvedFrontendUrl $FrontendUrl
}

if (Test-Phase 'infrastructure') {
    Write-Phase '3' "Azure infrastructure in $ResourceGroup"
    if ($ResourceGroup -ne '<analytics-resource-group>') { throw 'Isolation violation: this workload must deploy only to <analytics-resource-group>.' }
    $null = Assert-AnalyticsResourceGroup
    Invoke-Az @('appservice','plan','create','--name',$AppServicePlan,'--resource-group',$ResourceGroup,'--location',$Location,'--sku','B1','--is-linux') 'Ensure backend App Service plan' -SkipWhenWhatIf
    # NODE:20-lts was retired from App Service on Linux; 22-lts is the current
    # LTS the platform accepts. Check with `az webapp list-runtimes --os-type
    # linux` before changing this — an unsupported string fails at create time.
    Invoke-Az @('webapp','create','--resource-group',$ResourceGroup,'--plan',$AppServicePlan,'--name',$BackendAppName,'--runtime','NODE:22-lts') 'Ensure backend Web App' -SkipWhenWhatIf
    Invoke-Az @('webapp','identity','assign','--resource-group',$ResourceGroup,'--name',$BackendAppName) 'Enable backend managed identity' -SkipWhenWhatIf
    Invoke-Az @('staticwebapp','create','--name',$StaticWebAppName,'--resource-group',$ResourceGroup,'--location',$StaticWebAppLocation,'--sku','Standard') 'Ensure Static Web App' -SkipWhenWhatIf
    $BackendUrl = if ($BackendUrl) { $BackendUrl } else { "https://$BackendAppName.azurewebsites.net" }
    $FrontendUrl = if ($FrontendUrl) { $FrontendUrl } else { "https://$CustomDomain" }
    Write-Ok "Backend URL: $BackendUrl"
    Write-Ok "Frontend URL: $FrontendUrl"
}

if (Test-Phase 'build') {
    Write-Phase '4' 'Build backend and frontend'
    $BackendUrl = if ($BackendUrl) { $BackendUrl } else { "https://$BackendAppName.azurewebsites.net" }
    Push-Location $BackendRoot
    try {
        Invoke-External 'npm' @('install') 'Install backend dependencies' -SkipWhenWhatIf
        Invoke-External 'npm' @('run','build') 'Build backend' -SkipWhenWhatIf
    } finally { Pop-Location }
    Push-Location $FrontendRoot
    try {
        $env:VITE_API_URL = $BackendUrl
        $env:ASMDB_WORKLOAD_API = $BackendUrl
        Invoke-External 'npm' @('install') 'Install frontend dependencies' -SkipWhenWhatIf
        Invoke-External 'npm' @('run','build') "Build frontend with API URL $BackendUrl" -SkipWhenWhatIf
    } finally { Remove-Item Env:\VITE_API_URL, Env:\ASMDB_WORKLOAD_API -ErrorAction SilentlyContinue; Pop-Location }
}

if (Test-Phase 'backend') {
    Write-Phase '5' 'Deploy backend'
    $zipPath = Join-Path $BuildRoot 'backend.zip'
    if ($PSCmdlet.ShouldProcess($zipPath, 'Create backend deployment zip')) {
        if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
        Compress-Archive -Path (Join-Path $BackendRoot '*') -DestinationPath $zipPath -Force
    }
    Invoke-Az @('webapp','deploy','--resource-group',$ResourceGroup,'--name',$BackendAppName,'--src-path',$zipPath,'--type','zip') 'Deploy backend zip' -SkipWhenWhatIf
}

if (Test-Phase 'frontend') {
    Write-Phase '6' 'Deploy frontend'
    $FrontendUrl = if ($FrontendUrl) { $FrontendUrl } else { "https://$CustomDomain" }
    $frontendAppId = if ($AppId) { $AppId } else { '00000000-0000-0000-0000-000000000000' }
    Set-WorkloadManifestValues -ResolvedAppId $frontendAppId -ResolvedFrontendUrl $FrontendUrl
    $token = if ($WhatIfPreference) { '<dry-run-token>' } else { az staticwebapp secrets list --subscription $SubscriptionId --name $StaticWebAppName --resource-group $ResourceGroup --query 'properties.apiKey' -o tsv }
    if (-not $token) { throw 'Could not retrieve Static Web App deployment token.' }
    Push-Location $FrontendRoot
    # The package must be fully qualified. `npx swa` resolves to an unrelated
    # third-party package of that name on the public registry, which fails with
    # "unknown arguments" - and is a supply-chain hazard, since a short generic
    # name is exactly what gets squatted.
    try { Invoke-External 'npx' @('--yes','@azure/static-web-apps-cli','deploy','dist','--deployment-token',$token,'--env','production') 'Deploy frontend with SWA CLI' -SkipWhenWhatIf }
    finally { Pop-Location }
}

if (Test-Phase 'pack') {
    Write-Phase '7' 'Build, validate, and pack uploadable workload package'
    $packScript = Join-Path $BuildRoot 'pack.ps1'
    $packArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$packScript,'-Version',$NuGetVersion)
    if ($WhatIfPreference) {
        if ($PSCmdlet.ShouldProcess($packScript, "Run one-command package build: pwsh $($packArgs -join ' ')")) { }
    } else {
        Invoke-External 'pwsh' $packArgs 'Run one-command package build'
    }
}

Write-Host "`nDeployment script finished. Manual steps remain: upload .nupkg, enable tenant, enable capacity, grant workspace MI Key Vault Secrets User." -ForegroundColor Cyan
