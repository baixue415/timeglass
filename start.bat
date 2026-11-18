@echo off
cd /d "%~dp0"
echo ============================================
echo   Timeglass - starting...
echo   Allow firewall / permission prompt on first run
echo ============================================
npx electron . %*
if errorlevel 1 (
  echo.
  echo Start failed. Please check:
  echo   1. Run "npm install" in this folder first
  echo   2. ffmpeg is installed and in PATH (needed for transcoding)
  pause
)
