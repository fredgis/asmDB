param(
    [string]$TaskName = 'asmdb Cloud certificate renewal',
    [string]$ScriptPath = (Join-Path $PSScriptRoot 'renew-certificate.ps1'),
    [string]$At = '09:00',
    [string]$PowerShellPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not (Test-Path -LiteralPath $ScriptPath)) {
    throw "Renewal script not found: $ScriptPath"
}

if ([string]::IsNullOrWhiteSpace($PowerShellPath)) {
    $pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
    if ($pwsh) {
        $PowerShellPath = $pwsh.Source
    }
    else {
        $PowerShellPath = (Get-Command powershell -ErrorAction Stop).Source
    }
}

$start = [datetime]::ParseExact($At, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture)
$action = New-ScheduledTaskAction -Execute $PowerShellPath -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`""
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At $start
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Renews and applies the asmdb Cloud Let''s Encrypt certificate when it is close to expiry.' -Force

Write-Host "Registered scheduled task '$TaskName' to run weekly on Monday at $At."
