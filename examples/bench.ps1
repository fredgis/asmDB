#requires -Version 5
<#
.SYNOPSIS
    Micro-benchmark for asmdb: measures insert throughput (rows/sec).

.DESCRIPTION
    Streams a large batch of INSERT statements into asmdb.exe and times the
    end-to-end wall clock with a high-resolution Stopwatch. Two workloads are
    measured, because they stress very different paths:

      1. Autocommit  - every INSERT is written to the .dat file AND fsync'd
                       (FlushFileBuffers) on its own. This is the durable
                       "one transaction per row" number: disk-bound.

      2. Transaction - inserts are grouped into BEGIN .. COMMIT batches. Rows
                       are applied in RAM and only the commit is flushed once
                       per batch (write-ahead log + single fsync). CPU-bound.

    Process-spawn + database-open cost is measured separately (a bare EXIT run)
    and subtracted, so the reported figures reflect the engine's insert work,
    not shell overhead. Each workload is run several times; the best (fastest)
    run is reported, which is standard practice for throughput micro-benchmarks.

.PARAMETER Rows
    Total rows to insert per workload (default 20000).

.PARAMETER BatchSize
    Rows per BEGIN/COMMIT in the transaction workload (default 4000). Capped at
    4096, the engine's per-transaction undo-log limit (UNDO_MAX).

.PARAMETER Runs
    Number of timed repetitions per workload; best run wins (default 3).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\examples\bench.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\examples\bench.ps1 -Rows 40000 -Runs 5
