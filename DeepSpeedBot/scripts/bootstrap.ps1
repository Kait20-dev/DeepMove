# Portable tools, pinned upstream archives; no registry changes or global PATH.
$ErrorActionPreference = 'Stop'
$botRoot = Split-Path $PSScriptRoot -Parent
$toolsRoot = Join-Path $botRoot '.tools'
New-Item -ItemType Directory -Force -Path $toolsRoot | Out-Null
function Get-VerifiedArchive($url, $file, $sha) {
    if (-not (Test-Path -LiteralPath $file)) {
        & curl.exe --fail --location --silent --show-error $url --output $file
        if ($LASTEXITCODE -ne 0) { throw 'Download failed' }
    }
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sha) {
        throw "SHA256 mismatch: $file"
    }
}
$gccArchive = Join-Path $toolsRoot 'w64devkit-x64-2.11.0.7z.exe'
if (-not (Test-Path -LiteralPath (Join-Path $toolsRoot 'w64devkit/bin/g++.exe'))) {
    Get-VerifiedArchive 'https://github.com/skeeto/w64devkit/releases/download/v2.11.0/w64devkit-x64-2.11.0.7z.exe' $gccArchive '54c2bb9962e8a30c8270e34c5efc3d5fee579f53087fa7d435b95fbba2af7b2b'
    $extract = Start-Process -FilePath $gccArchive -ArgumentList @('-y', ('-o"{0}"' -f $toolsRoot)) -WindowStyle Hidden -Wait -PassThru
    if ($extract.ExitCode -ne 0) { throw 'Compiler extraction failed' }
    Remove-Item -LiteralPath $gccArchive
}
$cmakeArchive = Join-Path $toolsRoot 'cmake.zip'
if (-not (Test-Path -LiteralPath (Join-Path $toolsRoot 'cmake-4.5.0-windows-x86_64/bin/cmake.exe'))) {
    Get-VerifiedArchive 'https://github.com/Kitware/CMake/releases/download/v4.5.0/cmake-4.5.0-windows-x86_64.zip' $cmakeArchive '301b1728317ccd84e984b02e366a8293735bc5ac618757d3d8f58b578f062411'
    Expand-Archive -LiteralPath $cmakeArchive -DestinationPath $toolsRoot -Force
    Remove-Item -LiteralPath $cmakeArchive
}
Write-Host "Portable compiler and CMake ready in $toolsRoot"
