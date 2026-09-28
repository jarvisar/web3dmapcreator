@echo off
rem Double-click to set up the Jarvizar City Model downloader. Runs
rem setup_downloader.ps1 without changing the PowerShell execution policy.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_downloader.ps1" %*
set "SETUP_STATUS=%ERRORLEVEL%"
echo.
pause
exit /b %SETUP_STATUS%
