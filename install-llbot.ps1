# 安装 LLBOT (LuckyLilliaBot) —— qq-connect 插件的 QQ 客户端桥接程序
# 版本锁定 v7.12.2 Desktop win-x64,与插件测试环境一致
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Version = 'v7.12.2'
$Asset = 'LLBot-Desktop-win-x64.zip'
$Sha256 = 'fe28c9db70592c472210089f12cb8d1c4f7093ca446e58eaa64d3293d7fa51b3'
$Urls = @(
    "https://github.com/LLOneBot/LuckyLilliaBot/releases/download/$Version/$Asset",
    "https://ghproxy.net/https://github.com/LLOneBot/LuckyLilliaBot/releases/download/$Version/$Asset",
    "https://gh-proxy.com/https://github.com/LLOneBot/LuckyLilliaBot/releases/download/$Version/$Asset"
)

$PluginDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dest = Join-Path $PluginDir 'LLBOT'
$Zip = Join-Path $env:TEMP $Asset

if (Test-Path (Join-Path $Dest 'llbot.exe')) {
    Write-Host "[跳过] $Dest\llbot.exe 已存在。如需重装,请先删除 LLBOT 文件夹再运行本脚本。" -ForegroundColor Yellow
    Read-Host '按回车退出'
    exit 0
}

$ok = $false
foreach ($u in $Urls) {
    try {
        Write-Host "[下载] $u" -ForegroundColor Cyan
        Invoke-WebRequest -Uri $u -OutFile $Zip -UseBasicParsing -TimeoutSec 600
        $ok = $true
        break
    } catch {
        Write-Host "[失败] $($_.Exception.Message),尝试下一个源..." -ForegroundColor Yellow
    }
}
if (-not $ok) {
    Write-Host '[错误] 所有下载源均失败。请手动下载后解压到本插件目录的 LLBOT 文件夹:' -ForegroundColor Red
    Write-Host "  https://github.com/LLOneBot/LuckyLilliaBot/releases/tag/$Version"
    Read-Host '按回车退出'
    exit 1
}

Write-Host '[校验] SHA256...' -ForegroundColor Cyan
$hash = (Get-FileHash $Zip -Algorithm SHA256).Hash.ToLower()
if ($hash -ne $Sha256) {
    Write-Host "[错误] 校验失败(得到 $hash),文件可能被篡改或下载不完整,已中止。" -ForegroundColor Red
    Remove-Item $Zip -Force
    Read-Host '按回车退出'
    exit 1
}

Write-Host "[解压] 到 $Dest" -ForegroundColor Cyan
Expand-Archive -Path $Zip -DestinationPath $Dest -Force
# 部分压缩包带一层根目录,自动摊平
$inner = Get-ChildItem $Dest -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'llbot.exe') } | Select-Object -First 1
if ($inner -and -not (Test-Path (Join-Path $Dest 'llbot.exe'))) {
    Get-ChildItem $inner.FullName -Force | Move-Item -Destination $Dest -Force
    Remove-Item $inner.FullName -Recurse -Force
}
Remove-Item $Zip -Force

if (Test-Path (Join-Path $Dest 'llbot.exe')) {
    Write-Host "[完成] LLBOT $Version 安装成功:$Dest\llbot.exe" -ForegroundColor Green
    Write-Host '下一步:双击 llbot.exe 启动,扫码登录 QQ,再按 README 配置 OneBot 端口与访问令牌。'
} else {
    Write-Host '[警告] 解压完成但未找到 llbot.exe,请打开 LLBOT 文件夹确认结构。' -ForegroundColor Yellow
}
Read-Host '按回车退出'
