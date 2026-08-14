$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repository = 'mesakurax/bookmark-bridge'
$temporaryDir = Join-Path $env:TEMP ("bookmark-bridge-install-" + [guid]::NewGuid().ToString('N'))
$archive = Join-Path $temporaryDir 'bookmark-bridge.zip'
$expanded = Join-Path $temporaryDir 'expanded'

try {
    New-Item -ItemType Directory -Path $temporaryDir -Force | Out-Null
    $headers = @{ 'User-Agent' = 'Bookmark-Bridge-Installer' }
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repository/releases/latest" -Headers $headers
    $asset = $release.assets | Where-Object { $_.name -like 'bookmark-bridge-*.zip' } | Select-Object -First 1
    if (-not $asset) {
        throw '最新 Release 中没有找到 Windows ZIP 安装包。'
    }
    Invoke-WebRequest -Uri $asset.browser_download_url -Headers $headers -OutFile $archive
    Expand-Archive -LiteralPath $archive -DestinationPath $expanded -Force
    $installer = Get-ChildItem -LiteralPath $expanded -Filter 'install.ps1' -File -Recurse | Select-Object -First 1
    if (-not $installer) {
        throw '下载的安装包中没有 install.ps1。'
    }
    & $installer.FullName
} finally {
    if (Test-Path -LiteralPath $temporaryDir) {
        Remove-Item -LiteralPath $temporaryDir -Recurse -Force
    }
}
