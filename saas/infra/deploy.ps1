param(
    # The release tag for both images. Defaults to the engine version read from
    # src/asmdb.inc, which is what makes an upgrade detectable at all: the
    # control plane offers an upgrade when an instance's recorded image differs
    # from the current one, and a tag of 'latest' never differs from itself. It
    # also keeps the binaries on the download page and the engine running in
    # instances on the same version by construction.
    [string]$Tag = '',
    [switch]$SkipBuild,
    [switch]$SkipApim,
    [switch]$WhatIf,

    # Custom gateway hostname. Must already resolve by CNAME to the gateway
    # before it is passed: the managed certificate is only issued once that
    # record is visible from the internet. Defaults to deploy.env.
    [string]$CustomDomain = '',

    # Microsoft Entra ID objects backing the console sign-in. None of these are
    # secrets — the browser flow is authorization-code with PKCE, so there is no
    # client secret to carry. They come from deploy.env rather than from
    # literals here, so the platform can be deployed into another directory
    # without a code change and so the repository names no one environment.
    [string]$EntraTenantId = '',
    [string]$EntraClientId = '',
    [string]$EntraGroupId  = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$InfraDir = Split-Path -Parent $PSCommandPath
$RepoRoot = (Resolve-Path (Join-Path $InfraDir '..\..')).Path
. (Join-Path $RepoRoot 'scripts\deploy-env.ps1')
$DeployEnv = Get-DeployEnv -Require @(
    'ASMDB_TENANT_ID', 'ASMDB_SUBSCRIPTION_ID', 'ASMDB_RESOURCE_GROUP',
    'ASMDB_ENTRA_CLIENT_ID', 'ASMDB_ENTRA_GROUP_ID', 'ASMDB_CUSTOM_DOMAIN'
)

# An explicit parameter still wins; deploy.env only supplies what was not given.
if (-not $CustomDomain)  { $CustomDomain  = $DeployEnv['ASMDB_CUSTOM_DOMAIN'] }
if (-not $EntraTenantId) { $EntraTenantId = $DeployEnv['ASMDB_TENANT_ID'] }
if (-not $EntraClientId) { $EntraClientId = $DeployEnv['ASMDB_ENTRA_CLIENT_ID'] }
if (-not $EntraGroupId)  { $EntraGroupId  = $DeployEnv['ASMDB_ENTRA_GROUP_ID'] }

$TenantId = $DeployEnv['ASMDB_TENANT_ID']
$SubscriptionId = $DeployEnv['ASMDB_SUBSCRIPTION_ID']
$ResourceGroup = $DeployEnv['ASMDB_RESOURCE_GROUP']
$Location = if ($DeployEnv.ContainsKey('ASMDB_LOCATION') -and $DeployEnv['ASMDB_LOCATION']) { $DeployEnv['ASMDB_LOCATION'] } else { 'swedencentral' }
$DeploymentName = 'asmdb-platform'
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

function Get-CustomDomainCertificate {
    # Read straight from the ACME store on disk rather than through the
    # Posh-ACME module: this script runs under Windows PowerShell, the module is
    # installed for PowerShell 7, and Import-Module silently finds nothing there.
    # That mismatch cost one deployment that reported success while quietly
    # leaving the custom hostname unconfigured.
    if ([string]::IsNullOrWhiteSpace($CustomDomain)) { return @{ Pfx = ''; Password = '' } }

    $store = Join-Path $env:LOCALAPPDATA 'Posh-ACME'
    if (-not (Test-Path $store)) {
        Write-Host ">> no ACME store; leaving the custom hostname untouched" -ForegroundColor Yellow
        return @{ Pfx = ''; Password = '' }
    }
    $dir = Get-ChildItem $store -Recurse -Directory -Filter $CustomDomain -ErrorAction SilentlyContinue |
           Where-Object { Test-Path (Join-Path $_.FullName 'fullchain.pfx') } |
           Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $dir) {
        Write-Host ">> no certificate for $CustomDomain in the ACME store; leaving the custom hostname untouched" -ForegroundColor Yellow
        Write-Host '   issue one with the procedure in docs/SAAS.md' -ForegroundColor Yellow
        return @{ Pfx = ''; Password = '' }
    }

    $order = Get-Content (Join-Path $dir.FullName 'order.json') -Raw | ConvertFrom-Json
    $password = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($order.PfxPassB64U.Replace('-', '+').Replace('_', '/')))
    $expires = [datetime]$order.CertExpires
    $daysLeft = [int]($expires - (Get-Date)).TotalDays
    if ($daysLeft -lt 0) {
        throw "The certificate for $CustomDomain expired on $expires. Renew it before deploying - see docs/SAAS.md section 8b."
    }
    $colour = if ($daysLeft -le 21) { 'Red' } elseif ($daysLeft -le 40) { 'Yellow' } else { 'Green' }
    Write-Host (">> certificate for {0} expires {1:yyyy-MM-dd} ({2} days left)" -f $CustomDomain, $expires, $daysLeft) -ForegroundColor $colour
    if ($daysLeft -le 21) {
        Write-Host '>> RENEW SOON - procedure in docs/SAAS.md section 8b' -ForegroundColor Red
    }
    return @{
        Pfx      = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $dir.FullName 'fullchain.pfx')))
        Password = $password
    }
}

