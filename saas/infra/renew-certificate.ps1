param(
    [string]$CustomDomain = '',
    [int]$RenewBeforeDays = 30,
    [switch]$Force,
    [string]$Tag = '',
    [string]$OvhAppKey = '',
    [securestring]$OvhAppSecret,
    [securestring]$OvhConsumerKey,
    [string]$OvhRegion = 'ovh-eu'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$InfraDir = Split-Path -Parent $PSCommandPath
$RepoRoot = (Resolve-Path (Join-Path $InfraDir '..\..')).Path
. (Join-Path $RepoRoot 'scripts\deploy-env.ps1')
$DeployEnv = Get-DeployEnv -Require @('ASMDB_TENANT_ID', 'ASMDB_SUBSCRIPTION_ID', 'ASMDB_RESOURCE_GROUP', 'ASMDB_CUSTOM_DOMAIN')

if (-not $CustomDomain) { $CustomDomain = $DeployEnv['ASMDB_CUSTOM_DOMAIN'] }
$TenantId = $DeployEnv['ASMDB_TENANT_ID']
$SubscriptionId = $DeployEnv['ASMDB_SUBSCRIPTION_ID']
$ResourceGroup = $DeployEnv['ASMDB_RESOURCE_GROUP']
$DeployScript = Join-Path $InfraDir 'deploy.ps1'

function Require-Command([string]$Name, [string]$InstallHint) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name was not found. $InstallHint"
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

function Get-AcmeCertificateStoreEntry([string]$Domain) {
    $store = Join-Path $env:LOCALAPPDATA 'Posh-ACME'
    if (-not (Test-Path $store)) { return $null }

    $dir = Get-ChildItem $store -Recurse -Directory -Filter $Domain -ErrorAction SilentlyContinue |
           Where-Object { (Test-Path (Join-Path $_.FullName 'fullchain.pfx')) -and (Test-Path (Join-Path $_.FullName 'order.json')) } |
           Sort-Object LastWriteTime -Descending |
           Select-Object -First 1
    if (-not $dir) { return $null }

    $order = Get-Content (Join-Path $dir.FullName 'order.json') -Raw | ConvertFrom-Json
    $password = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($order.PfxPassB64U.Replace('-', '+').Replace('_', '/')))
    $pfxPath = Join-Path $dir.FullName 'fullchain.pfx'
    $pfx = [Security.Cryptography.X509Certificates.X509Certificate2]::new(
        [IO.File]::ReadAllBytes($pfxPath),
        $password,
        [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
    )

    return [pscustomobject]@{
        Directory = $dir.FullName
        PfxPath   = $pfxPath
        Password  = $password
        Expires   = [datetime]$order.CertExpires
        NotAfter  = $pfx.NotAfter
        Thumbprint = $pfx.Thumbprint
    }
}

function Invoke-AcmeRenewal([string]$Domain) {
    Import-Module Posh-ACME -ErrorAction Stop
    Set-PAServer LE_PROD

    $hasOvhArgs = -not [string]::IsNullOrWhiteSpace($OvhAppKey) -and $null -ne $OvhAppSecret -and $null -ne $OvhConsumerKey
    if ($hasOvhArgs) {
        $pluginArgs = @{
            OVHAppKey      = $OvhAppKey
            OVHAppSecret   = $OvhAppSecret
            OVHConsumerKey = $OvhConsumerKey
            OVHRegion      = $OvhRegion
        }
        New-PACertificate -Domain $Domain -Plugin OVH -PluginArgs $pluginArgs -PfxPass (New-Guid).Guid -Force
        return
    }

    $submit = Get-Command Submit-Renewal -ErrorAction Stop
    $renewalParams = @{ PfxPass = (New-Guid).Guid }
    if ($submit.Parameters.ContainsKey('Force')) { $renewalParams['Force'] = $true }
    if ($submit.Parameters.ContainsKey('MainDomain')) {
        $renewalParams['MainDomain'] = $Domain
    }
    elseif ($submit.Parameters.ContainsKey('Domain')) {
        $renewalParams['Domain'] = $Domain
    }
    else {
        throw 'Submit-Renewal has neither -MainDomain nor -Domain; refusing to renew an unspecified order.'
    }
    Submit-Renewal @renewalParams
}

function Test-LiveCertificate([string]$Domain, [datetime]$ExpectedNotAfter) {
    $client = [Net.Sockets.TcpClient]::new()
    try {
        $client.Connect($Domain, 443)
        $ssl = [Net.Security.SslStream]::new($client.GetStream(), $false, { $true })
        try {
            $ssl.AuthenticateAsClient($Domain)
            $live = [Security.Cryptography.X509Certificates.X509Certificate2]::new($ssl.RemoteCertificate)
            if ($live.NotAfter -lt $ExpectedNotAfter.AddMinutes(-5)) {
                throw "The live certificate expires $($live.NotAfter), but the renewed certificate expires $ExpectedNotAfter."
            }
        }
        finally {
            $ssl.Dispose()
        }
    }
    finally {
        $client.Dispose()
    }
}

Require-Command 'az' 'Install Azure CLI and run az login before renewing.'
if (-not (Get-Module -ListAvailable Posh-ACME)) {
    throw 'Posh-ACME is not installed. Install-Module Posh-ACME -Scope CurrentUser, then configure the OVH order as documented in README.md.'
}
if (-not (Test-Path -LiteralPath $DeployScript)) { throw "Missing deployment script: $DeployScript" }

$account = Invoke-AzJson @('account', 'show')
if (-not $account) { throw 'Azure CLI is not logged in.' }
if ($account.tenantId -ne $TenantId) { throw "Wrong tenant '$($account.tenantId)'; expected '$TenantId'." }
if ($account.id -ne $SubscriptionId) {
    Invoke-Az @('account', 'set', '--subscription', $SubscriptionId)
    $account = Invoke-AzJson @('account', 'show')
    if ($account.id -ne $SubscriptionId -or $account.tenantId -ne $TenantId) {
        throw "Failed to select subscription '$SubscriptionId' in tenant '$TenantId'."
    }
}

$group = Invoke-AzJson @('group', 'show', '--name', $ResourceGroup)
if (-not $group) { throw "Resource group '$ResourceGroup' does not exist." }

$before = Get-AcmeCertificateStoreEntry $CustomDomain
if ($before) {
    $daysLeft = [int]($before.Expires - (Get-Date)).TotalDays
    Write-Host ("Current ACME certificate for {0} expires {1:yyyy-MM-dd} ({2} days left)." -f $CustomDomain, $before.Expires, $daysLeft)
    if ($daysLeft -gt $RenewBeforeDays -and -not $Force) {
        throw "Certificate is not within $RenewBeforeDays days of expiry. Use -Force to renew and apply anyway."
    }
}
elseif ([string]::IsNullOrWhiteSpace($OvhAppKey) -or $null -eq $OvhAppSecret -or $null -eq $OvhConsumerKey) {
    throw "No Posh-ACME certificate for $CustomDomain was found. Run once with -OvhAppKey, -OvhAppSecret, and -OvhConsumerKey, or configure the OVH order manually."
}

Invoke-AcmeRenewal $CustomDomain

$after = Get-AcmeCertificateStoreEntry $CustomDomain
if (-not $after) { throw "Renewal completed without leaving a fullchain.pfx for $CustomDomain in the Posh-ACME store." }
if ($after.NotAfter -le (Get-Date).AddDays($RenewBeforeDays)) {
    throw "Renewed certificate expires too soon: $($after.NotAfter)."
}
if ($before -and $after.Thumbprint -eq $before.Thumbprint -and -not $Force) {
    throw 'Renewal did not produce a different certificate thumbprint.'
}

$deployArgs = @('-SkipBuild', '-CustomDomain', $CustomDomain)
if (-not [string]::IsNullOrWhiteSpace($Tag)) {
    $deployArgs += @('-Tag', $Tag)
}

Write-Host 'Applying the renewed certificate through deploy.ps1. The PFX is read from the ACME store and passed through a secure parameter file, not on the command line.'
& $DeployScript @deployArgs
if ($LASTEXITCODE -ne 0) { throw "deploy.ps1 failed with exit code $LASTEXITCODE" }

Test-LiveCertificate $CustomDomain $after.NotAfter
$status = (Invoke-WebRequest "https://$CustomDomain/healthz" -UseBasicParsing).StatusCode
if ($status -ne 200) { throw "Health check returned HTTP $status." }

Write-Host ("Renewed and applied {0}; live certificate expires {1:yyyy-MM-dd}." -f $CustomDomain, $after.NotAfter) -ForegroundColor Green
