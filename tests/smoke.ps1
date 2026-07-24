#requires -Version 5
<#
.SYNOPSIS
    Smoke test for asmdb: CRUD, transactions and persistence.
.DESCRIPTION
    Builds asmdb (unless -NoBuild), then drives it over stdin in a temp
    directory and asserts on the output. Exits non-zero on failure.
#>
[CmdletBinding()]
param([switch]$NoBuild)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$exe  = Join-Path $root 'build\asmdb.exe'

if (-not $NoBuild -or -not (Test-Path $exe)) {
    & powershell -ExecutionPolicy Bypass -File (Join-Path $root 'build.ps1') | Out-Host
}
if (-not (Test-Path $exe)) { throw "asmdb.exe not found at $exe" }

$work = Join-Path $env:TEMP ('asmdb_smoke_' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $work | Out-Null
Copy-Item $exe (Join-Path $work 'asmdb.exe') -Force

$fail = 0
function Check($name, $cond) {
    if ($cond) { Write-Host "  [PASS] $name" -ForegroundColor Green }
    else       { Write-Host "  [FAIL] $name" -ForegroundColor Red; $script:fail++ }
}

Push-Location $work
try {
    # Run 1: autocommit + rollback + commit, memory schema (id value tag content)
    $r1 = (@(
        'INSERT 1 100 alice first note about alice',
        'BEGIN', 'INSERT 2 200 bob staged row', 'INSERT 3 300 carol staged row', 'COUNT', 'ROLLBACK', 'COUNT',
        'BEGIN', 'INSERT 2 222 bob committed content', 'UPDATE 1 999 alice revised note', 'COMMIT',
        'SELECT *', 'SELECT 1', 'FIND revised', 'COUNT', 'EXIT'
    ) -join "`n") | .\asmdb.exe t
    $r1 = $r1 -join "`n"

    Check 'insert acknowledged'        ($r1 -match '1 row inserted')
    Check 'transaction started'        ($r1 -match 'transaction started')
    Check 'rollback reverts count 3->1'($r1 -match 'rolled back')
    Check 'commit acknowledged'        ($r1 -match 'transaction committed')
    Check 'updated value persisted'    ($r1 -match 'alice\s+\|\s+999')
    Check 'committed insert present'   ($r1 -match 'bob\s+\|\s+222')
    Check 'detail view content'        ($r1 -match 'content\s+:\s+revised note')
    Check 'detail view timestamps'     ($r1 -match 'created\s+:\s+\d+ ms')
    Check 'FIND matches content'       ($r1 -match 'alice\s+\|\s+999\s+\|\s+revised note')

    # Run 2: reopen -> committed state survives, rolled-back state does not
    $r2 = (@('SELECT *', 'COUNT', 'EXIT') -join "`n") | .\asmdb.exe t
    $r2 = $r2 -join "`n"
    Check 'persistence: alice/999'     ($r2 -match 'alice\s+\|\s+999')
    Check 'persistence: bob/222'       ($r2 -match 'bob\s+\|\s+222')
    Check 'persistence: 2 rows'        ($r2 -match '\[ OK \] 2 row\(s\)')
    Check 'rolled-back carol absent'   (-not ($r2 -match 'carol'))

    # Run 3: CHECK constraint, RANGE access path, BACKUP/RESTORE (fresh db 'r7')
    $r3 = (@(
        'INSERT 10 100 xx aaa', 'INSERT 20 250 yy bbb', 'INSERT 30 500 zz ccc',
        'INSERT 0 1 bad reserved-key',
        'RANGE 100 300',
        'BACKUP snap.bak',
        'DELETE 10', 'DELETE 20', 'DELETE 30', 'COUNT',
        'RESTORE snap.bak', 'COUNT', 'EXIT'
    ) -join "`n") | .\asmdb.exe r7
    $r3 = $r3 -join "`n"
    Check 'CHECK rejects id 0'          ($r3 -match 'id must be >= 1')
    Check 'RANGE includes in-range row' ($r3 -match 'yy\s+\|\s+250')
    Check 'RANGE excludes out-of-range' (-not ($r3 -match 'zz\s+\|\s+500'))
    Check 'BACKUP acknowledged'         ($r3 -match 'backup written')
    Check 'emptied before restore'      ($r3 -match '\[ OK \] 0 row\(s\)')
    Check 'RESTORE acknowledged'        ($r3 -match 'database restored')
    Check 'RESTORE recovers 3 rows'     ($r3 -match '\[ OK \] 3 row\(s\)')
}
finally {
    Pop-Location
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}

if ($fail -gt 0) { Write-Host "`n$fail check(s) failed." -ForegroundColor Red; exit 1 }
Write-Host "`nAll checks passed." -ForegroundColor Green
