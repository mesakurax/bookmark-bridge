[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\BookmarkBridge'),
    [string]$BinDir = (Join-Path $env:USERPROFILE '.local\bin'),
    [switch]$RemoveData
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

foreach ($name in @('bookmark-bridge.cmd', 'bookmark-sync.cmd')) {
    $shim = Join-Path $BinDir $name
    if (Test-Path -LiteralPath $shim) {
        $content = Get-Content -LiteralPath $shim -Raw
        if ($content -like '*BookmarkBridge*bookmark-sync.js*') {
            Remove-Item -LiteralPath $shim -Force
        }
    }
}

if (Test-Path -LiteralPath $InstallDir) {
    $resolved = (Resolve-Path -LiteralPath $InstallDir).Path
    $expectedParent = (Join-Path $env:LOCALAPPDATA 'Programs')
    if (-not $resolved.StartsWith($expectedParent + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "为避免误删，拒绝删除预期目录外的路径：$resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

if ($RemoveData) {
    $dataDir = Join-Path $env:LOCALAPPDATA 'BookmarkBridge'
    if (Test-Path -LiteralPath $dataDir) {
        $resolvedData = (Resolve-Path -LiteralPath $dataDir).Path
        if ($resolvedData -ine (Join-Path $env:LOCALAPPDATA 'BookmarkBridge')) {
            throw "为避免误删，拒绝删除数据路径：$resolvedData"
        }
        Remove-Item -LiteralPath $resolvedData -Recurse -Force
    }
}

Write-Host 'Bookmark Bridge 已卸载。默认保留备份和历史基线。' -ForegroundColor Green
if (-not $RemoveData) {
    Write-Host '如需同时删除工具数据，请再次运行 uninstall.ps1 -RemoveData。'
}
