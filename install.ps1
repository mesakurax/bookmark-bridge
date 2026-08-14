[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\BookmarkBridge'),
    [string]$BinDir = (Join-Path $env:USERPROFILE '.local\bin'),
    [switch]$SkipPathUpdate
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($PSVersionTable.PSEdition -eq 'Core' -and -not $IsWindows) {
    throw 'Bookmark Bridge 目前只支持 Windows。'
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    throw '未找到 Node.js。请先安装 Node.js 22.12 或更高版本。'
}
$nodeVersionText = (& $node.Source --version).Trim().TrimStart('v')
$nodeVersion = [version]$nodeVersionText
if ($nodeVersion -lt [version]'22.12.0') {
    throw "Node.js 版本过低：$nodeVersionText。需要 22.12 或更高版本。"
}

$sourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$files = @(
    'bookmark-bridge.js',
    'history-sync.js',
    'password-migrate.js',
    'bookmark-bridge.cmd',
    'README.md',
    'LICENSE',
    'uninstall.ps1'
)
foreach ($file in $files) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceDir $file))) {
        throw "安装包缺少文件：$file"
    }
}

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
foreach ($file in $files) {
    Copy-Item -LiteralPath (Join-Path $sourceDir $file) -Destination (Join-Path $InstallDir $file) -Force
}

$entry = Join-Path $InstallDir 'bookmark-bridge.js'
$shim = "@echo off`r`nnode --no-warnings `"$entry`" %*`r`nexit /b %errorlevel%`r`n"
[IO.File]::WriteAllText((Join-Path $BinDir 'bookmark-bridge.cmd'), $shim, [Text.UTF8Encoding]::new($false))

# 2.1 起不再提供旧命令；升级时只清理由本工具创建的旧入口。
$legacyShim = Join-Path $BinDir 'bookmark-sync.cmd'
if (Test-Path -LiteralPath $legacyShim) {
    $legacyContent = Get-Content -LiteralPath $legacyShim -Raw
    if ($legacyContent -like '*BookmarkBridge*' -or $legacyContent -like '*bookmark-sync.js*') {
        Remove-Item -LiteralPath $legacyShim -Force
    }
}
foreach ($legacyName in @('bookmark-sync.js', 'bookmark-sync.cmd')) {
    $legacyFile = Join-Path $InstallDir $legacyName
    if (Test-Path -LiteralPath $legacyFile) {
        Remove-Item -LiteralPath $legacyFile -Force
    }
}

if (-not $SkipPathUpdate) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $pathEntries = @($userPath -split ';' | Where-Object { $_ })
    $alreadyPresent = $pathEntries | Where-Object { $_.TrimEnd('\') -ieq $BinDir.TrimEnd('\') }
    if (-not $alreadyPresent) {
        $newUserPath = (@($pathEntries) + $BinDir) -join ';'
        [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
        Write-Host "已把 $BinDir 加入当前用户 PATH。"
    }
}

Write-Host ''
Write-Host "Bookmark Bridge 已安装到：$InstallDir" -ForegroundColor Green
Write-Host "命令入口：$BinDir\bookmark-bridge.cmd"
Write-Host '请打开新的 PowerShell，然后运行：bookmark-bridge -h'
