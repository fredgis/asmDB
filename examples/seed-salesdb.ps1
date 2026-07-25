#requires -Version 5
<#
.SYNOPSIS
    Seed a sample SalesDB with a SalesTransactions table using asmdb.

.DESCRIPTION
    Pipes a batch of INSERT statements into asmdb.exe, wrapped in a single
    BEGIN/COMMIT transaction so the whole sample loads atomically and durably.
    The SalesTransactions "table" maps onto asmdb's memory-oriented record as:

        id      -> transaction id
        value   -> amount (whole currency units)
        tag     -> customer code (single token)
        content -> free-text description (may contain spaces)

    Produces SalesDB.dat (+ a transient SalesDB.wal) in the repository root.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\examples\seed-salesdb.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\examples\seed-salesdb.ps1 -Rebuild
#>
[CmdletBinding()]
param(
    [string]$Database = 'SalesDB',
    [string]$Table    = 'SalesTransactions',
    [switch]$Rebuild,
    [switch]$Fresh
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$exe  = Join-Path $root 'build\asmdb.exe'

if ($Rebuild -or -not (Test-Path $exe)) {
    Write-Host '>> building asmdb.exe ...' -ForegroundColor Cyan
    & powershell -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\build.ps1') | Out-Host
}
if (-not (Test-Path $exe)) { throw "asmdb.exe not found at $exe - build it first." }

Push-Location $root
try {
    if ($Fresh) {
        Remove-Item "$Database.dat", "$Database.wal" -ErrorAction SilentlyContinue
    }

    # SalesTransactions sample rows: id, amount, customer tag, description
    $sales = @(
        @{ id = 1001; amount = 1299; tag = 'Contoso';    desc = 'Contoso Ltd - annual license'   }
        @{ id = 1002; amount =  499; tag = 'Fabrikam';   desc = 'Fabrikam Inc - support renewal'  }
        @{ id = 1003; amount = 2599; tag = 'Adventure';  desc = 'Adventure Works - hardware order'}
        @{ id = 1004; amount =  149; tag = 'Northwind';  desc = 'Northwind Traders - add-on seats'}
        @{ id = 1005; amount = 3799; tag = 'Tailspin';   desc = 'Tailspin Toys - enterprise plan' }
        @{ id = 1006; amount =  899; tag = 'Wingtip';    desc = 'Wingtip Toys - training package' }
        @{ id = 1007; amount = 4599; tag = 'Litware';    desc = 'Litware Inc - platform upgrade'  }
        @{ id = 1008; amount =  249; tag = 'Proseware';  desc = 'Proseware Inc - monthly billing' }
        @{ id = 1009; amount = 1899; tag = 'Fourth';     desc = 'Fourth Coffee - regional rollout'}
        @{ id = 1010; amount =  649; tag = 'BlueYonder'; desc = 'Blue Yonder - pilot expansion'   }
    )

    # Build the command stream: one atomic transaction, then show the table.
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('BEGIN')
    foreach ($s in $sales) {
        $lines.Add("INSERT $($s.id) $($s.amount) $($s.tag) $($s.desc)")
    }
    $lines.Add('COMMIT')
    $lines.Add('TABLES')
    $lines.Add('SELECT *')
    $lines.Add('COUNT')
    $lines.Add('EXIT')

    Write-Host ">> seeding $($sales.Count) rows into table '$Table' of '$Database' ..." -ForegroundColor Cyan
    ($lines -join "`n") | & $exe $Database $Table
}
finally {
    Pop-Location
}

Write-Host ''
Write-Host ">> done. Data persisted to $(Join-Path $root ($Database + '.dat'))" -ForegroundColor Green
Write-Host ">> reopen with:  .\build\asmdb.exe $Database" -ForegroundColor DarkGray
