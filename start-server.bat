@echo off
setlocal
cd /d "%~dp0"

echo ==========================================
echo    PrintShare - one-click launcher
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install it first from https://nodejs.org
  echo         Then open "Node.js command prompt" from the Start menu and retry.
  pause
  exit /b 1
)

echo ----- Local LAN IPv4 addresses ^(use one of these on the client PC^) -----
ipconfig | findstr /i "IPv4"

echo.
netsh advfirewall firewall show rule name="PrintShare 9100" >nul 2>nul
if errorlevel 1 (
  netsh advfirewall firewall add rule name="PrintShare 9100" dir=in action=allow protocol=TCP localport=9100 >nul 2>nul
  if errorlevel 1 ( echo [Firewall] Failed to allow TCP 9100 ^(run this script as Administrator^) ) else echo [Firewall] TCP 9100 allowed
) else (
  echo [Firewall] TCP 9100 already allowed
)

netsh advfirewall firewall show rule name="PrintShare Admin 8081" >nul 2>nul
if errorlevel 1 (
  netsh advfirewall firewall add rule name="PrintShare Admin 8081" dir=in action=allow protocol=TCP localport=8081 >nul 2>nul
  if errorlevel 1 ( echo [Firewall] Failed to allow TCP 8081 ^(sharing still works; only the remote admin page is blocked^) ) else echo [Firewall] TCP 8081 allowed ^(admin page^)
)

echo.
echo [Service] Starting... the admin page opens at http://localhost:8081 in 2 seconds
start "" /b powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:8081'"

node server.js
set EXIT=%ERRORLEVEL%
echo.
echo Service exited ^(code %EXIT%^). Press any key to close this window.
pause >nul
