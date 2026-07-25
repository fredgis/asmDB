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

    # ---------------------------------------------------------------------
    # Hardening checks
    # ---------------------------------------------------------------------

    # Run 4: undo-log dedup. One slot must be captured at most once per txn, so
    # far more than UNDO_MAX (4096) writes to the same rows must still fit, and
    # ROLLBACK must restore the ORIGINAL image, not an intermediate one.
    $c4 = New-Object Collections.Generic.List[string]
    $c4.Add('INSERT 1 100 alpha original-one')
    $c4.Add('INSERT 2 200 beta original-two')
    $c4.Add('INSERT 3 300 gamma original-three')
    $c4.Add('BEGIN')
    foreach ($i in 1..1500) {
        $c4.Add("UPDATE 1 $i alpha churn-$i")
        $c4.Add("UPDATE 2 $i beta churn-$i")
        $c4.Add("UPDATE 3 $i gamma churn-$i")
    }                                    # 4500 writes over only 3 distinct slots
    $c4.Add('SELECT 1'); $c4.Add('ROLLBACK'); $c4.Add('SELECT *'); $c4.Add('COUNT'); $c4.Add('EXIT')
    $r4 = ($c4 -join "`n") | .\asmdb.exe t4
    $r4 = $r4 -join "`n"
    Check 'undo dedup: 4500 writes, no overflow' (-not ($r4 -match 'transaction too large'))
    Check 'undo dedup: in-txn value visible'     ($r4 -match 'value\s+:\s+1500')
    Check 'undo dedup: rollback -> original 1'   ($r4 -match 'alpha\s+\|\s+100\s+\|\s+original-one')
    Check 'undo dedup: rollback -> original 2'   ($r4 -match 'beta\s+\|\s+200\s+\|\s+original-two')
    Check 'undo dedup: rollback -> original 3'   ($r4 -match 'gamma\s+\|\s+300\s+\|\s+original-three')
    $after4 = ($r4 -split 'rolled back')[-1]     # only what SELECT * printed after ROLLBACK
    Check 'undo dedup: no churn value survives'  (-not ($after4 -match 'churn-'))

    # Run 5: BENCH rewrites the whole table, so it must be refused inside a txn.
    $r5 = (@(
        'INSERT 7 70 keepme survive the bench', 'BEGIN', 'BENCH 1000', 'ROLLBACK',
        'COUNT', 'SELECT 7', 'EXIT'
    ) -join "`n") | .\asmdb.exe t5
    $r5 = $r5 -join "`n"
    Check 'BENCH refused inside a txn'  ($r5 -match 'finish the transaction first')
    Check 'BENCH did not wipe the row'  ($r5 -match 'content\s+:\s+survive the bench')
    Check 'BENCH did not change count'  ($r5 -match '\[ OK \] 1 row\(s\)')

    # Run 6: a key that does not fit in 64 bits must be rejected, not wrapped.
    $r6 = (@(
        'INSERT 18446744073709551617 5 x wrapped-key', 'COUNT', 'EXIT'
    ) -join "`n") | .\asmdb.exe t6
    $r6 = $r6 -join "`n"
    Check 'u64 overflow rejected'       ($r6 -match 'syntax error')
    Check 'u64 overflow inserted nothing' ($r6 -match '\[ OK \] 0 row\(s\)')

    # Run 7: an invalid .dat must be refused, never silently reinitialized.
    function Try-Open($base) {
        $out = (@('COUNT', 'EXIT') -join "`n") | .\asmdb.exe $base 2>&1
        return @{ code = $LASTEXITCODE; text = ($out -join "`n") }
    }
    # 7a partially written header
    [IO.File]::WriteAllBytes((Join-Path $work 'part.dat'), (New-Object byte[] 100))
    $a = Try-Open 'part'
    Check 'partial header refused'      ($a.code -ne 0 -and $a.text -match 'incomplete or corrupt')
    Check 'partial header not rewritten' ((Get-Item (Join-Path $work 'part.dat')).Length -eq 100)
    # 7b non-empty file with foreign content
    [IO.File]::WriteAllBytes((Join-Path $work 'bad.dat'), ([byte[]](, 0x58 * 4096)))
    $b = Try-Open 'bad'
    Check 'bad magic refused'           ($b.code -ne 0 -and $b.text -match 'incomplete or corrupt')
    Check 'bad magic not rewritten'     ((Get-Item (Join-Path $work 'bad.dat')).Length -eq 4096)
    # 7c valid header but the slot region was cut short
    (@('INSERT 1 1 a a', 'EXIT') -join "`n") | .\asmdb.exe tr | Out-Null
    $fs = [IO.File]::Open((Join-Path $work 'tr.dat'), 'Open', 'Write'); $fs.SetLength(5000); $fs.Close()
    $c = Try-Open 'tr'
    Check 'truncated data region refused' ($c.code -ne 0 -and $c.text -match 'incomplete or corrupt')
    # 7d header from an incompatible build
    (@('INSERT 1 1 a a', 'EXIT') -join "`n") | .\asmdb.exe vr | Out-Null
    $fs = [IO.File]::Open((Join-Path $work 'vr.dat'), 'Open', 'Write')
    $fs.Seek(8, 'Begin') | Out-Null
    $fs.Write([BitConverter]::GetBytes([int]99), 0, 4)
    $fs.Close()
    $d = Try-Open 'vr'
    Check 'incompatible version refused' ($d.code -ne 0 -and $d.text -match 'incompatible database format')

    # Run 8: a truncated backup must be refused and must leave the live db intact
    # (reuses snap.bak from run 3, which r7 already restored from successfully).
    $fs = [IO.File]::Open((Join-Path $work 'snap.bak'), 'Open', 'Write'); $fs.SetLength(40000); $fs.Close()
    $r8 = (@('COUNT', 'RESTORE snap.bak', 'COUNT', 'SELECT 20', 'EXIT') -join "`n") | .\asmdb.exe r7
    $r8 = $r8 -join "`n"
    Check 'truncated backup refused'    ($r8 -match 'truncated or incompatible')
    Check 'refused restore kept 3 rows' (([regex]::Matches($r8, '\[ OK \] 3 row\(s\)')).Count -ge 2)
    Check 'refused restore kept data'   ($r8 -match 'value\s+:\s+250')
    # and the database is still usable after a restart
    $r8b = (@('COUNT', 'EXIT') -join "`n") | .\asmdb.exe r7
    $r8b = $r8b -join "`n"
    Check 'db usable after refused restore' ($r8b -match '\[ OK \] 3 row\(s\)')

    # Run 9: crash recovery. A committed-but-uncheckpointed WAL must be replayed
    # on the next open, exactly once, and a corrupt WAL must be discarded.
    $mkwal = Join-Path $root 'tests\make_wal.py'
    $py = (Get-Command python -ErrorAction SilentlyContinue)
    if ($py) {
        (@('INSERT 1 10 base original row', 'EXIT') -join "`n") | .\asmdb.exe wr | Out-Null
        & python $mkwal (Join-Path $work 'wr.wal') 42 4242 wal 'recovered from the write-ahead log' 2 | Out-Null
        $r9 = (@('COUNT', 'SELECT 42', 'EXIT') -join "`n") | .\asmdb.exe wr
        $r9 = $r9 -join "`n"
        Check 'WAL replayed on open'     ($r9 -match 'content\s+:\s+recovered from the write-ahead log')
        Check 'WAL recovery sets count'  ($r9 -match '\[ OK \] 2 row\(s\)')
        Check 'WAL cleared after replay' ((Get-Item (Join-Path $work 'wr.wal')).Length -eq 0)
        $r9b = (@('COUNT', 'EXIT') -join "`n") | .\asmdb.exe wr
        Check 'WAL replay is idempotent' (($r9b -join "`n") -match '\[ OK \] 2 row\(s\)')
        # a corrupt WAL must be discarded without touching the database
        [IO.File]::WriteAllBytes((Join-Path $work 'wr.wal'), ([byte[]](, 0x5A * 500)))
        $r9c = (@('COUNT', 'EXIT') -join "`n") | .\asmdb.exe wr
        Check 'corrupt WAL discarded'    (($r9c -join "`n") -match '\[ OK \] 2 row\(s\)')

        # recovery onto a database whose .dat does not exist yet must load the
        # replayed rows into memory, not just onto disk
        & python $mkwal (Join-Path $work 'nw.wal') 42 4242 wal 'recovered-into-memory' 1 | Out-Null
        $r9d = (@('COUNT', 'SELECT 42', 'EXIT') -join "`n") | .\asmdb.exe nw
        $r9d = $r9d -join "`n"
        Check 'WAL replay into a new .dat: count'  ($r9d -match '\[ OK \] 1 row\(s\)')
        Check 'WAL replay into a new .dat: in RAM' ($r9d -match 'content\s+:\s+recovered-into-memory')

        # a WAL entry addressing a slot outside the table must be rejected
        # wholesale rather than written at an arbitrary file offset
        $bad = [Collections.Generic.List[byte]]::new()
        $bad.AddRange([Text.Encoding]::ASCII.GetBytes('ASMWAL01'))
        $bad.AddRange([BitConverter]::GetBytes([uint64]1))          # N = 1
        $bad.AddRange([BitConverter]::GetBytes([uint64]1))          # count = 1
        $bad.AddRange([BitConverter]::GetBytes([uint64]1 -shl 55))  # slot index, way out of range
        $bad.AddRange((New-Object byte[] 256))                      # after-image
        $bad.AddRange([Text.Encoding]::ASCII.GetBytes('COMMIT01'))
        [IO.File]::WriteAllBytes((Join-Path $work 'ft.wal'), $bad.ToArray())
        $r9e = (@('COUNT', 'EXIT') -join "`n") | .\asmdb.exe ft
        $code9e = $LASTEXITCODE
        Check 'out-of-range WAL index discarded' ($code9e -eq 0 -and (($r9e -join "`n") -match '\[ OK \] 0 row\(s\)'))
        Check 'out-of-range WAL did not grow .dat' ((Get-Item (Join-Path $work 'ft.dat')).Length -eq (512 + 4194304 * 256))

        # Run 10: WAL frame checksums.
        # 10a a valid v02 frame replays
        (@('INSERT 1 10 base original row', 'EXIT') -join "`n") | .\asmdb.exe cv | Out-Null
        & python $mkwal (Join-Path $work 'cv.wal') 7 777 crc 'checksummed frame' 2 | Out-Null
        $r10 = (@('COUNT', 'SELECT 7', 'EXIT') -join "`n") | .\asmdb.exe cv
        $r10 = $r10 -join "`n"
        Check 'v02 frame replays'        ($r10 -match 'content\s+:\s+checksummed frame')
        # 10b a byte flipped inside a committed frame is detected, and the WAL is
        #     kept (not silently erased) so the operator can still act on it
        (@('INSERT 1 10 base original row', 'EXIT') -join "`n") | .\asmdb.exe cb | Out-Null
        & python $mkwal (Join-Path $work 'cb.wal') 7 777 crc 'corrupted frame' 2 --badcrc | Out-Null
        $r10b = (@('COUNT', 'EXIT') -join "`n") | .\asmdb.exe cb 2>&1
        $code10b = $LASTEXITCODE
        $r10b = $r10b -join "`n"
        Check 'bad WAL checksum refused'  ($code10b -ne 0 -and $r10b -match 'checksum mismatch')
        Check 'bad WAL checksum kept log' ((Get-Item (Join-Path $work 'cb.wal')).Length -gt 0)
        # 10c deleting the .wal is the documented remedy
        Remove-Item (Join-Path $work 'cb.wal') -Force
        $r10c = (@('COUNT', 'EXIT') -join "`n") | .\asmdb.exe cb
        Check 'db opens after removing the log' (($r10c -join "`n") -match '\[ OK \] 1 row\(s\)')
        # 10d a legacy (pre-checksum) frame still replays, so upgrading a binary
        #     never drops an already-acknowledged transaction
        (@('INSERT 1 10 base original row', 'EXIT') -join "`n") | .\asmdb.exe lg | Out-Null
        & python $mkwal (Join-Path $work 'lg.wal') 9 999 old 'legacy frame' 2 --legacy | Out-Null
        $r10d = (@('SELECT 9', 'EXIT') -join "`n") | .\asmdb.exe lg
        Check 'legacy v01 frame still replays' (($r10d -join "`n") -match 'content\s+:\s+legacy frame')

        # Run 11: fault injection - a failing durable write (ENOSPC-style) must
        # abort cleanly instead of acknowledging, and the committed WAL it leaves
        # behind must replay on the next open. This is the only way to exercise
        # io_fatal, so it builds a throwaway binary with -dFAULT_INJECT=<n>;
        # the shipping binary contains none of that code.
        $nasm = @((Get-Command nasm -ErrorAction SilentlyContinue).Source,
                  "$env:LOCALAPPDATA\bin\NASM\nasm.exe",
                  "$env:ProgramFiles\NASM\nasm.exe") | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
        if ($nasm) {
            $fi = Join-Path $work 'faulty.exe'
            Push-Location (Join-Path $root 'src')
            & $nasm -f bin '-dFAULT_INJECT=4' main.asm -o $fi 2>&1 | Out-Null
            $nasmCode = $LASTEXITCODE
            Pop-Location
            if ($nasmCode -eq 0) {
                $r11 = (@(
                    'INSERT 1 100 base first row', 'BEGIN',
                    'INSERT 2 200 txn committed but not checkpointed', 'COMMIT', 'COUNT', 'EXIT'
                ) -join "`n") | & $fi fi 2>&1
                $code11 = $LASTEXITCODE
                $r11 = $r11 -join "`n"
                Check 'failed durable write aborts'    ($code11 -ne 0)
                Check 'failed durable write says why'  ($r11 -match 'I/O failure on a durable write')
                Check 'no [ OK ] after the failure'    (-not ($r11 -match 'transaction committed'))
                Check 'commit left a WAL to recover'   ((Get-Item (Join-Path $work 'fi.wal')).Length -gt 0)
                # the engine-written frame (real CRC, written by the assembly)
                # must be accepted and replayed by a normal binary
                $r11b = (@('COUNT', 'SELECT 2', 'EXIT') -join "`n") | .\asmdb.exe fi
                $r11b = $r11b -join "`n"
                Check 'engine-written WAL replays'     ($r11b -match 'content\s+:\s+committed but not checkpointed')
                Check 'recovered count is right'       ($r11b -match '\[ OK \] 2 row\(s\)')
            } else {
                Write-Host "  [SKIP] fault-injection checks (nasm build failed)" -ForegroundColor Yellow
            }
        } else {
            Write-Host "  [SKIP] fault-injection checks (nasm not found)" -ForegroundColor Yellow
        }
    } else {
        Write-Host "  [SKIP] WAL recovery checks (python not found)" -ForegroundColor Yellow
    }
}
finally {
    Pop-Location
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}

if ($fail -gt 0) {
    # Dump raw captured output so CI reveals exactly what asmdb produced.
    function Dump($name, $txt) {
        Write-Host "`n===== RAW $name =====" -ForegroundColor Yellow
        $bytes = [Text.Encoding]::UTF8.GetBytes([string]$txt)
        Write-Host ("len={0} bytes; first-16-hex={1}" -f $bytes.Length, (($bytes | Select-Object -First 16 | ForEach-Object { $_.ToString('x2') }) -join ' '))
        Write-Host ([string]$txt)
        Write-Host "===== END $name ====="
    }
    Dump 'r1' $r1
    Dump 'r2' $r2
    Dump 'r3' $r3
    Write-Host "`n$fail check(s) failed." -ForegroundColor Red; exit 1
}
Write-Host "`nAll checks passed." -ForegroundColor Green