function Invoke-GroupDeployment([string]$Description, [string]$ControlPlaneImage) {
    $values = [ordered]@{
        tag           = $Tag
        location      = $Location
        deployApim    = (-not $SkipApim)
        customDomain  = $CustomDomain
    }
    $certificate = Get-CustomDomainCertificate
    if ($certificate.Pfx) {
        $values['customDomainPfx'] = $certificate.Pfx
        $values['customDomainPfxPassword'] = $certificate.Password
    }
    if (-not [string]::IsNullOrWhiteSpace($ControlPlaneImage)) {
        $values['controlPlaneImage'] = $ControlPlaneImage
    }

    # Written to a file rather than passed on the command line. The certificate
    # is several kilobytes of base64 and putting it in an argument runs into
    # both length limits and quoting, which is how one deployment failed with a
    # wall of base64 in the error message rather than anything readable.
    $shaped = [ordered]@{}
    foreach ($k in $values.Keys) { $shaped[$k] = @{ value = $values[$k] } }
    $paramFile = Join-Path ([IO.Path]::GetTempPath()) ("asmdb-params-{0}.json" -f [guid]::NewGuid().ToString('N'))
    @{
        '$schema'      = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'
        contentVersion = '1.0.0.0'
        parameters     = $shaped
    } | ConvertTo-Json -Depth 10 | Set-Content -Path $paramFile -Encoding utf8

    Write-Host ''
    Write-Host $Description
    if (-not $SkipApim) {
        Write-Host 'APIM Developer SKU creation commonly takes 30-45 minutes. Waiting with a 90-minute budget and printing progress...'
    }

    try {
        $deploymentArgs = @(
            'deployment', 'group', 'create',
            '--resource-group', $ResourceGroup,
            '--name', $DeploymentName,
            '--template-file', $TemplateFile,
            '--parameters', "@$paramFile",
            '--no-wait'
        )
        Invoke-Az $deploymentArgs
    } finally {
        # The file holds the certificate password; it does not outlive the call.
        Remove-Item $paramFile -Force -ErrorAction SilentlyContinue
    }

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

if ([string]::IsNullOrWhiteSpace($Tag)) {
    $engineHeader = Join-Path $RepoRoot 'src\asmdb.inc'
    if (-not (Test-Path $engineHeader)) { throw "Cannot read the engine version: $engineHeader not found." }
    $header = Get-Content $engineHeader -Raw
    $major = [regex]::Match($header, '%define\s+ENGINE_MAJOR\s+(\d+)').Groups[1].Value
    $minor = [regex]::Match($header, '%define\s+ENGINE_MINOR\s+(\d+)').Groups[1].Value
    $patch = [regex]::Match($header, '%define\s+ENGINE_PATCH\s+(\d+)').Groups[1].Value
    if (-not $major -or -not $minor -or -not $patch) { throw "Could not parse ENGINE_MAJOR/MINOR/PATCH from $engineHeader." }
    $Tag = "$major.$minor.$patch"
}
Write-Host ">> release tag: $Tag" -ForegroundColor Cyan

$account = Invoke-AzJson @('account', 'show')
if (-not $account) { throw "Azure CLI is not logged in. Run az login --tenant $TenantId first." }
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
    $whatIfParameters = @("tag=$Tag", "location=$Location", "deployApim=$(-not $SkipApim)", "customDomain=$CustomDomain")
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

# Read before anything is deployed. The template owns the container app, so a
# deployment replaces its environment variables wholesale and the script puts
# them back afterwards; reading the secret after that point always finds
# nothing and mints a new one. A new secret invalidates every per-instance
# introspection token derived from it, so stats would break on every existing
# database on every redeploy — silently, since nothing errors.
$existingPlatformSecret = $null
$existingApp = az containerapp show --name asmdb-cp --resource-group $ResourceGroup --output json 2>$null
if ($existingApp) {
    $parsed = $existingApp | ConvertFrom-Json
    foreach ($e in @($parsed.properties.template.containers[0].env)) {
        if ($e -and $e.PSObject.Properties.Name -contains 'name' -and $e.name -eq 'ASMDB_PLATFORM_SECRET') {
            if ($e.PSObject.Properties.Name -contains 'value') { $existingPlatformSecret = $e.value }
        }
    }
}

# Resolved before the first deployment for the same reason it is read before it:
# once the template has run the variable is gone, so a later read would mint a
# new secret. Resolving it here also lets the failure path below put it back.
$platformSecret = $existingPlatformSecret
if (-not $platformSecret) {
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $platformSecret = [Convert]::ToBase64String($bytes)
    Write-Host '>> generated a new platform secret (none was set)' -ForegroundColor Yellow
} else {
    Write-Host '>> reusing the existing platform secret'
}

# The template owns the container app, so every deployment wipes the control
# plane's environment and the script puts it back at the end. A failure in
# between — a build error, an unhealthy revision — used to leave the platform
# stripped of its public base, its Entra configuration and its platform secret:
# the site kept answering while sign-in and stats were quietly dead. Restoring
# is therefore part of the failure path, not only the success path.
function Set-ControlPlaneEnv {
    param([Parameter(Mandatory)] $Outputs, [Parameter(Mandatory)] [string] $Secret)

    Invoke-Az @(
        'containerapp', 'update',
        '--name', 'asmdb-cp',
        '--resource-group', $ResourceGroup,
        '--set-env-vars',
            "ASMDB_PUBLIC_BASE=$(Get-OutputValue $Outputs 'instancePublicBase')",
            "ASMDB_ENV_STORAGE=$(Get-OutputValue $Outputs 'instanceStorageName')",
            "ASMDB_ENTRA_TENANT_ID=$EntraTenantId",
            "ASMDB_ENTRA_CLIENT_ID=$EntraClientId",
            "ASMDB_ENTRA_GROUP_ID=$EntraGroupId",
            "ASMDB_PLATFORM_SECRET=$Secret"
    )
}

function Remove-LegacyContributorAssignment {
    $identity = Invoke-AzJson @('identity', 'show', '--name', 'asmdb-mi', '--resource-group', $ResourceGroup)
    if (-not $identity -or [string]::IsNullOrWhiteSpace($identity.principalId)) {
        throw 'Cannot inspect asmdb-mi principalId to remove the legacy Contributor assignment.'
    }

    $scope = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup"
    $assignments = @(Invoke-AzJson @(
        'role', 'assignment', 'list',
        '--assignee-object-id', $identity.principalId,
        '--role', 'Contributor',
        '--scope', $scope,
        '--query', '[].id'
    ))

    foreach ($assignmentId in $assignments) {
        Write-Host ">> removing legacy Contributor assignment $assignmentId" -ForegroundColor Yellow
        Invoke-Az @('role', 'assignment', 'delete', '--ids', $assignmentId)
    }
}

$deployment = Invoke-GroupDeployment 'Deploying infrastructure with placeholder control-plane image...' $null
$outputs = $deployment.properties.outputs
$registryName = Get-OutputValue $outputs 'registryName'
$registryLoginServer = Get-OutputValue $outputs 'registryLoginServer'
$controlPlaneImage = "$registryLoginServer/asmdb-controlplane:$Tag"

# From here on the control plane's environment has already been wiped by the
# template. Anything that throws must put it back before surfacing the error.
try {

if ($SkipBuild) {
    # The tag now comes from the engine version, so -SkipBuild can name an image
    # that was never built. Deploying it does not fail loudly: Container Apps
    # accepts the reference, the pull fails with MANIFEST_UNKNOWN, and the
    # revision sits unhealthy for ten minutes before anything says so. Check
    # first, and refuse before touching the live app.
    foreach ($repo in @('asmdb-instance', 'asmdb-controlplane')) {
        $tags = Invoke-AzJson @('acr', 'repository', 'show-tags', '--name', $registryName, '--repository', $repo)
        if ($null -eq $tags -or -not (@($tags) -contains $Tag)) {
            throw "-SkipBuild was given, but '$repo`:$Tag' is not in registry '$registryName'. Run without -SkipBuild to build it, or pass -Tag with a tag that exists."
        }
    }
    Write-Host ">> both images exist at tag $Tag" -ForegroundColor Green
}

if (-not $SkipBuild) {
    if (-not (Test-Path -LiteralPath $InstanceDockerfile)) { throw "Missing Dockerfile: $InstanceDockerfile. The sidecar image cannot be built yet." }
    if (-not (Test-Path -LiteralPath $ControlPlaneDockerfile)) { throw "Missing Dockerfile: $ControlPlaneDockerfile. The control-plane image cannot be built yet." }
    Push-Location $RepoRoot
    try {
        # Tagged twice on purpose: the version tag is what the platform pins and
        # what makes an upgrade detectable, and 'latest' is the convenience tag
        # for anyone pulling by hand.
        Invoke-Az @('acr', 'build', '--registry', $registryName, '--image', "asmdb-instance:$Tag", '--image', 'asmdb-instance:latest', '--file', 'saas\sidecar\Dockerfile', '.')
        Invoke-Az @('acr', 'build', '--registry', $registryName, '--image', "asmdb-controlplane:$Tag", '--image', 'asmdb-controlplane:latest', '--file', 'saas\controlplane\Dockerfile', '.')
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

Set-ControlPlaneEnv -Outputs $outputs -Secret $platformSecret

}
catch {
    # Best effort, and deliberately quiet about its own failures: the error being
    # reported is the one the operator needs, not whatever the recovery hit.
    if ($outputs) {
        Write-Host '>> deployment failed after the template ran; restoring the control plane environment' -ForegroundColor Yellow
        try { Set-ControlPlaneEnv -Outputs $outputs -Secret $platformSecret }
        catch { Write-Host ">> could not restore the environment: $($_.Exception.Message)" -ForegroundColor Red }
    }
    throw
}

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

Remove-LegacyContributorAssignment

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
