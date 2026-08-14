& {
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ProgressPreference = 'SilentlyContinue'

$repository = 'mesakurax/bookmark-bridge'
$stableDownloadUrl = "https://github.com/$repository/releases/latest/download/bookmark-bridge-windows.zip"
$temporaryDir = Join-Path $env:TEMP ("bookmark-bridge-install-" + [guid]::NewGuid().ToString('N'))
$archive = Join-Path $temporaryDir 'bookmark-bridge.zip'
$expanded = Join-Path $temporaryDir 'expanded'
$totalTimer = [Diagnostics.Stopwatch]::StartNew()

try {
    New-Item -ItemType Directory -Path $temporaryDir -Force | Out-Null
    $headers = @{ 'User-Agent' = 'Bookmark-Bridge-Installer' }

    $stageTimer = [Diagnostics.Stopwatch]::StartNew()
    Write-Host '[1/3] 正在下载 Bookmark Bridge...'
    try {
        Invoke-WebRequest -Uri $stableDownloadUrl -Headers $headers -OutFile $archive
    } catch {
        # v2.3.1 之前的 Release 没有固定文件名。仅在固定入口不可用时
        # 才回退到 GitHub API，保证旧仓库/发布迁移期间仍可安装。
        Write-Host '固定下载入口暂不可用，正在查找兼容安装包...'
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repository/releases/latest" -Headers $headers
        $asset = $release.assets | Where-Object { $_.name -like 'bookmark-bridge-*-windows.zip' } | Select-Object -First 1
        if (-not $asset) {
            throw '最新 Release 中没有找到 Windows ZIP 安装包。'
        }
        Invoke-WebRequest -Uri $asset.browser_download_url -Headers $headers -OutFile $archive
    }
    $stageTimer.Stop()
    Write-Host ("[1/3] 下载完成（{0:N1} 秒）" -f $stageTimer.Elapsed.TotalSeconds)

    $stageTimer.Restart()
    Write-Host '[2/3] 正在解压安装包...'
    Expand-Archive -LiteralPath $archive -DestinationPath $expanded -Force
    $installer = Get-ChildItem -LiteralPath $expanded -Filter 'install.ps1' -File -Recurse | Select-Object -First 1
    if (-not $installer) {
        throw '下载的安装包中没有 install.ps1。'
    }
    $stageTimer.Stop()
    Write-Host ("[2/3] 解压完成（{0:N1} 秒）" -f $stageTimer.Elapsed.TotalSeconds)

    $stageTimer.Restart()
    Write-Host '[3/3] 正在安装本地组件...'
    & $installer.FullName
    $stageTimer.Stop()
    $totalTimer.Stop()
    Write-Host ("[3/3] 安装完成（{0:N1} 秒，总计 {1:N1} 秒）" -f $stageTimer.Elapsed.TotalSeconds, $totalTimer.Elapsed.TotalSeconds) -ForegroundColor Green
} finally {
    if (Test-Path -LiteralPath $temporaryDir) {
        Remove-Item -LiteralPath $temporaryDir -Recurse -Force
    }
}
}
