#Requires -Version 7.0
<#
.SYNOPSIS
Builds and packages the asmDB Analytical Capabilities Fabric workload into one uploadable .nupkg.
#>
[CmdletBinding()]
param(
    [string]$Version = "1.0.0",
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
    [string]$FrontendApiUrl = "https://REPLACE-ME-backend.example.com",
    [switch]$AllowPlaceholders
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ZeroGuid = "00000000-0000-0000-0000-000000000000"
$BuildRoot = Join-Path $RepoRoot "workload\build"
$SettingsPath = Join-Path $BuildRoot "workload.settings.json"
if (-not (Test-Path $SettingsPath)) { throw "Missing workload settings: $SettingsPath. Restore workload\build\workload.settings.json." }
$Settings = Get-Content $SettingsPath -Raw | ConvertFrom-Json
$WorkloadId = [string]$Settings.workloadId
$ItemName = [string]$Settings.itemName
$ItemType = "$WorkloadId.$ItemName"
$VerifiedDomain = [string]$Settings.verifiedDomain
$ExpectedAppIdUri = ([string]$Settings.appIdUriTemplate).Replace("{WorkloadId}", $WorkloadId)
$ManifestRoot = Join-Path $RepoRoot "workload\manifest"
$FrontendRoot = Join-Path $RepoRoot "workload\frontend"
$OutDir = Join-Path $BuildRoot "out"
$StageDir = Join-Path $BuildRoot ".pack-stage"
$PackagePath = Join-Path $OutDir "$WorkloadId.$Version.nupkg"
$NuspecPath = Join-Path $BuildRoot "Workload.nuspec"
$WorkloadManifestPath = Join-Path $ManifestRoot "WorkloadManifest.xml"
$ProductPath = Join-Path $ManifestRoot "Product.json"
$ItemXmlPath = Join-Path $ManifestRoot "items\$ItemName\$($ItemName)Item.xml"
$ItemJsonPath = Join-Path $ManifestRoot "items\$ItemName\$($ItemName)Item.json"
$FrontendRoutesPath = Join-Path $FrontendRoot "src\workload-constants.ts"
$FrontendDist = Join-Path $FrontendRoot "dist"
$AllowedAssetExtensions = @(".png", ".jpg", ".jpeg")
$MaxAssetBytes = 1572864

$script:Checks = [System.Collections.Generic.List[object]]::new()
$script:Warnings = [System.Collections.Generic.List[string]]::new()

function Add-Check {
    param([string]$Name, [bool]$Passed, [string[]]$Details = @(), [string]$Fix = "")
    $script:Checks.Add([pscustomobject]@{ Name = $Name; Passed = $Passed; Details = @($Details); Fix = $Fix })
}

function Write-Checklist {
    Write-Host ""
    Write-Host "Preflight checklist" -ForegroundColor Cyan
    Write-Host "-------------------" -ForegroundColor Cyan
    foreach ($check in $script:Checks) {
        $status = if ($check.Passed) { "PASS" } else { "FAIL" }
        $color = if ($check.Passed) { "Green" } else { "Red" }
        Write-Host ("[{0}] {1}" -f $status, $check.Name) -ForegroundColor $color
        foreach ($detail in $check.Details) { Write-Host "       $detail" }
        if (-not $check.Passed -and -not [string]::IsNullOrWhiteSpace($check.Fix)) {
            Write-Host "       Fix: $($check.Fix)" -ForegroundColor Yellow
        }
    }
    foreach ($warning in $script:Warnings) { Write-Host "[WARN] $warning" -ForegroundColor Yellow }
    if (@($script:Checks | Where-Object { -not $_.Passed }).Count -eq 0) {
        Write-Host "VERDICT: PASS - package can be produced." -ForegroundColor Green
    } else {
        Write-Host "VERDICT: FAIL - no package was produced; fix every FAIL line and rerun this command." -ForegroundColor Red
    }
}

function Test-Command {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Invoke-Tool {
    param([string]$FilePath, [string[]]$ArgumentList, [string]$WorkingDirectory)
    Push-Location $WorkingDirectory
    try {
        & $FilePath @ArgumentList
        if ($LASTEXITCODE -ne 0) { throw "$FilePath $($ArgumentList -join ' ') failed with exit code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
}

function Get-JsonFieldValues {
    param($Value, [string]$Path = "$")
    $results = @()
    if ($null -eq $Value) { return $results }
    if ($Value -is [string]) { return @([pscustomobject]@{ Path = $Path; Value = $Value }) }
    if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
        $index = 0
        foreach ($item in $Value) {
            $results += Get-JsonFieldValues -Value $item -Path "$Path[$index]"
            $index++
        }
        return $results
    }
    foreach ($prop in $Value.PSObject.Properties) {
        $results += Get-JsonFieldValues -Value $prop.Value -Path "$Path.$($prop.Name)"
    }
    return $results
}

function Get-FrontendEditorPath {
    if (-not (Test-Path $FrontendRoutesPath)) { return $null }
    $content = Get-Content $FrontendRoutesPath -Raw
    $match = [regex]::Match($content, 'SYNC_HUB_EDITOR_PATH\s*=\s*["'']([^"'']+)["'']')
    if (-not $match.Success) { return $null }
    return $match.Groups[1].Value
}

function Test-HttpsUrl {
    param([string]$Url)
    $uri = $null
    return [System.Uri]::TryCreate($Url, [System.UriKind]::Absolute, [ref]$uri) -and $uri.Scheme -eq "https"
}

function Test-HostIsSubdomainOfVerifiedDomain {
    param([string]$Url)
    $uri = $null
    if (-not [System.Uri]::TryCreate($Url, [System.UriKind]::Absolute, [ref]$uri)) { return $false }
    # Not $host: that is a read-only PowerShell automatic variable and assigning
    # to it aborts the run with an error naming nothing to do with URLs.
    $hostName = $uri.Host.ToLowerInvariant()
    $domain = $VerifiedDomain.ToLowerInvariant()
    if ($hostName -eq $domain) { return $false }
    if ($hostName.EndsWith(".onmicrosoft.com")) { return $false }
    # Exactly one label beyond the verified domain. Fabric strips the first
    # label of the frontend host and requires the remainder to be a verified
    # tenant domain, so fe.workload.asmdb.cloud is rejected at upload with
    # "Frontend Uri domain workload.asmdb.cloud is not in the tenant domains
    # list" - a message that names a host nobody configured. Checking only the
    # suffix passed that, and the failure surfaced in the Fabric portal instead
    # of here.
    $remainder = $hostName -replace '^[^.]+\.', ''
    return $remainder -eq $domain
}

function Get-ManifestUrlFindings {
    $findings = @()
    $json = Get-Content $ProductPath -Raw | ConvertFrom-Json
    foreach ($field in Get-JsonFieldValues -Value $json) {
        if ($field.Value -match '^(https?://|REPLACE-ME)') {
            if (-not (Test-HttpsUrl -Url $field.Value)) {
                $findings += "$ProductPath $($field.Path) = '$($field.Value)' is not a syntactically valid https URL"
            }
        }
    }
    [xml]$xml = Get-Content $WorkloadManifestPath -Raw
    $frontendUrl = [string]$xml.WorkloadManifestConfiguration.Workload.RemoteServiceConfiguration.CloudServiceConfiguration.Endpoints.ServiceEndpoint.Url
    if (-not (Test-HttpsUrl -Url $frontendUrl)) {
        $findings += "$WorkloadManifestPath /WorkloadManifestConfiguration/Workload/.../ServiceEndpoint/Url = '$frontendUrl' is not a syntactically valid https URL"
    }
    return $findings
}

# Workload Hub requires every supportLink to answer 200-399 over HTTPS. Checking
# it here means a submission fails on this machine in seconds rather than in
# Microsoft's review days later.
function Get-SupportLinkHttpFindings {
    $findings = @()
    $json = Get-Content $ProductPath -Raw | ConvertFrom-Json
    if (-not ($json.productDetail -and $json.productDetail.supportLink)) {
        return @("$ProductPath is missing productDetail.supportLink entries.")
    }
    foreach ($prop in $json.productDetail.supportLink.PSObject.Properties) {
        $url = [string]$prop.Value.url
        $label = "$ProductPath `$.productDetail.supportLink.$($prop.Name).url"
        if ($url -match 'REPLACE-ME') {
            $findings += "$label still contains REPLACE-ME, so its HTTP status cannot be verified."
            continue
        }
        if (-not (Test-HttpsUrl -Url $url)) {
            $findings += "$label is not a valid HTTPS URL: $url"
            continue
        }
        $status = $null
        foreach ($method in @('Head', 'Get')) {
            try {
                $response = Invoke-WebRequest -Uri $url -Method $method -MaximumRedirection 5 -TimeoutSec 15 -ErrorAction Stop
                $status = [int]$response.StatusCode
                break
            } catch {
                $lastError = $_.Exception.Message
            }
        }
        if ($null -eq $status) {
            $findings += "$label did not respond over HTTPS: $url ($lastError)"
        } elseif ($status -lt 200 -or $status -gt 399) {
            $findings += "$label returned HTTP $status; Workload Hub requires 200-399."
        }
    }
    return $findings
}

function Get-PlaceholderFindings {
    $findings = @()
    [xml]$manifest = Get-Content $WorkloadManifestPath -Raw
    $appId = [string]$manifest.WorkloadManifestConfiguration.Workload.RemoteServiceConfiguration.CloudServiceConfiguration.AADFEApp.AppId
    if ($appId -eq $ZeroGuid) { $findings += "$WorkloadManifestPath field AADFEApp/AppId is the all-zero GUID; replace it with the dedicated Entra app id." }
    $frontendUrl = [string]$manifest.WorkloadManifestConfiguration.Workload.RemoteServiceConfiguration.CloudServiceConfiguration.Endpoints.ServiceEndpoint.Url
    if ($frontendUrl -match 'REPLACE-ME') { $findings += "$WorkloadManifestPath field ServiceEndpoint/Url contains REPLACE-ME; replace it with the verified custom-domain frontend URL." }
    $json = Get-Content $ProductPath -Raw | ConvertFrom-Json
    foreach ($field in Get-JsonFieldValues -Value $json) {
        if ($field.Value -match 'REPLACE-ME') {
            $findings += "$ProductPath field $($field.Path) contains REPLACE-ME; replace it with the real marketplace URL."
        }
    }
    return $findings
}

function Get-WorkloadIdFindings {
    $files = @($WorkloadManifestPath, $ItemXmlPath, $NuspecPath, (Join-Path $BuildRoot "deploy.ps1"), (Join-Path $BuildRoot "pack.ps1"))
    $frontendFiles = Get-ChildItem (Join-Path $FrontendRoot "src") -Recurse -File -Include "*.ts","*.tsx" | Select-Object -ExpandProperty FullName
    $files += $frontendFiles
    $found = @()
    foreach ($file in $files) {
        if (-not (Test-Path $file)) { continue }
        $content = Get-Content $file -Raw
        foreach ($match in [regex]::Matches($content, 'Org\.[A-Za-z0-9_.-]+')) {
            $found += [pscustomobject]@{ File = $file; Value = $match.Value }
        }
    }
    $bad = $found | Where-Object { $_.Value -ne $WorkloadId -and $_.Value -ne "$WorkloadId.SyncHub" }
    return @($bad | ForEach-Object { "$($_.File) contains workload id '$($_.Value)' but expected '$WorkloadId'." })
}

function Get-AssetFindings {
    $findings = @()
    $assetsDir = Join-Path $ManifestRoot "assets"
    if (-not (Test-Path $assetsDir)) { return @("Missing manifest assets directory: $assetsDir.") }
    foreach ($asset in Get-ChildItem $assetsDir -File) {
        if ($asset.Extension.ToLowerInvariant() -notin $AllowedAssetExtensions) {
            $findings += "$($asset.FullName) uses extension '$($asset.Extension)'; allowed extensions are .png, .jpg, .jpeg."
        }
        if ($asset.Length -gt $MaxAssetBytes) {
            $findings += "$($asset.FullName) is $($asset.Length) bytes; maximum is $MaxAssetBytes bytes."
        }
    }
    $jsonFiles = @($ProductPath, $ItemJsonPath)
    foreach ($jsonFile in $jsonFiles) {
        $json = Get-Content $jsonFile -Raw | ConvertFrom-Json
        foreach ($field in Get-JsonFieldValues -Value $json) {
            if ($field.Value -like 'assets/*') {
                $assetPath = Join-Path $assetsDir ([System.IO.Path]::GetFileName($field.Value))
                if (-not (Test-Path $assetPath)) {
                    $findings += "$jsonFile field $($field.Path) references missing asset '$($field.Value)'."
                }
            }
        }
    }
    return $findings
}

function Get-VideoFindings {
    $findings = @()
    $json = Get-Content $ProductPath -Raw | ConvertFrom-Json
    if ($json.productDetail -and $json.productDetail.slideMedia) {
        $index = 0
        foreach ($media in $json.productDetail.slideMedia) {
            if (($null -ne $media.mediaType) -and ([int]$media.mediaType -eq 1)) {
                $source = [string]$media.source
                if (-not ($source -match '^https://(www\.)?youtube\.com/embed/[^/?#]+' -or $source -match '^https://player\.vimeo\.com/video/\d+')) {
                    $findings += "$ProductPath field $.productDetail.slideMedia[$index].source must be a YouTube or Vimeo embed URL."
                }
            }
            $index++
        }
    }
    return $findings
}

function Add-PreBuildChecks {
    Add-Check "Node.js 20+ is installed" (Test-Command "node" -and [version]((node --version).TrimStart("v")) -ge [version]"20.0.0") @("Install from https://nodejs.org/ if this fails.") "Install Node.js 20+ and rerun."
    Add-Check "npm is installed" (Test-Command "npm") @("npm is installed with Node.js.") "Install Node.js 20+ from https://nodejs.org/."
    Add-Check "PowerShell/.NET packaging runtime is available" ([type]::GetType("System.IO.Compression.ZipFile, System.IO.Compression.ZipFile") -ne $null) @("PowerShell 7 supplies the .NET compression APIs used to create the .nupkg.") "Install PowerShell 7+ from https://learn.microsoft.com/powershell/."
    Add-Check "Frontend project exists" (Test-Path (Join-Path $FrontendRoot "package.json")) @($FrontendRoot) "Restore the workload frontend folder before packaging."
    Add-Check "Manifest parts exist" ((Test-Path $WorkloadManifestPath) -and (Test-Path $ProductPath) -and (Test-Path $ItemXmlPath) -and (Test-Path $ItemJsonPath) -and (Test-Path $NuspecPath)) @("Expected WorkloadManifest.xml, Product.json, $ItemName item manifests, workload.settings.json, and Workload.nuspec.") "Restore missing files under workload\manifest and workload\build."
}

function Add-PostBuildChecks {
    [xml]$workloadManifest = Get-Content $WorkloadManifestPath -Raw
    [xml]$itemManifest = Get-Content $ItemXmlPath -Raw
    [xml]$nuspec = Get-Content $NuspecPath -Raw
    $product = Get-Content $ProductPath -Raw | ConvertFrom-Json
    $item = Get-Content $ItemJsonPath -Raw | ConvertFrom-Json

    $placeholderFindings = @(Get-PlaceholderFindings)
    if ($AllowPlaceholders) {
        Add-Check "Placeholder values are visible" $true $placeholderFindings
        if ($placeholderFindings.Count -gt 0) { $script:Warnings.Add("Placeholders remain because -AllowPlaceholders was used; do not upload this package to marketplace.") }
    } else {
        Add-Check "No placeholder values remain" ($placeholderFindings.Count -eq 0) $placeholderFindings "Replace every listed value; use -AllowPlaceholders only for local packaging tests."
    }

    $workloadFindings = @(Get-WorkloadIdFindings)
    Add-Check "Workload id is identical everywhere" ($workloadFindings.Count -eq 0) $workloadFindings "Change workload\build\workload.settings.json once, then update every listed manifest/frontend occurrence to match '$WorkloadId'."

    $manifestEditorPath = [string]$item.editor.path
    $frontendEditorPath = Get-FrontendEditorPath
    # Distinguish "the constants file moved" from "the two values differ": the
    # first check ever written here read a file the frontend had renamed, so it
    # compared against an empty string and blamed the wrong side.
    $editorDetail = if (-not (Test-Path $FrontendRoutesPath)) {
        @("Expected the frontend constants at $FrontendRoutesPath; the file is not there.")
    } elseif (-not $frontendEditorPath) {
        @("$FrontendRoutesPath exists but declares no SYNC_HUB_EDITOR_PATH.")
    } else {
        @("Manifest editor.path = '$manifestEditorPath'; frontend SYNC_HUB_EDITOR_PATH = '$frontendEditorPath'.")
    }
    Add-Check "Item editor path matches frontend route" ($frontendEditorPath -and $manifestEditorPath -eq $frontendEditorPath) $editorDetail "Update workload\manifest\items\$ItemName\$($ItemName)Item.json or $FrontendRoutesPath so both are identical. Fabric navigates the iframe to this path; a mismatch renders a blank panel with nothing in the console."

    $distFiles = if (Test-Path $FrontendDist) { @(Get-ChildItem $FrontendDist -Recurse -File) } else { @() }
    Add-Check "Frontend production build output exists and is non-empty" ($distFiles.Count -gt 0) @("Expected files under $FrontendDist; found $($distFiles.Count).") "Run npm install and npm run build in workload\frontend, or rerun this pack script after fixing frontend build errors."

    $manifestVersion = [string]$workloadManifest.WorkloadManifestConfiguration.Workload.Version
    $packageVersion = [string]$nuspec.package.metadata.version
    Add-Check "Package version is consistent" ($manifestVersion -eq $Version -and $packageVersion -eq $Version) @("pack.ps1 -Version = '$Version'; WorkloadManifest.xml Version = '$manifestVersion'; nuspec version = '$packageVersion'.") "Set WorkloadManifest.xml <Version> and Workload.nuspec metadata/version to the release version, or pass the matching -Version."

    Add-Check "Product and item manifest JSON parse" ($null -ne $product -and $null -ne $item) @("Product.json and SyncHubItem.json parsed successfully.") "Fix JSON syntax in the listed manifest file."

    $urlFindings = @(Get-ManifestUrlFindings)
    Add-Check "Manifest URLs are syntactically valid https URLs" ($urlFindings.Count -eq 0) $urlFindings "Use absolute https:// URLs in Product.json and WorkloadManifest.xml."

    # Support links are a Workload Hub submission requirement, not a build
    # requirement. Under -AllowPlaceholders the run is a development build, so
    # report them but let the package be produced; a release build must not.
    $supportLinkFindings = @(Get-SupportLinkHttpFindings)
    if ($supportLinkFindings.Count -gt 0 -and $AllowPlaceholders) {
        $script:Warnings.Add("Support links are not publishable yet; this package is for development only.")
        foreach ($finding in $supportLinkFindings) { $script:Warnings.Add("  $finding") }
    } else {
        Add-Check "Marketplace support links return HTTP 200-399 over HTTPS" ($supportLinkFindings.Count -eq 0) $supportLinkFindings "Publish the documentation, certification/attestation, help, privacy, terms and license pages, then update Product.json supportLink URLs. Note that github.com URLs in a PRIVATE repository return 404 to anonymous callers, including Microsoft's reviewers - the repository must be public or the pages must be hosted elsewhere."
    }

    $frontendUrl = [string]$workloadManifest.WorkloadManifestConfiguration.Workload.RemoteServiceConfiguration.CloudServiceConfiguration.Endpoints.ServiceEndpoint.Url
    Add-Check "Frontend URL is a subdomain of the verified Entra domain" (Test-HostIsSubdomainOfVerifiedDomain -Url $frontendUrl) @("Frontend URL = '$frontendUrl'; verified domain = '$VerifiedDomain'. Default Azure hostnames and *.onmicrosoft.com do not satisfy Fabric publishing requirements.") "Set WorkloadManifest.xml ServiceEndpoint/Url to a custom HTTPS subdomain of '$VerifiedDomain', for example https://fe.workload.$VerifiedDomain/."

    Add-Check "App ID URI shape is derived from the verified domain" (Test-HttpsUrl -Url $ExpectedAppIdUri) @("Expected App ID URI for Entra app: $ExpectedAppIdUri") "Use the derived App ID URI when creating/updating the Entra app registration."

    $assetFindings = @(Get-AssetFindings)
    Add-Check "Manifest asset references satisfy Fabric upload limits" ($assetFindings.Count -eq 0) $assetFindings "Use existing .png/.jpg/.jpeg assets under workload\manifest\assets and keep each file <= 1.5 MB."

    $videoFindings = @(Get-VideoFindings)
    Add-Check "slideMedia videos use YouTube/Vimeo embed URLs" ($videoFindings.Count -eq 0) $videoFindings "Use https://www.youtube.com/embed/... or https://player.vimeo.com/video/... URLs."

    $itemWorkload = [string]$itemManifest.ItemManifestConfiguration.Item.Workload.WorkloadName
    $itemType = [string]$itemManifest.ItemManifestConfiguration.Item.TypeName
    $manifestWorkload = [string]$workloadManifest.WorkloadManifestConfiguration.Workload.WorkloadName
    Add-Check "Manifest item type belongs to the workload" ($manifestWorkload -eq $WorkloadId -and $itemWorkload -eq $WorkloadId -and $itemType -eq $ItemType) @("WorkloadManifest WorkloadName='$manifestWorkload'; item WorkloadName='$itemWorkload'; item TypeName='$itemType'.") "Use WorkloadName='$WorkloadId' and TypeName='$ItemType'."
}

function Build-Frontend {
    Write-Host "Building frontend production bundle..." -ForegroundColor Cyan
    Push-Location $FrontendRoot
    try {
        $env:VITE_API_URL = $FrontendApiUrl
        $env:ASMDB_WORKLOAD_API = $FrontendApiUrl
        if (-not (Test-Path (Join-Path $FrontendRoot "node_modules"))) {
            Write-Host "Installing frontend dependencies with npm install..."
            Invoke-Tool "npm" @("install") $FrontendRoot
        }
        Invoke-Tool "npm" @("run", "build") $FrontendRoot
    } finally {
        Remove-Item Env:\VITE_API_URL, Env:\ASMDB_WORKLOAD_API -ErrorAction SilentlyContinue
        Pop-Location
    }
}

function Set-PackageVersion {
    [xml]$manifest = Get-Content $WorkloadManifestPath -Raw
    $manifest.WorkloadManifestConfiguration.Workload.Version = $Version
    $manifest.Save($WorkloadManifestPath)
    [xml]$nuspec = Get-Content $NuspecPath -Raw
    $nuspec.package.metadata.id = $WorkloadId
    $nuspec.package.metadata.version = $Version
    $nuspec.Save($NuspecPath)
}

function New-ContentTypesFile {
    # -LiteralPath is required, not stylistic: the NuGet-mandated filename
    # [Content_Types].xml is read as a wildcard by -Path, and PowerShell then
    # reports a missing -Encoding parameter, which is nothing to do with it.
    $path = Join-Path $StageDir "[Content_Types].xml"
    @'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml" />
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="png" ContentType="image/png" />
  <Default Extension="jpg" ContentType="image/jpeg" />
  <Default Extension="jpeg" ContentType="image/jpeg" />
  <Default Extension="nuspec" ContentType="application/octet" />
</Types>
'@ | Set-Content -Encoding UTF8 -LiteralPath $path
}

function New-RelationshipFile {
    $relsDir = Join-Path $StageDir "_rels"
    New-Item -ItemType Directory -Force -Path $relsDir | Out-Null
    @"
<?xml version="1.0" encoding="utf-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Type="http://schemas.microsoft.com/packaging/2010/07/manifest" Target="/$WorkloadId.nuspec" Id="R1" />
</Relationships>
"@ | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $relsDir ".rels")
}

function New-Package {
    if (Test-Path $OutDir) { Get-ChildItem $OutDir -File -Filter "*.nupkg" | Remove-Item -Force }
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    if (Test-Path $StageDir) { Remove-Item $StageDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path (Join-Path $StageDir "BE"), (Join-Path $StageDir "FE\Assets") | Out-Null

    Copy-Item $NuspecPath (Join-Path $StageDir "$WorkloadId.nuspec") -Force
    Copy-Item $WorkloadManifestPath (Join-Path $StageDir "BE\WorkloadManifest.xml") -Force
    Copy-Item $ItemXmlPath (Join-Path $StageDir "BE\$($ItemName)Item.xml") -Force
    Copy-Item $ProductPath (Join-Path $StageDir "FE\Product.json") -Force
    Copy-Item $ItemJsonPath (Join-Path $StageDir "FE\$($ItemName)Item.json") -Force
    # Every asset the manifest references must reach the package, not just the
    # logo: Fabric validates asset references at upload, so a missing file is
    # discovered after everything else is done rather than at packaging time.
    $stagedAssets = Join-Path $StageDir "FE\Assets"
    New-Item -ItemType Directory -Force -Path $stagedAssets | Out-Null
    Copy-Item (Join-Path $ManifestRoot "assets\*") $stagedAssets -Force
    New-ContentTypesFile
    New-RelationshipFile

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (Test-Path $PackagePath) { Remove-Item $PackagePath -Force }
    [System.IO.Compression.ZipFile]::CreateFromDirectory($StageDir, $PackagePath, [System.IO.Compression.CompressionLevel]::Optimal, $false)
    Remove-Item $StageDir -Recurse -Force
}

Add-PreBuildChecks
if (@($script:Checks | Where-Object { -not $_.Passed }).Count -gt 0) {
    Write-Checklist
    exit 1
}

try {
    Build-Frontend
    Set-PackageVersion
    Add-PostBuildChecks
} catch {
    Add-Check "Build and manifest parsing completed" $false @($_.Exception.Message) "Fix the reported build or manifest error, then rerun workload\build\pack.ps1."
}

if (@($script:Checks | Where-Object { -not $_.Passed }).Count -gt 0) {
    Write-Checklist
    exit 1
}

New-Package
Add-Check "Exactly one uploadable package was emitted" ((Test-Path $PackagePath) -and @((Get-ChildItem $OutDir -File -Filter "*.nupkg")).Count -eq 1) @($PackagePath) "Delete extra .nupkg files under workload\build\out and rerun."
Write-Checklist

$resolvedPackage = (Resolve-Path $PackagePath).Path
Write-Host "UPLOAD: $resolvedPackage - upload this file in the Fabric Admin Portal at admin.fabric.microsoft.com -> Workload Publishing -> Upload."
