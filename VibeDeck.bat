@echo off
rem Opens the VibeDeck desktop app. Installs its packages the first time.
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing VibeDeck packages. This only happens once.
  call npm install || (pause & exit /b 1)
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
