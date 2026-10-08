@echo off
chcp 65001 >nul
title 简历助手 - 停止服务
cd /d %~dp0
echo 正在停止 简历助手 服务...
REM 目标：Node(tsx/vite) + .NET(dotnet/ResumeAgent.Api) + dev.ps1 包装进程 + 占用 4000/5173 的残留进程
powershell -NoProfile -Command "$pids=@(); try { $pids += (Get-NetTCPConnection -LocalPort 4000,5173 -ErrorAction SilentlyContinue).OwningProcess } catch {}; $pids += (Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*resume-agent*' -and ($_.CommandLine -like '*tsx*' -or $_.CommandLine -like '*vite*')) -or ($_.Name -eq 'ResumeAgent.Api.exe') -or ($_.Name -like 'dotnet*' -and $_.CommandLine -like '*ResumeAgent*') -or ($_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*dev.ps1*') }).ProcessId; $pids = $pids | Where-Object { $_ -and $_ -ne $PID } | Sort-Object -Unique; if ($pids) { foreach($x in $pids){ Stop-Process -Id $x -Force -ErrorAction SilentlyContinue; Write-Host ('stopped pid '+$x) } } else { Write-Host 'no matching process' }"
echo 已尝试停止相关进程。若端口仍被占用，请手动关闭对应窗口 (Ctrl+C)。
pause
