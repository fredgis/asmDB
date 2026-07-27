#requires -Version 5
<#
.SYNOPSIS
    Local pre-push release gate for asmdb.
.DESCRIPTION
    Runs the checks that must pass before pushing without relying on hosted CI.
    The installed .git\hooks\pre-push hook runs the full gate.

    For emergency pushes, set ASMDB_BYPASS_GATE to a non-empty value before
    pushing. The gate prints a warning when this deliberate bypass is used.

    For fast iteration, run .\scripts\gate.ps1 -Quick. Quick mode checks parser
    validity, forbidden binaries, both engine builds, ELF validity, Go builds,
    and console syntax, but skips the smoke suite and Go vet/test. Pushes always
    run the full gate.
#>
[CmdletBinding()]
param(
    [switch]$Quick,
    [switch]$Full
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Total = [Diagnostics.Stopwatch]::StartNew()
$GoBin = 'C:\Program Files\Go\bin\go.exe'

function Write-Step([string]$Text) {
    Write-Host "`n== $Text" -ForegroundColor Cyan
}

function Format-Command([string]$FilePath, [string[]]$Arguments) {
    $parts = @($FilePath) + $Arguments
    return ($parts | ForEach-Object {
        if ($_ -match '\s') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
    }) -join ' '
}

function Invoke-GateCommand {
    param(
        [Parameter(Mandatory)] [string]$Name,
        [Parameter(Mandatory)] [string]$Repro,
        [Parameter(Mandatory)] [string]$FilePath,
        [string[]]$Arguments = @(),
        [string]$WorkingDirectory = $RepoRoot,
        [string]$RequiredOutput,
        [hashtable]$Environment = @{}
    )

    Write-Step $Name
    Write-Host "  reproduce: $Repro"
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $oldEnv = @{}
    foreach ($key in $Environment.Keys) {
        $oldEnv[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, [string]$Environment[$key], 'Process')
    }
    Push-Location $WorkingDirectory
    try {
        $output = & $FilePath @Arguments 2>&1
        $exitCode = if ($global:LASTEXITCODE -is [int]) { $global:LASTEXITCODE } else { 0 }
    } finally {
        Pop-Location
        foreach ($key in $Environment.Keys) {
            [Environment]::SetEnvironmentVariable($key, $oldEnv[$key], 'Process')
        }
    }
    $sw.Stop()

    $text = ($output | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
    if ($text) { $text | Write-Host }

    if ($exitCode -ne 0) {
        throw "$Name failed with exit code $exitCode. Re-run: $Repro"
    }
    if ($RequiredOutput -and $text -notmatch [regex]::Escape($RequiredOutput)) {
        throw "$Name did not print required text '$RequiredOutput'. Re-run: $Repro"
    }
    Write-Host ("  ok in {0:n1}s" -f $sw.Elapsed.TotalSeconds) -ForegroundColor Green
}

function Test-PowerShellSyntax {
    Write-Step 'PowerShell syntax parse'
    Write-Host '  reproduce: powershell -NoProfile -Command "[System.Management.Automation.Language.Parser]::ParseFile(...)"'
    $errors = @()
    $files = Get-ChildItem -Path $RepoRoot -Recurse -Filter '*.ps1' -File |
        Where-Object {
            $relative = $_.FullName.Substring($RepoRoot.Length + 1)
            $relative -notlike '.git\*' -and
            $relative -notlike 'build\*' -and
            $relative -notlike 'node_modules\*'
        } |
        Sort-Object FullName
    foreach ($file in $files) {
        $full = $file.FullName
        $display = $full.Substring($RepoRoot.Length + 1)
        $tokens = $null
        $parseErrors = $null
        [System.Management.Automation.Language.Parser]::ParseFile($full, [ref]$tokens, [ref]$parseErrors) | Out-Null
        foreach ($err in $parseErrors) {
            $errors += ('{0}:{1}:{2} {3}' -f $display, $err.Extent.StartLineNumber, $err.Extent.StartColumnNumber, $err.Message)
        }
    }
    if ($errors.Count -gt 0) {
        $errors | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
        throw 'PowerShell syntax parse failed. Re-run the parser command shown above.'
    }
    Write-Host ("  parsed {0} file(s)" -f @($files).Count) -ForegroundColor Green
}

function Test-NoForbiddenBinaries {
    Write-Step 'No staged or tracked compiled binaries outside build\'
    Write-Host '  reproduce: git ls-files'
    $bad = @()
    $paths = & git -C $RepoRoot ls-files
    foreach ($path in $paths) {
        $normalized = $path -replace '/', '\'
        if ($normalized -like 'build\*') { continue }
        $ext = [IO.Path]::GetExtension($normalized).ToLowerInvariant()
        if ($ext -in @('.exe', '.dll', '.so', '.a', '.o')) { $bad += $normalized }
    }
    if ($bad.Count -gt 0) {
        Write-Host '  forbidden staged/tracked binaries:' -ForegroundColor Red
        $bad | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
        throw 'Remove the compiled binary from the index/history path before pushing.'
    }
    Write-Host '  none found' -ForegroundColor Green
}

function Get-Go {
    if (Test-Path $GoBin) { return $GoBin }
    $cmd = Get-Command go -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    throw 'go.exe not found. Expected C:\Program Files\Go\bin\go.exe or go on PATH.'
}

# Which suites does this push actually need?
#
# Running every suite on every push made a documentation change cost four
# minutes, which is the fastest way to get a gate bypassed and then removed. A
# gate nobody runs protects nothing. So the scope is derived from what changed:
# the engine suites run when the engine changed, the Go suites when Go changed,
# and a push that only touches Markdown or images runs the cheap structural
# checks alone.
#
# The rule is deliberately conservative. Anything unrecognised turns everything
# on, and -Full forces the whole suite regardless.
function Get-GateScope {
    $scope = [ordered]@{ Engine = $false; Go = $false; Site = $false; Reason = '' }

    if ($Full) {
        $scope.Engine = $true; $scope.Go = $true; $scope.Site = $true
        $scope.Reason = '-Full requested'
        return $scope
    }

    $changed = @()
    $known = $false
    # git writes progress and hints to stderr, and this script runs with
    # $ErrorActionPreference = 'Stop', under which a native command's stderr
    # becomes a terminating error. That turned every detection into the "cannot
    # tell" fallback and quietly ran the full suite every time.
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        # What this push would add to the remote, plus anything uncommitted.
        # `git diff` returning nothing is a *fact* (nothing changed), not a
        # failure to determine — conflating the two made a clean tree run the
        # most expensive path instead of the cheapest.
        $upstream = git rev-parse --abbrev-ref '@{upstream}' 2>$null
        if ($LASTEXITCODE -eq 0 -and $upstream) {
            $ahead = @(git diff --name-only '@{upstream}...HEAD' 2>$null)
            if ($LASTEXITCODE -ne 0) { throw 'diff against upstream failed' }
            $changed += $ahead
        }
        $dirty = @(git diff --name-only HEAD 2>$null)
        if ($LASTEXITCODE -ne 0) { throw 'diff against HEAD failed' }
        $changed += $dirty
        $changed += @(git ls-files --others --exclude-standard 2>$null)
        $changed = @($changed | Where-Object { $_ } | Sort-Object -Unique)
        $known = $true
    } catch {
        $known = $false
    } finally {
        $ErrorActionPreference = $previousEap
    }

    if (-not $known) {
        $scope.Engine = $true; $scope.Go = $true; $scope.Site = $true
        $scope.Reason = 'could not determine what changed, so everything runs'
        return $scope
    }

    if ($changed.Count -eq 0) {
        $scope.Reason = 'nothing to push and nothing uncommitted; structural checks only'
        return $scope
    }

    foreach ($f in $changed) {
        switch -Regex ($f) {
            '^(src|tests)/'            { $scope.Engine = $true; continue }
            '^scripts/'                { $scope.Engine = $true; $scope.Go = $true; continue }
            '^saas/(controlplane|sidecar)/' { $scope.Go = $true; continue }
            '^site/'                   { $scope.Site = $true; continue }
            '^workload/'               { $scope.Site = $true; continue }
            '^(docs|mcp|clients|examples|poc)/' { continue }
            '\.(md|png|jpg|jpeg|svg|txt|json)$' { continue }
            '^\.git'                   { continue }
            default {
                # Unrecognised path: assume the worst rather than guess.
                $scope.Engine = $true; $scope.Go = $true; $scope.Site = $true
            }
        }
    }

    $parts = @()
    if ($scope.Engine) { $parts += 'engine' }
    if ($scope.Go)     { $parts += 'go' }
    if ($scope.Site)   { $parts += 'site' }
    if (-not $parts)   { $parts = @('structural checks only') }
    $scope.Reason = ("{0} file(s) changed -> {1}" -f $changed.Count, ($parts -join ' + '))
    return $scope
}

if ($env:ASMDB_BYPASS_GATE) {
    Write-Host 'ASMDB pre-push gate BYPASSED because ASMDB_BYPASS_GATE is set.' -ForegroundColor Yellow
    Write-Host 'Use only for emergencies; git --no-verify is the other explicit bypass.' -ForegroundColor Yellow
    exit 0
}

try {
    Write-Host 'asmdb local gate starting' -ForegroundColor Cyan
    if ($Quick) { Write-Host 'Quick mode: smoke suite and Go vet/test are skipped. Pushes run the full gate.' -ForegroundColor Yellow }

    $scope = Get-GateScope
    Write-Host ("Scope: {0}" -f $scope.Reason) -ForegroundColor Cyan

    # These are cheap and catch the two mistakes that actually reached a commit:
    # a broken script and a stray compiled binary. They always run.
    Test-PowerShellSyntax
    Test-NoForbiddenBinaries

    if ($scope.Engine) {
        Invoke-GateCommand `
            -Name 'Build Windows engine' `
            -Repro '.\scripts\build.ps1' `
            -FilePath 'powershell' `
            -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $RepoRoot 'scripts\build.ps1'))

        Invoke-GateCommand `
            -Name 'Build Linux engine' `
            -Repro '.\scripts\build.ps1 -Linux' `
            -FilePath 'powershell' `
            -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $RepoRoot 'scripts\build.ps1'), '-Linux')

        Invoke-GateCommand `
            -Name 'Validate Linux ELF' `
            -Repro 'python tests\validate_elf.py build\asmdb' `
            -FilePath 'python' `
            -Arguments @((Join-Path $RepoRoot 'tests\validate_elf.py'), (Join-Path $RepoRoot 'build\asmdb')) `
            -RequiredOutput 'RESULT: ALL OK'
    }

    if ($scope.Engine -and -not $Quick) {
        $gateTemp = Join-Path $RepoRoot 'build\gate-temp'
        New-Item -ItemType Directory -Force -Path $gateTemp | Out-Null
        $smokeEnv = @{
            TEMP = $gateTemp
            TMP = $gateTemp
            LOCALAPPDATA = $gateTemp
            ProgramFiles = $gateTemp
            'ProgramFiles(x86)' = $gateTemp
        }
        Invoke-GateCommand `
            -Name 'Engine smoke suite' `
            -Repro 'tests\smoke.ps1 -NoBuild' `
            -FilePath 'powershell' `
            -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $RepoRoot 'tests\smoke.ps1'), '-NoBuild') `
            -RequiredOutput 'All checks passed.' `
            -Environment $smokeEnv
    }

    if ($scope.Go) {
        $go = Get-Go
        foreach ($module in @('saas\controlplane', 'saas\sidecar')) {
            $moduleDir = Join-Path $RepoRoot $module
            $goEnv = @{}
            if ($module -eq 'saas\controlplane') {
                $goEnv = @{ ASMDB_PLATFORM_SECRET = 'local-gate-platform-secret' }
            }
            Invoke-GateCommand -Name "Go build $module" -Repro "cd $module; go build ./..." -FilePath $go -Arguments @('build', './...') -WorkingDirectory $moduleDir -Environment $goEnv
            if (-not $Quick) {
                Invoke-GateCommand -Name "Go vet $module" -Repro "cd $module; go vet ./..." -FilePath $go -Arguments @('vet', './...') -WorkingDirectory $moduleDir -Environment $goEnv
                Invoke-GateCommand -Name "Go test $module" -Repro "cd $module; go test ./..." -FilePath $go -Arguments @('test', './...') -WorkingDirectory $moduleDir -Environment $goEnv
            }
        }
    }

    if ($scope.Site) {
        Invoke-GateCommand `
            -Name 'Console JavaScript syntax' `
            -Repro 'node --check site\js\console.js' `
            -FilePath 'node' `
            -Arguments @('--check', (Join-Path $RepoRoot 'site\js\console.js'))
    }

    $Total.Stop()
    Write-Host ("`nasmdb local gate passed in {0:n1}s." -f $Total.Elapsed.TotalSeconds) -ForegroundColor Green
    exit 0
} catch {
    $Total.Stop()
    Write-Host ("`nASMDB LOCAL GATE FAILED after {0:n1}s" -f $Total.Elapsed.TotalSeconds) -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}

