# Loads deployment identity from deploy.env at the repository root.
#
# Dot-source this file, then call Get-DeployEnv. It returns a hashtable and
# throws if a required key is missing, which is the point: a deployment script
# that silently falls back to a built-in subscription id will eventually create
# resources in the wrong account, and that mistake is expensive and quiet.

Set-StrictMode -Version Latest

function Get-DeployEnvPath {
    $here = Split-Path -Parent $PSCommandPath
    return (Join-Path (Resolve-Path (Join-Path $here '..')).Path 'deploy.env')
}

function Read-DeployEnvFile {
    param([Parameter(Mandatory)][string]$Path)

    $values = @{}
    foreach ($line in Get-Content -LiteralPath $Path) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
        $split = $trimmed.IndexOf('=')
        if ($split -lt 1) { continue }
        $key = $trimmed.Substring(0, $split).Trim()
        $value = $trimmed.Substring($split + 1).Trim()
        # Allow quoted values so a hostname with a stray space survives.
        if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[-1] -eq '"') -or ($value[0] -eq "'" -and $value[-1] -eq "'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        $values[$key] = $value
    }
    return $values
}

function Get-DeployEnv {
    <#
    .SYNOPSIS
    Reads deploy.env and returns its values, failing loudly when it cannot.

    .PARAMETER Require
    Keys that must be present and non-placeholder. Missing keys are reported
    together rather than one per run, because discovering them one at a time
    across a five-minute deployment is its own kind of punishment.
    #>
    param([string[]]$Require = @())

    $path = Get-DeployEnvPath
    if (-not (Test-Path -LiteralPath $path)) {
        throw @"
deploy.env was not found at $path.

Copy deploy.env.example to deploy.env and fill in your own tenant,
subscription and Entra object ids. It is gitignored on purpose: those values
identify one environment and must not travel with the repository.
"@
    }

    $values = Read-DeployEnvFile -Path $path
    $placeholder = '00000000-0000-0000-0000-000000000000'
    $missing = @()
    foreach ($key in $Require) {
        if (-not $values.ContainsKey($key) -or -not $values[$key] -or $values[$key] -eq $placeholder) {
            $missing += $key
        }
    }
    if ($missing.Count -gt 0) {
        throw "deploy.env is missing or still has placeholder values for: $($missing -join ', '). Fill them in before deploying."
    }

    return $values
}
