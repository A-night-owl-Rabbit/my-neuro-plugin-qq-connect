@echo off
chcp 65001 >nul
title 安装 LLBOT (LuckyLilliaBot v7.12.2)
echo 正在启动 LLBOT 安装脚本(下载约 90MB,请保持网络畅通)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-llbot.ps1"