#>
[CmdletBinding()]
param(
    [int]$Rows      = 20000,
    [int]$BatchSize = 4000,
    [int]$Runs      = 3,
    [string]$Database = 'BenchDB'
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
if ($BatchSize -lt 1)    { $BatchSize = 1 }

$dat = Join-Path $root "$Database.dat"
$wal = Join-Path $root "$Database.wal"
function Reset-Db { Remove-Item $dat, $wal -ErrorAction SilentlyContinue }

# Run asmdb once with the given stdin text; return elapsed seconds + stdout.
function Invoke-Asmdb {
    param([string]$InputText)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName               = $exe
    $psi.Arguments              = $Database
    $psi.WorkingDirectory       = $root
    $psi.RedirectStandardInput  = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true
    $psi.UseShellExecute        = $false
    $psi.CreateNoWindow         = $true

    $p  = New-Object System.Diagnostics.Process
    $p.StartInfo = $psi
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    [void]$p.Start()
    $outTask = $p.StandardOutput.ReadToEndAsync()
    $errTask = $p.StandardError.ReadToEndAsync()
    $p.StandardInput.Write($InputText)
    $p.StandardInput.Close()
    $p.WaitForExit()
    $sw.Stop()
    $out = $outTask.Result
    [void]$errTask.Result
    return [pscustomobject]@{ Seconds = $sw.Elapsed.TotalSeconds; Out = $out }
}

# Build the two command streams once (StringBuilder = fast for large N).
function Build-Autocommit {
    $sb = New-Object System.Text.StringBuilder
    for ($i = 1; $i -le $Rows; $i++) {
        [void]$sb.Append('INSERT ').Append($i).Append(' ').Append(($i * 7) % 100000).Append(' row_').Append($i).Append("`n")
    }
    [void]$sb.Append("COUNT`nEXIT`n")
    return $sb.ToString()
}
function Build-Transaction {
    $sb = New-Object System.Text.StringBuilder
    $i = 1
    while ($i -le $Rows) {
        [void]$sb.Append("BEGIN`n")
        $end = [Math]::Min($i + $BatchSize - 1, $Rows)
        for (; $i -le $end; $i++) {
            [void]$sb.Append('INSERT ').Append($i).Append(' ').Append(($i * 7) % 100000).Append(' row_').Append($i).Append("`n")
        }
        [void]$sb.Append("COMMIT`n")
    }
    [void]$sb.Append("COUNT`nEXIT`n")
    return $sb.ToString()
}

function Get-Count {
    param([string]$Out)
    $m = [regex]::Match($Out, '\[ OK \]\s+(\d+)\s+row\(s\)')
    if ($m.Success) { return [int]$m.Groups[1].Value }
    return -1
}

# Measure baseline: spawn + fresh 4 MB db open + EXIT (no inserts).
function Measure-Baseline {
    $best = [double]::MaxValue
    for ($r = 0; $r -lt $Runs; $r++) {
        Reset-Db
        $res = Invoke-Asmdb "EXIT`n"
        if ($res.Seconds -lt $best) { $best = $res.Seconds }
    }
    return $best
}

# Measure a workload: subtract baseline, keep the fastest net time.
function Measure-Workload {
    param([string]$Name, [string]$InputText, [double]$Baseline)
    $best   = [double]::MaxValue
    $rows   = -1
    for ($r = 0; $r -lt $Runs; $r++) {
        Reset-Db
        $res = Invoke-Asmdb $InputText
        $rows = Get-Count $res.Out
        if ($res.Seconds -lt $best) { $best = $res.Seconds }
    }
    $net = [Math]::Max($best - $Baseline, 0.000001)
    return [pscustomobject]@{
        Name    = $Name
        Rows    = $rows
        Total   = $best
        Net     = $net
        PerSec  = [int][Math]::Round($Rows / $net)
        UsPerOp = [Math]::Round(($net / $Rows) * 1e6, 2)
    }
}

Write-Host ("=" * 60) -ForegroundColor DarkGray
Write-Host " asmdb benchmark" -ForegroundColor Cyan
Write-Host ("   rows/workload : {0}" -f $Rows)
Write-Host ("   batch size    : {0} (transaction workload)" -f $BatchSize)
Write-Host ("   runs (best of): {0}" -f $Runs)
Write-Host ("=" * 60) -ForegroundColor DarkGray

Write-Host ">> warming up + measuring baseline (spawn + open + exit) ..." -ForegroundColor DarkGray
$baseline = Measure-Baseline
Write-Host ("   baseline: {0:N4} s" -f $baseline) -ForegroundColor DarkGray

Write-Host ">> workload 1/2: autocommit (durable, 1 fsync per row) ..." -ForegroundColor DarkGray
$auto = Measure-Workload 'Autocommit (durable per row)' (Build-Autocommit) $baseline

Write-Host ">> workload 2/2: transactions (batched, 1 fsync per commit) ..." -ForegroundColor DarkGray
$txn = Measure-Workload ("Transaction (batches of {0})" -f $BatchSize) (Build-Transaction) $baseline

Reset-Db

Write-Host ''
Write-Host (" Results  (best of {0}, {1} rows each)" -f $Runs, $Rows) -ForegroundColor Green
Write-Host ("-" * 72) -ForegroundColor DarkGray
$fmt = "{0,-30} {1,14} {2,12} {3,10}"
Write-Host ($fmt -f 'workload', 'rows/sec', 'us/op', 'net (s)') -ForegroundColor Cyan
Write-Host ("-" * 72) -ForegroundColor DarkGray
foreach ($w in @($auto, $txn)) {
    Write-Host ($fmt -f $w.Name, ("{0:N0}" -f $w.PerSec), ("{0:N2}" -f $w.UsPerOp), ("{0:N4}" -f $w.Net))
}
Write-Host ("-" * 72) -ForegroundColor DarkGray

$speedup = if ($auto.PerSec -gt 0) { [Math]::Round($txn.PerSec / $auto.PerSec, 1) } else { 0 }
Write-Host ("`n batched transactions are ~{0}x faster than per-row autocommit" -f $speedup) -ForegroundColor Green
if ($auto.Rows -ne $Rows -or $txn.Rows -ne $Rows) {
    Write-Host (" NOTE: expected {0} rows, got auto={1} txn={2}" -f $Rows, $auto.Rows, $txn.Rows) -ForegroundColor Yellow
}

# Markdown table (paste-ready for the README).
Write-Host "`n--- markdown ---" -ForegroundColor DarkGray
"| Workload | Durability | Throughput (rows/s) | Latency (us/op) |"
"|---|---|---|---|"
("| **Autocommit** (1 txn/row) | fsync **per row** | {0:N0} | {1:N2} |" -f $auto.PerSec, $auto.UsPerOp)
("| **Transaction** (batch {0}) | fsync **per commit** | {1:N0} | {2:N2} |" -f $BatchSize, $txn.PerSec, $txn.UsPerOp)
