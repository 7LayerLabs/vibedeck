@echo off
rem VibeDeck launcher: start server (if not already up), open app window
cd /d "%~dp0"
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing http://localhost:18801 -TimeoutSec 1) | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  start "VibeDeck Server" /min cmd /c "node server.js"
  timeout /t 2 /nobreak >nul
)
start "" msedge --app=http://localhost:18801
