param(
    [string]$Tag = 'latest',
    [switch]$SkipBuild,
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

if ($WhatIf) {
    Invoke-Az @(
        'deployment', 'group', 'what-if',
        '--resource-group', $ResourceGroup,
        '--name', $DeploymentName,
        '--template-file', $TemplateFile,
        '--parameters', "tag=$Tag", "location=$Location"
    )
    return
}

$deployment = Invoke-AzJson @(
    'deployment', 'group', 'create',
    '--resource-group', $ResourceGroup,
    '--name', $DeploymentName,
    '--template-file', $TemplateFile,
    '--parameters', "tag=$Tag", "location=$Location"
)
$outputs = $deployment.properties.outputs
$registryName = Get-OutputValue $outputs 'registryName'
$registryLoginServer = Get-OutputValue $outputs 'registryLoginServer'
$controlPlaneFqdn = Get-OutputValue $outputs 'controlPlaneFqdn'
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

Invoke-Az @(
    'containerapp', 'update',
    '--name', 'asmdb-cp',
    '--resource-group', $ResourceGroup,
    '--image', $controlPlaneImage
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

$url = "https://$controlPlaneFqdn"
Write-Host ''
Write-Host 'asmdb Cloud deployment ready'
Write-Host "Control plane URL: $url"
Write-Host "Registry:          $registryName ($registryLoginServer)"
Write-Host ''
Write-Host 'Create a database:'
Write-Host "curl -X POST '$url/api/v1/databases' -H 'Content-Type: application/json' -d '{`"name`":`"my-notes`",`"tier`":`"free`"}'"
