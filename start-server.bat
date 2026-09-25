@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ==========================================
echo    打印机共享 · 一键启动
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先到 https://nodejs.org 安装。
  echo        安装后在开始菜单打开 "Node.js command prompt" 再试。
  pause
  exit /b 1
)

echo ----- 本机局域网 IP（客户端添加打印机请用这里列出的地址）-----
ipconfig | findstr /i "IPv4"

echo.
netsh advfirewall firewall show rule name="PrintShare 9100" >nul 2>nul
if errorlevel 1 (
  netsh advfirewall firewall add rule name="PrintShare 9100" dir=in action=allow protocol=TCP localport=9100 >nul 2>nul
  if errorlevel 1 ( echo [防火墙] 放行 TCP 9100 失败（请右键本脚本“以管理员身份运行”） ) else echo [防火墙] 已放行 TCP 9100
) else (
  echo [防火墙] TCP 9100 已放行
)

netsh advfirewall firewall show rule name="PrintShare Admin 8081" >nul 2>nul
if errorlevel 1 (
  netsh advfirewall firewall add rule name="PrintShare Admin 8081" dir=in action=allow protocol=TCP localport=8081 >nul 2>nul
  if errorlevel 1 ( echo [防火墙] 放行 TCP 8081 失败（不影响共享，只影响远程打开管理页） ) else echo [防火墙] 已放行 TCP 8081（管理页）
)

echo.
echo [服务] 启动中... 2 秒后自动打开管理页 http://localhost:8081
start "" /b powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:8081'"

node server.js
set EXIT=%ERRORLEVEL%
echo.
echo 服务已退出（代码 %EXIT%）。按任意键关闭窗口。
pause >nul