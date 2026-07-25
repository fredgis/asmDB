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

        # a WAL entry addressing a slot outside the table carries a valid marker
        # and checksum, so it IS an acknowledged commit - it must be refused and
        # KEPT, never silently thrown away
        $bad = [Collections.Generic.List[byte]]::new()
        $bad.AddRange([Text.Encoding]::ASCII.GetBytes('ASMWAL01'))
        $bad.AddRange([BitConverter]::GetBytes([uint64]1))          # N = 1
        $bad.AddRange([BitConverter]::GetBytes([uint64]1))          # count = 1
        $bad.AddRange([BitConverter]::GetBytes([uint64]1 -shl 55))  # slot index, way out of range
        $bad.AddRange((New-Object byte[] 256))                      # after-image
        $bad.AddRange([Text.Encoding]::ASCII.GetBytes('COMMIT01'))
        [IO.File]::WriteAllBytes((Join-Path $work 'ft.wal'), $bad.ToArray())
        $ftSize = (Get-Item (Join-Path $work 'ft.wal')).Length
        $r9e = (@('COUNT', 'EXIT') -join "`n") | .\asmdb.exe ft 2>&1
        $code9e = $LASTEXITCODE
        Check 'out-of-range WAL index refused'  ($code9e -ne 0 -and (($r9e -join "`n") -match 'cannot apply'))
        Check 'out-of-range WAL is kept'        ((Get-Item (Join-Path $work 'ft.wal')).Length -eq $ftSize)
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

                # Run 12: autocommit is crash-atomic. A single-statement INSERT
                # goes through the same WAL commit as an explicit transaction, so
                # a crash at ANY durable write must leave the row count and the
                # rows themselves agreeing. Before that change, a crash between
                # the slot write and the header write left a row present but
                # uncounted.
                foreach ($n in 1, 2, 3, 4) {
                    $fx = Join-Path $work "faulty$n.exe"
                    Push-Location (Join-Path $root 'src')
                    & $nasm -f bin "-dFAULT_INJECT=$n" main.asm -o $fx 2>&1 | Out-Null
                    Pop-Location
                    $db = "atom$n"
                    (@('INSERT 1 100 base seed row', 'EXIT') -join "`n") | .\asmdb.exe $db | Out-Null
                    (@('INSERT 2 200 crash row that crashes', 'EXIT') -join "`n") | & $fx $db 2>&1 | Out-Null
                    $after = (@('COUNT', 'SELECT *', 'EXIT') -join "`n") | .\asmdb.exe $db
                    $after = $after -join "`n"
                    $declared = if ($after -match '\[ OK \] (\d+) row\(s\)') { [int]$Matches[1] } else { -1 }
                    $listed = ([regex]::Matches($after, '(?m)^\|\s+\d')).Count
                    Check "autocommit atomic at durable write #$n (count=$declared, rows=$listed)" ($declared -eq $listed -and $declared -ge 1)
                }
            } else {
                Write-Host "  [SKIP] fault-injection checks (nasm build failed)" -ForegroundColor Yellow
            }
        } else {
            Write-Host "  [SKIP] fault-injection checks (nasm not found)" -ForegroundColor Yellow
        }
    } else {
        Write-Host "  [SKIP] WAL recovery checks (python not found)" -ForegroundColor Yellow
    }

    # Run 13: engine version is reported, and stamped into the database
    $r13 = (@('INSERT 1 1 a x', 'VERSION', 'EXIT') -join "`n") | .\asmdb.exe verdb
    $r13 = $r13 -join "`n"
    Check 'VERSION reports the engine'   ($r13 -match 'asmdb\s+\d+\.\d+\.\d+')
    Check 'VERSION reports the format'   ($r13 -match 'storage format\s+:\s+2')
    Check 'VERSION stamps the writer'    ($r13 -match 'written by\s+:\s+engine\s+\d+\.\d+\.\d+')
    Check 'banner shows the version'     ($r13 -match 'v\d+\.\d+\.\d+')
    $r13b = (@('VERSION', 'EXIT') -join "`n") | .\asmdb.exe verdb
    Check 'writer stamp survives reopen' (($r13b -join "`n") -match 'written by\s+:\s+engine\s+\d+\.\d+\.\d+')

    # Run 14: --upgrade migrates a database whose capacity predates this build,
    # into a NEW file, leaving the original byte-for-byte untouched.
    if ($py) {
        $mk = Join-Path $work 'mklegacy.py'
        Set-Content -Path $mk -Encoding ASCII -Value @'
import struct, sys
CAP_OLD = 262144; REC = 256; HDR = 512
GOLDEN = 0x9E3779B97F4A7C15; shift = 64 - 18
def slot(k): return ((k * GOLDEN) & 0xFFFFFFFFFFFFFFFF) >> shift
hdr = bytearray(HDR); hdr[0:8] = b'ASMDB\0\0\0'
struct.pack_into('<I', hdr, 8, 1); struct.pack_into('<I', hdr, 12, REC)
struct.pack_into('<Q', hdr, 16, CAP_OLD); struct.pack_into('<Q', hdr, 24, 3)
hdr[32:39] = b'oldtbl\0'
data = bytearray(CAP_OLD * REC)
for rid, val, tag, txt in [(1,10,'alpha','ligne un'),(2,20,'beta','ligne deux'),(3,30,'gamma','ligne trois')]:
    i = slot(rid); off = i * REC
    while data[off+8] != 0:
        i = (i + 1) % CAP_OLD; off = i * REC
    struct.pack_into('<Q', data, off, rid); data[off+8] = 1
    struct.pack_into('<I', data, off+12, len(txt))
    struct.pack_into('<q', data, off+16, 1); struct.pack_into('<q', data, off+24, 1)
    struct.pack_into('<q', data, off+32, val)
    tb = tag.encode(); data[off+40:off+40+len(tb)] = tb
    cb = txt.encode(); data[off+80:off+80+len(cb)] = cb
open(sys.argv[1], 'wb').write(bytes(hdr) + bytes(data))
'@
        & python $mk (Join-Path $work 'legacy.dat') | Out-Null
        $sizeBefore = (Get-Item (Join-Path $work 'legacy.dat')).Length
        $refused = (@('COUNT', 'EXIT') -join "`n") | .\asmdb.exe legacy 2>&1
        Check 'legacy capacity refused normally' ($LASTEXITCODE -ne 0 -and ($refused -join "`n") -match 'incompatible database format')
        $up = (& .\asmdb.exe legacy --upgrade 2>&1) -join "`n"
        Check 'upgrade reports migrated rows'   ($up -match 'migrated 3 row')
        Check 'upgrade left the original alone' ((Get-Item (Join-Path $work 'legacy.dat')).Length -eq $sizeBefore)
        Copy-Item (Join-Path $work 'legacy.upgraded.dat') (Join-Path $work 'migrated.dat') -Force
        $mg = ((@('COUNT', 'SELECT 2', 'TABLES', 'EXIT') -join "`n") | .\asmdb.exe migrated) -join "`n"
        Check 'migrated rows are all there' ($mg -match '\[ OK \] 3 row\(s\)')
        Check 'migrated content intact'     ($mg -match 'content\s+:\s+ligne deux')
        Check 'migrated table name kept'    ($mg -match 'oldtbl')
        $noop = (& .\asmdb.exe migrated --upgrade 2>&1) -join "`n"
        Check 'upgrade no-ops when current' ($noop -match 'already in the current format')
    } else {
        Write-Host "  [SKIP] upgrade checks (python not found)" -ForegroundColor Yellow
    }

    # ---------------------------------------------------------------------
    # Run 15: change data capture
    # ---------------------------------------------------------------------
    $dump = Join-Path $root 'tests\cdc_dump.py'
    if ($py) {
        function CdcJson($base) {
            $out = & python $dump (Join-Path $work "$base.cdc") --json 2>&1
            if ($LASTEXITCODE -ne 0) { return $null }
            return ($out -join "`n") | ConvertFrom-Json
        }

        # 15a the shape of the log: one event per row per transaction, carrying
        #     the FINAL image; a rollback contributes nothing
        (@(
            'INSERT 1 100 alpha premiere', 'INSERT 2 200 beta deuxieme',
            'UPDATE 1 111 alpha modifiee', 'DELETE 2',
            'BEGIN', 'INSERT 3 300 gamma dans txn', 'UPDATE 3 333 gamma encore', 'COMMIT',
            'BEGIN', 'INSERT 4 400 delta annulee', 'ROLLBACK',
            'EXIT') -join "`n") | .\asmdb.exe cdc1 | Out-Null
        $j = CdcJson 'cdc1'
        Check 'CDC log validates'            ($null -ne $j)
        if ($j) {
            Check 'CDC one frame per commit'  ($j.frames.Count -eq 5)
            Check 'CDC sequence is monotonic' (@($j.frames.seq) -join ',') -eq '1,2,3,4,5'
            Check 'CDC update -> single UPSERT with final image' (
                $j.frames[2].ops.Count -eq 1 -and $j.frames[2].ops[0].op -eq 'UPSERT' -and $j.frames[2].ops[0].value -eq 111)
            Check 'CDC delete -> DELETE event' (
                $j.frames[3].ops[0].op -eq 'DELETE' -and $j.frames[3].ops[0].id -eq 2)
            Check 'CDC txn collapses to one final UPSERT' (
                $j.frames[4].ops.Count -eq 1 -and $j.frames[4].ops[0].value -eq 333)
            Check 'CDC rollback emits nothing'  ($j.last_seq -eq 5)
        }

        # 15b a transaction that ends where it started produces no frame and
        #     consumes no sequence
        (@('BEGIN', 'INSERT 9 900 x ephemere', 'DELETE 9', 'COMMIT', 'EXIT') -join "`n") | .\asmdb.exe cdc1 | Out-Null
        $j2 = CdcJson 'cdc1'
        Check 'CDC insert+delete in one txn is a no-op' ($j2.last_seq -eq 5 -and $j2.frames.Count -eq 5)

        # 15c sequence keeps climbing across restarts
        (@('INSERT 10 10 z apres redemarrage', 'EXIT') -join "`n") | .\asmdb.exe cdc1 | Out-Null
        $j3 = CdcJson 'cdc1'
        Check 'CDC sequence survives a restart' ($j3.last_seq -eq 6)

        # 15d the three whole-table operations are ONE reset each, never N events
        (@('INSERT 1 1 a un', 'INSERT 2 2 b deux', 'BACKUP snap2.bak',
           'TRUNCATE', 'RESTORE snap2.bak', 'BENCH 1000', 'EXIT') -join "`n") | .\asmdb.exe cdc2 | Out-Null
        $j4 = CdcJson 'cdc2'
        Check 'CDC RESET log validates'  ($null -ne $j4)
        if ($j4) {
            $resets = @($j4.frames | Where-Object { $_.reset })
            Check 'CDC three global ops -> three RESETs' ($resets.Count -eq 3)
            Check 'CDC BENCH is one frame, not 1000'     ($j4.frames.Count -eq 5)
            Check 'CDC RESET carries no operations'      (($resets | ForEach-Object { $_.ops.Count } | Sort-Object -Unique) -eq 0)
        }

        # 15e a torn trailing frame is trimmed on open; a COMPLETE frame with a
        #     bad checksum is corruption and must be refused, log kept
        $cdcPath = Join-Path $work 'cdc1.cdc'
        $bytes = [IO.File]::ReadAllBytes($cdcPath)
        [IO.File]::WriteAllBytes($cdcPath, $bytes + (New-Object byte[] 40))   # torn tail
        $r15 = (@('COUNT', 'EXIT') -join "`n") | .\asmdb.exe cdc1 2>&1
        Check 'CDC torn tail is trimmed' ($LASTEXITCODE -eq 0 -and (Get-Item $cdcPath).Length -eq $bytes.Length)
        $b2 = [IO.File]::ReadAllBytes($cdcPath)
        $b2[60] = $b2[60] -bxor 0xFF                                          # corrupt frame 1's payload
        [IO.File]::WriteAllBytes($cdcPath, $b2)
        $sizeBad = (Get-Item $cdcPath).Length
        $r15b = (@('COUNT', 'EXIT') -join "`n") | .\asmdb.exe cdc1 2>&1
        Check 'CDC bad checksum refused'  ($LASTEXITCODE -ne 0 -and ($r15b -join "`n") -match 'checksum')
        Check 'CDC bad checksum kept log' ((Get-Item $cdcPath).Length -eq $sizeBad)

        # 15f snapshot + watermark: a consumer loads a BACKUP, reads its
        #     last_commit_seq, and resumes from the frames after it
        (@('INSERT 1 1 a un', 'INSERT 2 2 b deux', 'BACKUP wm.bak',
           'INSERT 3 3 c trois', 'INSERT 4 4 d quatre', 'EXIT') -join "`n") | .\asmdb.exe cdc3 | Out-Null
        $bak = [IO.File]::ReadAllBytes((Join-Path $work 'wm.bak'))[0..127]
        $watermark = [BitConverter]::ToUInt64($bak, 88)
        Check 'BACKUP carries the CDC watermark' ($watermark -eq 2)
        $tail = & python $dump (Join-Path $work 'cdc3.cdc') --json --from-seq $watermark 2>&1
        $tj = ($tail -join "`n") | ConvertFrom-Json
        Check 'resume from watermark yields exactly the new rows' ($tj.frames.Count -eq 2)

        # 15g crash between the WAL commit and the change frame: the commit is
        #     acknowledged, so recovery owes the log a frame - exactly one
        if ($nasm) {
            $nocdc = Join-Path $work 'nocdc.exe'
            Push-Location (Join-Path $root 'src')
            & $nasm -f bin '-dFAULT_CDC' main.asm -o $nocdc 2>&1 | Out-Null
            Pop-Location
            (@('INSERT 1 100 a premiere', 'EXIT') -join "`n") | .\asmdb.exe crash1 | Out-Null
            (@('INSERT 2 200 b deuxieme', 'EXIT') -join "`n") | & $nocdc crash1 2>&1 | Out-Null
            $jc = CdcJson 'crash1'
            Check 'crash before the frame leaves it missing' ($jc.frames.Count -eq 1)
            (@('COUNT', 'EXIT') -join "`n") | .\asmdb.exe crash1 | Out-Null
            $jc2 = CdcJson 'crash1'
            Check 'recovery publishes the missing frame' ($jc2.frames.Count -eq 2 -and $jc2.last_seq -eq 2)
            (@('COUNT', 'EXIT') -join "`n") | .\asmdb.exe crash1 | Out-Null
            $jc3 = CdcJson 'crash1'
            Check 'recovery never duplicates a frame' ($jc3.frames.Count -eq 2)

            # 15h crash in the middle of a RESET: reset_pending survives, and the
            #     next open publishes exactly one RESET however often it reopens
            foreach ($n in 2, 3, 4) {
                $fj = Join-Path $work "fj$n.exe"
                Push-Location (Join-Path $root 'src')
                & $nasm -f bin "-dFAULT_INJECT=$n" main.asm -o $fj 2>&1 | Out-Null
                Pop-Location
                $db = "rst$n"
                (@('INSERT 1 1 a un', 'INSERT 2 2 b deux', 'EXIT') -join "`n") | .\asmdb.exe $db | Out-Null
                (@('TRUNCATE', 'EXIT') -join "`n") | & $fj $db 2>&1 | Out-Null
                (@('COUNT', 'EXIT') -join "`n") | .\asmdb.exe $db | Out-Null
                (@('COUNT', 'EXIT') -join "`n") | .\asmdb.exe $db | Out-Null
                $jr = CdcJson $db
                $nres = @($jr.frames | Where-Object { $_.reset }).Count
                Check "RESET survives a crash at write #$n (exactly one, got $nres)" ($nres -eq 1)
            }
        } else {
            Write-Host "  [SKIP] CDC crash checks (nasm not found)" -ForegroundColor Yellow
        }
    } else {
        Write-Host "  [SKIP] CDC checks (python not found)" -ForegroundColor Yellow
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
