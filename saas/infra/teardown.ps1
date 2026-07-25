param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$TenantId = '<tenant-id>'
$SubscriptionId = '<subscription-id>'
$ResourceGroup = '<service-resource-group>'

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

if (-not (Get-Command az -ErrorAction SilentlyContinue)) { throw 'Azure CLI (az) was not found on PATH.' }
$account = Invoke-AzJson @('account', 'show')
if ($account.tenantId -ne $TenantId) { throw "Wrong tenant '$($account.tenantId)'; expected '$TenantId'." }
if ($account.id -ne $SubscriptionId) { Invoke-Az @('account', 'set', '--subscription', $SubscriptionId) }

$group = Invoke-AzJson @('group', 'show', '--name', $ResourceGroup)
if (-not $group) { throw "Resource group '$ResourceGroup' does not exist." }

$apps = @(Invoke-AzJson @('containerapp', 'list', '--resource-group', $ResourceGroup, '--query', "[?name=='asmdb-cp' || starts_with(name, 'db-')].name"))
$resources = @(
    @{ Type = 'Microsoft.App/managedEnvironments'; Name = 'asmdb-env' },
    @{ Type = 'Microsoft.ManagedIdentity/userAssignedIdentities'; Name = 'asmdb-mi' },
    @{ Type = 'Microsoft.OperationalInsights/workspaces'; Name = 'asmdb-logs' }
)
$registries = @(Invoke-AzJson @('acr', 'list', '--resource-group', $ResourceGroup, '--query', "[?starts_with(name, 'asmdbacr')].name"))
$storageAccounts = @(Invoke-AzJson @('storage', 'account', 'list', '--resource-group', $ResourceGroup, '--query', "[?starts_with(name, 'asmdbst')].name"))
$identity = $null
try {
    $identity = Invoke-AzJson @('identity', 'show', '--name', 'asmdb-mi', '--resource-group', $ResourceGroup)
}
catch {
    $identity = $null
}
$roleAssignments = @()
if ($identity) {
    $roleAssignments = @(Invoke-AzJson @(
        'role', 'assignment', 'list',
        '--assignee-object-id', $identity.principalId,
        '--scope', "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup",
        '--query', "[].id"
    ))
}

Write-Host 'This will delete asmdb Cloud resources in resource group <service-resource-group>, including:'
$apps | ForEach-Object { Write-Host "  Container App: $_" }
$registries | ForEach-Object { Write-Host "  Container Registry: $_" }
$storageAccounts | ForEach-Object { Write-Host "  Storage Account: $_" }
$roleAssignments | ForEach-Object { Write-Host "  Role Assignment: $_" }
$resources | ForEach-Object { Write-Host "  $($_.Type): $($_.Name)" }
Write-Host 'The resource group itself will not be deleted.'

if (-not $Force) {
    $confirmation = Read-Host "Type 'delete asmdb' to continue"
    if ($confirmation -ne 'delete asmdb') { Write-Host 'Cancelled.'; return }
}

foreach ($appName in $apps) {
    Invoke-Az @('containerapp', 'delete', '--name', $appName, '--resource-group', $ResourceGroup, '--yes')
}
foreach ($registryName in $registries) {
    Invoke-Az @('acr', 'delete', '--name', $registryName, '--resource-group', $ResourceGroup, '--yes')
}
foreach ($storageName in $storageAccounts) {
    Invoke-Az @('storage', 'account', 'delete', '--name', $storageName, '--resource-group', $ResourceGroup, '--yes')
}
foreach ($roleAssignmentId in $roleAssignments) {
    Invoke-Az @('role', 'assignment', 'delete', '--ids', $roleAssignmentId)
}
foreach ($resource in $resources) {
    Invoke-Az @('resource', 'delete', '--resource-group', $ResourceGroup, '--resource-type', $resource.Type, '--name', $resource.Name)
}

Write-Host 'asmdb Cloud resources deleted. Resource group <service-resource-group> was left intact.'
