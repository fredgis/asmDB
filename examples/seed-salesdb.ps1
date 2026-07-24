#requires -Version 5
<#
.SYNOPSIS
    Seed a sample SalesDB with a SalesTransactions table using asmdb.

.DESCRIPTION
    Pipes a batch of INSERT statements into asmdb.exe, wrapped in a single
    BEGIN/COMMIT transaction so the whole sample loads atomically and durably.
    The SalesTransactions "table" maps onto asmdb's record shape as:

        id     -> transaction id
        value  -> amount (whole currency units)
        name   -> customer (single token, use '_' instead of spaces)

    Produces SalesDB.dat (+ a transient SalesDB.wal) in the repository root.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\examples\seed-salesdb.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\examples\seed-salesdb.ps1 -Rebuild
#>
[CmdletBinding()]
param(
    [string]$Database = 'SalesDB',
    [switch]$Rebuild,
    [switch]$Fresh
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$exe  = Join-Path $root 'build\asmdb.exe'

if ($Rebuild -or -not (Test-Path $exe)) {
    Write-Host '>> building asmdb.exe ...' -ForegroundColor Cyan
    & powershell -ExecutionPolicy Bypass -File (Join-Path $root 'build.ps1') | Out-Host
}
if (-not (Test-Path $exe)) { throw "asmdb.exe not found at $exe - build it first." }

Push-Location $root
try {
    if ($Fresh) {
        Remove-Item "$Database.dat", "$Database.wal" -ErrorAction SilentlyContinue
    }

    # SalesTransactions sample rows: id, amount, customer
    $sales = @(
        @{ id = 1001; amount = 1299; customer = 'Contoso_Ltd'      }
        @{ id = 1002; amount =  499; customer = 'Fabrikam_Inc'     }
        @{ id = 1003; amount = 2599; customer = 'Adventure_Works'  }
        @{ id = 1004; amount =  149; customer = 'Northwind_Traders'}
        @{ id = 1005; amount = 3799; customer = 'Tailspin_Toys'    }
        @{ id = 1006; amount =  899; customer = 'Wingtip_Toys'     }
        @{ id = 1007; amount = 4599; customer = 'Litware_Inc'      }
        @{ id = 1008; amount =  249; customer = 'Proseware_Inc'    }
        @{ id = 1009; amount = 1899; customer = 'Fourth_Coffee'    }
        @{ id = 1010; amount =  649; customer = 'Blue_Yonder'      }
    )

    # Build the command stream: one atomic transaction, then show the table.
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('BEGIN')
    foreach ($s in $sales) {
        $lines.Add("INSERT $($s.id) $($s.amount) $($s.customer)")
    }
    $lines.Add('COMMIT')
    $lines.Add('SELECT *')
    $lines.Add('COUNT')
    $lines.Add('EXIT')

    Write-Host ">> seeding $($sales.Count) SalesTransactions into '$Database' ..." -ForegroundColor Cyan
    ($lines -join "`n") | & $exe $Database
}
finally {
    Pop-Location
}

Write-Host ''
Write-Host ">> done. Data persisted to $(Join-Path $root ($Database + '.dat'))" -ForegroundColor Green
Write-Host ">> reopen with:  .\build\asmdb.exe $Database" -ForegroundColor DarkGray
