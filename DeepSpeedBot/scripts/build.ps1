param([switch]$Native)
$ErrorActionPreference = 'Stop'
$botRoot = Split-Path $PSScriptRoot -Parent
$toolsRoot = Join-Path $botRoot '.tools'
$gccBin = Join-Path $toolsRoot 'w64devkit/bin'
$cmake = Join-Path $toolsRoot 'cmake-4.5.0-windows-x86_64/bin/cmake.exe'
if (-not (Test-Path -LiteralPath $cmake) -or -not (Test-Path -LiteralPath (Join-Path $gccBin 'g++.exe'))) {
    throw 'First run scripts/bootstrap.ps1, or build with your existing CMake/C++ compiler.'
}
$previousPath = $env:PATH
try {
    $env:PATH = "$gccBin;$previousPath"
    $nativeOption = if ($Native) { 'ON' } else { 'OFF' }
    & $cmake -S $botRoot -B (Join-Path $botRoot 'build') -G 'MinGW Makefiles' "-DCMAKE_MAKE_PROGRAM=$gccBin/make.exe" "-DCMAKE_CXX_COMPILER=$gccBin/g++.exe" -DCMAKE_BUILD_TYPE=Release "-DDEEPSPEED_NATIVE=$nativeOption"
    if ($LASTEXITCODE -ne 0) { throw 'CMake configure failed' }
    & $cmake --build (Join-Path $botRoot 'build') --parallel 4
    if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
    & (Join-Path (Split-Path $cmake -Parent) 'ctest.exe') --test-dir (Join-Path $botRoot 'build') --output-on-failure
    if ($LASTEXITCODE -ne 0) { throw 'Tests failed' }
} finally { $env:PATH = $previousPath }
