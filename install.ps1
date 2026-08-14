[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\BookmarkBridge'),
    [string]$BinDir = (Join-Path $env:USERPROFILE '.local\bin'),
    [switch]$SkipPathUpdate,
    [switch]$SkipBrowserRegistration
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
$prebuiltHost = Join-Path $sourceDir 'bookmark-bridge-host.exe'
$nativeHostSource = Join-Path $sourceDir 'native-host.cs'
$files = @(
    'bookmark-bridge.js',
    'bookmark-api-sync.js',
    'ui-job.js',
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
if (-not (Test-Path -LiteralPath (Join-Path $sourceDir 'extension\manifest.json'))) {
    throw '安装包缺少浏览器扩展目录。'
}
if (-not (Test-Path -LiteralPath $prebuiltHost) -and -not (Test-Path -LiteralPath $nativeHostSource)) {
    throw '安装包缺少浏览器通信组件。'
}

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
foreach ($file in $files) {
    Copy-Item -LiteralPath (Join-Path $sourceDir $file) -Destination (Join-Path $InstallDir $file) -Force
}
if (Test-Path -LiteralPath $prebuiltHost) {
    Copy-Item -LiteralPath $prebuiltHost -Destination (Join-Path $InstallDir 'bookmark-bridge-host.exe') -Force
}
[IO.File]::WriteAllText(
    (Join-Path $InstallDir 'node-path.txt'),
    ($node.Source + "`n"),
    [Text.UTF8Encoding]::new($false)
)
$extensionTarget = Join-Path $InstallDir 'extension'
New-Item -ItemType Directory -Path $extensionTarget -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $sourceDir 'extension\manifest.json') -Destination $extensionTarget -Force
Copy-Item -LiteralPath (Join-Path $sourceDir 'extension\content.js') -Destination $extensionTarget -Force
Copy-Item -LiteralPath (Join-Path $sourceDir 'extension\worker.js') -Destination $extensionTarget -Force
Copy-Item -LiteralPath (Join-Path $sourceDir 'extension\popup.html') -Destination $extensionTarget -Force
Copy-Item -LiteralPath (Join-Path $sourceDir 'extension\popup.css') -Destination $extensionTarget -Force
Copy-Item -LiteralPath (Join-Path $sourceDir 'extension\popup.js') -Destination $extensionTarget -Force

# Release 包直接携带预编译 Native Host。源码安装仍保留本机编译回退，
# 方便开发和验证；该组件不会读取密码或浏览器历史记录。
$hostExe = Join-Path $InstallDir 'bookmark-bridge-host.exe'
if (-not (Test-Path -LiteralPath $prebuiltHost)) {
    $frameworkRoot = if ([Environment]::Is64BitOperatingSystem) {
        'C:\Windows\Microsoft.NET\Framework64\v4.0.30319'
    } else {
        'C:\Windows\Microsoft.NET\Framework\v4.0.30319'
    }
    $compiler = Join-Path $frameworkRoot 'csc.exe'
    $webExtensions = Join-Path $frameworkRoot 'System.Web.Extensions.dll'
    if (-not (Test-Path -LiteralPath $compiler) -or -not (Test-Path -LiteralPath $webExtensions)) {
        throw '安装包没有预编译浏览器通信组件，且未找到 Windows .NET Framework C# 编译器。'
    }
    & $compiler /nologo /target:exe "/out:$hostExe" "/reference:$webExtensions" $nativeHostSource
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $hostExe)) {
        throw '编译 Bookmark Bridge 浏览器通信组件失败。'
    }
}

$hostManifestPath = Join-Path $InstallDir 'native-host.json'
$hostManifest = [ordered]@{
    name = 'com.mesakurax.bookmark_bridge'
    description = 'Bookmark Bridge local native messaging host'
    path = $hostExe
    type = 'stdio'
    allowed_origins = @('chrome-extension://faaofhehocblpehenggfdmpbpjnifpim/')
}
[IO.File]::WriteAllText(
    $hostManifestPath,
    (($hostManifest | ConvertTo-Json -Depth 4) + "`n"),
    [Text.UTF8Encoding]::new($false)
)
if (-not $SkipBrowserRegistration) {
    foreach ($registryPath in @(
        'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.mesakurax.bookmark_bridge',
        'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.mesakurax.bookmark_bridge'
    )) {
        New-Item -Path $registryPath -Force | Out-Null
        Set-Item -Path $registryPath -Value $hostManifestPath
    }
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
Write-Host '首次安装请运行：bookmark-bridge setup'
