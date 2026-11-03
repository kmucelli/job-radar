@echo off
REM uninstall.cmd - double-click to stop Job Radar and remove its scheduled tasks.
REM Your CV and job data stay in dashboard\data until you delete the folder.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" -Uninstall
echo.
pause
