@echo off
chcp 65001 >nul
title 简历助手 - 一键启动
cd /d %~dp0

echo ====================================
echo   简历助手 (Resume Agent) 一键启动
echo ====================================
echo.

REM 检查依赖是否已安装（node_modules 存在）
if not exist "node_modules" (
  echo [1/3] 首次运行，安装依赖中（可能需要几分钟）...
  call npm install
  if errorlevel 1 (
    echo 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
) else (
  echo [1/3] 依赖已就绪，跳过安装。
)

echo [2/3] 启动后端服务 (Fastify :4000) 与前端 (Vite :5173)...
REM 先清理可能残留的旧服务进程，避免旧构建/旧代码继续占用端口
powershell -NoProfile -Command "$pids=@(); try { $pids += (Get-NetTCPConnection -LocalPort 4000 -ErrorAction SilentlyContinue).OwningProcess } catch {}; try { $pids += (Get-NetTCPConnection -LocalPort 5173 -ErrorAction SilentlyContinue).OwningProcess } catch {}; $pids = $pids | Where-Object { $_ -and $_ -ne $PID } | Sort-Object -Unique; if ($pids) { Stop-Process -Id $pids -Force -ErrorAction SilentlyContinue; Write-Host ('已清理残留进程: ' + ($pids -join ',')) } else { Write-Host '无残留进程' }" >nul 2>&1
start "resume-server" cmd /c "npm run dev:server ^> server.out.log 2^>^&1"
start "resume-client" cmd /c "npm run dev:client ^> client.out.log 2^>^&1"

echo [3/3] 等待前端服务就绪并打开浏览器...
ping -n 9 127.0.0.1 >nul

REM 等待前端端口就绪（最多 30 秒）
set "READY=0"
for /L %%i in (1,1,30) do (
  powershell -NoProfile -Command "try { (Invoke-WebRequest -Uri http://localhost:5173 -UseBasicParsing -TimeoutSec 1).StatusCode } catch { exit 1 }" >nul 2>&1
  if not errorlevel 1 (
    set "READY=1"
    goto :OPEN
  )
  ping -n 2 127.0.0.1 >nul
)
:OPEN
start http://localhost:5173

echo.
echo 服务已启动：
echo   前端  -> http://localhost:5173  (已在浏览器打开)
echo   后端  -> http://localhost:4000
echo.
echo 日志文件：server.out.log / client.out.log
echo 关闭窗口不会停止服务，请在对应命令行窗口按 Ctrl+C 结束。
echo 若需停止全部，运行 stop.bat 或关闭 "resume-server" / "resume-client" 窗口。
echo.
pause
