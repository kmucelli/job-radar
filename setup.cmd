@echo off
REM setup.cmd - double-click to install and start Job Radar (see README.md).
REM Installs Bun if needed, starts Job Radar with Windows, schedules the daily
REM search and opens http://127.0.0.1:8899. Safe to run again at any time.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
echo.
pause
