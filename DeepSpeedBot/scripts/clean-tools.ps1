# Safe, opt-in cleanup of ONLY this bot's portable downloaded toolchain.
$ErrorActionPreference = 'Stop'
$botRoot = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$toolsRoot = [IO.Path]::GetFullPath((Join-Path $botRoot '.tools'))
$expectedRoot = $botRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $toolsRoot.StartsWith($expectedRoot, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $toolsRoot -Leaf) -ne '.tools') {
    throw 'Refusing cleanup outside DeepSpeedBot/.tools'
}
if (Test-Path -LiteralPath $toolsRoot) {
    $target = Get-Item -LiteralPath $toolsRoot -Force
    if ($target.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing to delete a linked directory' }
    Get-ChildItem -LiteralPath $toolsRoot -Recurse -Force | ForEach-Object {
        if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing to traverse links' }
    }
    Remove-Item -LiteralPath $toolsRoot -Recurse -Force
}
Write-Host 'Portable toolchain removed; sources and build outputs preserved.'
