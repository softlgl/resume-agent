@echo off
chcp 65001 >nul
title 简历助手 - 停止服务
cd /d %~dp0
echo 正在停止 简历助手 服务...
powershell -NoProfile -Command "$p=Get-CimInstance Win32_Process -Filter \"Name='node.exe'\"; foreach($x in $p){ if($x.CommandLine -like '*resume-agent*' -and ($x.CommandLine -like '*tsx*' -or $x.CommandLine -like '*vite*' -or $x.CommandLine -like '*-agent*')){ Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host ('stopped pid '+$x.ProcessId) } }"
echo 已尝试停止相关进程。若端口仍被占用，请手动关闭对应窗口 (Ctrl+C)。
pause
