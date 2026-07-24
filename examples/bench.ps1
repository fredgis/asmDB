#requires -Version 5
<#
.SYNOPSIS
    Benchmark asmdb and compare it against SQLite on the same machine.

.DESCRIPTION
    Reports several throughput figures, each stressing a different layer:

      A. Engine (in-RAM)   - asmdb's BENCH command inserts N rows in a tight
                             loop with NO disk I/O and NO text protocol, timed
                             internally with QueryPerformanceCounter. This is
                             the raw data-structure speed (hash + record store).

      B. Durable bulk      - BENCH then checkpoints the whole table to disk and
                             fsyncs once. Rows/sec for a durable bulk load.

      C. Transaction (stdio) - INSERTs streamed over the stdin protocol in
                             BEGIN..COMMIT batches. End-to-end, protocol tax
                             included (command parsing + per-row acks).

      D. Autocommit (stdio)  - INSERTs streamed one per durable transaction
                             (fsync per row). The disk-bound worst case.

    SQLite (Python's in-process sqlite3, i.e. C API with no text protocol - a
    generous baseline) is measured for the comparable workloads via
    bench_sqlite.py, and a comparison table is printed.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\examples\bench.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\examples\bench.ps1 -Rows 100000 -NoCompare
#>
[CmdletBinding()]
param(
    [int]$Rows      = 100000,
    [int]$AutoRows  = 10000,
    [int]$BatchSize = 4000,
    [int]$Runs      = 3,
    [string]$Database = 'BenchDB',
    [switch]$NoCompare
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$exe  = Join-Path $root 'build\asmdb.exe'
if (-not (Test-Path $exe)) {
    Write-Host '>> building asmdb.exe ...' -ForegroundColor Cyan
    & powershell -ExecutionPolicy Bypass -File (Join-Path $root 'build.ps1') | Out-Host
}
if (-not (Test-Path $exe)) { throw "asmdb.exe not found at $exe - build it first." }
if ($BatchSize -gt 4096) { $BatchSize = 4096 }   # UNDO_MAX

$dat = Join-Path $root "$Database.dat"
$wal = Join-Path $root "$Database.wal"
function Reset-Db { Remove-Item $dat, $wal -ErrorAction SilentlyContinue }

function Invoke-Asmdb {
    param([string]$InputText)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exe; $psi.Arguments = $Database; $psi.WorkingDirectory = $root
    $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true; $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
    $p = New-Object System.Diagnostics.Process; $p.StartInfo = $psi
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    [void]$p.Start()
    $outTask = $p.StandardOutput.ReadToEndAsync()
    $errTask = $p.StandardError.ReadToEndAsync()
    $p.StandardInput.Write($InputText); $p.StandardInput.Close(); $p.WaitForExit()
    $sw.Stop()
    $o = $outTask.Result; [void]$errTask.Result
    return [pscustomobject]@{ Seconds = $sw.Elapsed.TotalSeconds; Out = $o }
}

function Build-Stream {
    param([int]$N, [int]$Batch)   # Batch=0 -> autocommit (no BEGIN/COMMIT)
    $sb = New-Object System.Text.StringBuilder
    if ($Batch -le 0) {
        for ($i = 1; $i -le $N; $i++) { [void]$sb.Append('INSERT ').Append($i).Append(' ').Append($i).Append(' r_').Append($i).Append("`n") }
    } else {
        $i = 1
        while ($i -le $N) {
            [void]$sb.Append("BEGIN`n")
            $end = [Math]::Min($i + $Batch - 1, $N)
            for (; $i -le $end; $i++) { [void]$sb.Append('INSERT ').Append($i).Append(' ').Append($i).Append(' r_').Append($i).Append("`n") }
            [void]$sb.Append("COMMIT`n")
        }
    }
    [void]$sb.Append("EXIT`n"); return $sb.ToString()
}

Write-Host ("=" * 66) -ForegroundColor DarkGray
Write-Host " asmdb benchmark  (rows=$Rows, best of $Runs)" -ForegroundColor Cyan
Write-Host ("=" * 66) -ForegroundColor DarkGray

# --- A/B: engine + durable bulk via BENCH ---
$engBest = 0; $ckBest = [int]::MaxValue
Write-Host ">> A/B engine + durable checkpoint (BENCH) ..." -ForegroundColor DarkGray
for ($r = 0; $r -lt $Runs; $r++) {
    Reset-Db
    $o = (Invoke-Asmdb "BENCH $Rows`nEXIT").Out
    $m1 = [regex]::Match($o, 'in-RAM insert\s+:\s+(\d+)')
    $m2 = [regex]::Match($o, 'fsync total\s+:\s+(\d+)')
    if ($m1.Success -and [int64]$m1.Groups[1].Value -gt $engBest) { $engBest = [int64]$m1.Groups[1].Value }
    if ($m2.Success -and [int]$m2.Groups[1].Value -lt $ckBest)    { $ckBest  = [int]$m2.Groups[1].Value }
}
if ($ckBest -le 0) { $ckBest = 1 }
$durBulk = [int][Math]::Round($Rows / ($ckBest / 1000.0))

# --- baseline for stdio measurements ---
$base = [double]::MaxValue
for ($r = 0; $r -lt $Runs; $r++) { Reset-Db; $s = (Invoke-Asmdb "EXIT`n").Seconds; if ($s -lt $base) { $base = $s } }

# --- C: transaction over stdio ---
Write-Host ">> C transaction over stdio ..." -ForegroundColor DarkGray
$txnStream = Build-Stream $Rows $BatchSize
$txnBest = [double]::MaxValue
for ($r = 0; $r -lt $Runs; $r++) { Reset-Db; $s = (Invoke-Asmdb $txnStream).Seconds; if ($s -lt $txnBest) { $txnBest = $s } }
$txnNet = [Math]::Max($txnBest - $base, 0.000001)
$txnRps = [int][Math]::Round($Rows / $txnNet)

# --- D: autocommit over stdio (smaller N; disk-bound) ---
Write-Host ">> D autocommit over stdio ($AutoRows rows) ..." -ForegroundColor DarkGray
Reset-Db
$autoBest = (Invoke-Asmdb (Build-Stream $AutoRows 0)).Seconds
$autoNet = [Math]::Max($autoBest - $base, 0.000001)
$autoRps = [int][Math]::Round($AutoRows / $autoNet)
Reset-Db

# --- SQLite comparison ---
$sq = $null
if (-not $NoCompare) {
    $py = Get-Command python -ErrorAction SilentlyContinue
    if ($py) {
        Write-Host ">> SQLite baseline (same machine) ..." -ForegroundColor DarkGray
        $j = & python (Join-Path $PSScriptRoot 'bench_sqlite.py') --rows $Rows --runs $Runs --auto-rows $AutoRows 2>$null
        if ($j) { $sq = $j | ConvertFrom-Json }
    } else { Write-Host "   (python not found - skipping SQLite comparison)" -ForegroundColor Yellow }
}

function Fmt($n) { '{0:N0}' -f $n }
function Ratio($a, $b) { if ($b -gt 0) { '{0:N1}x' -f ($a / $b) } else { 'n/a' } }

Write-Host ''
Write-Host " asmdb results" -ForegroundColor Green
Write-Host ("   A engine insert (in-RAM, no I/O)   : {0,14} rows/sec" -f (Fmt $engBest))
Write-Host ("   B durable bulk (checkpoint+fsync)  : {0,14} rows/sec  ({1} ms / {2} rows)" -f (Fmt $durBulk), $ckBest, $Rows)
Write-Host ("   C transaction over stdio           : {0,14} rows/sec" -f (Fmt $txnRps))
Write-Host ("   D autocommit over stdio (fsync/row): {0,14} rows/sec" -f (Fmt $autoRps))

if ($sq) {
    Write-Host ''
    Write-Host " comparison vs SQLite $($sq.sqlite_version) (same machine)" -ForegroundColor Green
    Write-Host ("-" * 78) -ForegroundColor DarkGray
    $f = "{0,-30} {1,14} {2,14} {3,10}"
    Write-Host ($f -f 'workload', 'asmdb r/s', 'sqlite r/s', 'asmdb x') -ForegroundColor Cyan
    Write-Host ("-" * 78) -ForegroundColor DarkGray
    Write-Host ($f -f 'engine insert (in-RAM, 1 txn)', (Fmt $engBest), (Fmt $sq.memory_txn_rps),    (Ratio $engBest $sq.memory_txn_rps))
    Write-Host ($f -f 'durable bulk (1 fsync)',        (Fmt $durBulk), (Fmt $sq.disk_txn_rps),      (Ratio $durBulk $sq.disk_txn_rps))
    Write-Host ($f -f 'durable per-row (fsync/row)',   (Fmt $autoRps), (Fmt $sq.disk_autocommit_rps),(Ratio $autoRps $sq.disk_autocommit_rps))
    Write-Host ("-" * 78) -ForegroundColor DarkGray

    Write-Host "`n--- markdown ---" -ForegroundColor DarkGray
    "| Workload | asmdb | SQLite $($sq.sqlite_version) | asmdb speed-up |"
    "|---|--:|--:|--:|"
    ("| **Engine insert** - in-RAM, one transaction | **$(Fmt $engBest)** rows/s | $(Fmt $sq.memory_txn_rps) rows/s | **$(Ratio $engBest $sq.memory_txn_rps)** |")
    ("| **Durable bulk load** - one fsync | **$(Fmt $durBulk)** rows/s | $(Fmt $sq.disk_txn_rps) rows/s | **$(Ratio $durBulk $sq.disk_txn_rps)** |")
    ("| **Durable per-row** - fsync per row | **$(Fmt $autoRps)** rows/s | $(Fmt $sq.disk_autocommit_rps) rows/s | **$(Ratio $autoRps $sq.disk_autocommit_rps)** |")
}
