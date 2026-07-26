<#
.SYNOPSIS
    Release asmdb: verify, build, publish, and make the upgrade available.

.DESCRIPTION
    One command takes a version from this source tree to the live service.

    The version in src/asmdb.inc is the only input. It becomes the image tag,
    which is what the control plane compares against each instance's recorded
    image to decide whether to offer an upgrade — so the version is not a label,
    it is the mechanism. It is also what the download page serves, because the
    binaries are assembled inside the same image that serves the site.

    Nothing is published that has not passed the test suite first.

.EXAMPLE
    .\scripts\release.ps1
    Release the version currently in src/asmdb.inc.

.EXAMPLE
    .\scripts\release.ps1 -Bump patch
    Bump the patch number, then release it.

.EXAMPLE
    .\scripts\release.ps1 -WhatIf
    Show what would be released, and change nothing.
#>
[CmdletBinding()]
param(
    [ValidateSet('major', 'minor', 'patch')]
    [string]$Bump,

    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$EngineHeader = Join-Path $RepoRoot 'src\asmdb.inc'

function Write-Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }

function Get-EngineVersion {
    $header = Get-Content $EngineHeader -Raw
    [pscustomobject]@{
        Major = [int][regex]::Match($header, '%define\s+ENGINE_MAJOR\s+(\d+)').Groups[1].Value
        Minor = [int][regex]::Match($header, '%define\s+ENGINE_MINOR\s+(\d+)').Groups[1].Value
        Patch = [int][regex]::Match($header, '%define\s+ENGINE_PATCH\s+(\d+)').Groups[1].Value
    }
}

function Set-EngineVersion($major, $minor, $patch) {
    $header = Get-Content $EngineHeader -Raw
    $header = [regex]::Replace($header, '(%define\s+ENGINE_MAJOR\s+)\d+', "`${1}$major")
    $header = [regex]::Replace($header, '(%define\s+ENGINE_MINOR\s+)\d+', "`${1}$minor")
    $header = [regex]::Replace($header, '(%define\s+ENGINE_PATCH\s+)\d+', "`${1}$patch")
    Set-Content -Path $EngineHeader -Value $header -NoNewline
}

# ---------------------------------------------------------------- version ----

$version = Get-EngineVersion
if ($Bump) {
    switch ($Bump) {
        'major' { $version = [pscustomobject]@{ Major = $version.Major + 1; Minor = 0; Patch = 0 } }
        'minor' { $version = [pscustomobject]@{ Major = $version.Major; Minor = $version.Minor + 1; Patch = 0 } }
        'patch' { $version = [pscustomobject]@{ Major = $version.Major; Minor = $version.Minor; Patch = $version.Patch + 1 } }
    }
    if (-not $WhatIf) {
        Set-EngineVersion $version.Major $version.Minor $version.Patch
        Write-Host ">> bumped src/asmdb.inc to $($version.Major).$($version.Minor).$($version.Patch)" -ForegroundColor Yellow
    }
}
$tag = "$($version.Major).$($version.Minor).$($version.Patch)"

Write-Step "Releasing asmdb $tag"

# ------------------------------------------------------------------ tests ----

Write-Step 'Running the local release gate'
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $RepoRoot 'scripts\gate.ps1') | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'The local release gate failed. Nothing was published.' }

if ($WhatIf) {
    Write-Step 'What would happen'
    Write-Host "  images pushed as asmdb-instance:$tag and asmdb-controlplane:$tag (plus latest)"
    Write-Host "  ASMDB_IMAGE pinned to asmdb-instance:$tag"
    Write-Host "  /downloads serves the $tag binaries"
    Write-Host "  every database on an older tag gets an upgrade offered"
    return
}

# ---------------------------------------------------------------- publish ----

Write-Step 'Publishing'
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $RepoRoot 'saas\infra\deploy.ps1') -Tag $tag | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'Deployment failed.' }

# ----------------------------------------------------------------- verify ----

# The binary sizes are quoted by hand in the README, the website and several
# other documents, and the container build does not produce byte-identical
# output to a local one. They have drifted twice: the site advertised 42,733 B
# while the service shipped 43,013 B. The published manifest is the only
# authority, so compare the documents against it and refuse to call the release
# done while they disagree.
Write-Step 'Checking published sizes against the manifest'
$manifest = Invoke-RestMethod -Uri "https://www.asmdb.cloud/downloads/manifest.json?cb=$([guid]::NewGuid())" -TimeoutSec 60
$shipped = @{}
foreach ($b in $manifest.builds) { $shipped[$b.format] = $b.bytes }
Write-Host ("  shipped: PE64 {0} B, ELF64 {1} B" -f $shipped['PE64'], $shipped['ELF64'])

$changelogAt = (Select-String -Path (Join-Path $RepoRoot 'README.md') -Pattern '^## Changelog').LineNumber
$stale = @()
foreach ($doc in @('README.md', 'clients\README.md', 'mcp\README.md', 'docs\ENGINE.md', 'site\index.html')) {
    $path = Join-Path $RepoRoot $doc
    if (-not (Test-Path $path)) { continue }
    $n = 0
    foreach ($line in Get-Content $path) {
        $n++
        # Changelog entries record the size at the time of that release. They are
        # history and must not be rewritten to match today's build.
        if ($doc -eq 'README.md' -and $changelogAt -and $n -ge $changelogAt) { break }
        foreach ($m in [regex]::Matches($line, '\b(\d{2}),?(\d{3})\b(?=\s*(B|bytes))')) {
            $value = [int]("$($m.Groups[1].Value)$($m.Groups[2].Value)")
            if ($value -gt 30000 -and $value -lt 90000 -and $value -ne $shipped['PE64'] -and $value -ne $shipped['ELF64']) {
                $stale += "  {0}:{1} claims {2} bytes" -f $doc, $n, $value
            }
        }
    }
}
if ($stale) {
    Write-Host '>> published sizes disagree with the shipped manifest:' -ForegroundColor Red
    $stale | ForEach-Object { Write-Host $_ -ForegroundColor Red }
    throw "Documentation quotes a binary size that was not released. Fix these, then re-run."
}
Write-Host '  every quoted size matches the manifest' -ForegroundColor Green

# ----------------------------------------------------------------- report ----

Write-Step "Released $tag"
Write-Host "  binaries : /downloads/asmdb-$tag-windows-x64.exe"
Write-Host "             /downloads/asmdb-$tag-linux-x64"
Write-Host "  instances: every database still on an older image now shows an"
Write-Host "             upgrade, and takes it when its owner asks. Upgrading"
Write-Host "             restarts the instance; the engine is single-writer, so"
Write-Host "             that is a real interruption, not a rolling update."
Write-Host ''
Write-Host "  Remember to update the changelog in README.md for $tag." -ForegroundColor Yellow
