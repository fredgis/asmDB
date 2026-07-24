# build.ps1 - Build asmdb with NASM alone (no linker, no CRT).
#
#   .\build.ps1            # build src\main.asm -> build\asmdb.exe  (Windows PE64)
#   .\build.ps1 -Run       # build then run
#   .\build.ps1 -Linux     # cross-assemble the Linux ELF64 -> build\asmdb
#   .\build.ps1 -Poc       # build the poc\hello.asm proof-of-concept instead
#
[CmdletBinding()]
param(
    [switch]$Run,
    [switch]$Poc,
    [switch]$Linux
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

function Find-Nasm {
    $candidates = @(
        (Get-Command nasm -ErrorAction SilentlyContinue).Source,
        "$env:LOCALAPPDATA\bin\NASM\nasm.exe",
        "$env:ProgramFiles\NASM\nasm.exe",
        "${env:ProgramFiles(x86)}\NASM\nasm.exe"
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) { return $c }
    }
    throw "nasm.exe not found. Install with: winget install --id NASM.NASM -e"
}

$nasm = Find-Nasm
Write-Host "[asmdb] using nasm: $nasm"

if ($Poc) {
    $src = Join-Path $root 'poc\hello.asm'
    $out = Join-Path $root 'build\hello.exe'
} elseif ($Linux) {
    $src = Join-Path $root 'src\main.asm'
    $out = Join-Path $root 'build\asmdb'
} else {
    $src = Join-Path $root 'src\main.asm'
    $out = Join-Path $root 'build\asmdb.exe'
}

New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null

Write-Host "[asmdb] assembling $src"
# Assemble from the source directory so %include resolves bare file names.
$srcDir = Split-Path $src
$srcName = Split-Path $src -Leaf
$extra = @()
if ($Linux) { $extra += '-dLINUX' }
Push-Location $srcDir
try {
    & $nasm -f bin @extra $srcName -o $out
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}
if ($code -ne 0) { throw "nasm failed with exit code $code" }

$size = (Get-Item $out).Length
Write-Host "[asmdb] built $out ($size bytes)" -ForegroundColor Green

if ($Run) {
    if ($Linux) {
        Write-Host "[asmdb] -Run ignored for -Linux (ELF cannot execute on Windows)" -ForegroundColor Yellow
    } else {
        Write-Host "[asmdb] running $out`n"
        & $out
        Write-Host "`n[asmdb] exit code: $LASTEXITCODE"
    }
}
