@echo off
REM ---------------------------------------------------------------------------
REM run-daily.cmd - the daily job search, started at 09:00 by the
REM "JobRadar Daily Scrape" task that setup.ps1 registers. Runs every portal and
REM refreshes dashboard\data\jobs.json for the dashboard.
REM
REM Paths are relative to this script. bun is looked up the same way as in
REM start-dashboard.cmd: Task Scheduler may not load the user's PATH, so the
REM known install locations are tried as well.
REM ---------------------------------------------------------------------------
setlocal

set "DASH=%~dp0"
if "%DASH:~-1%"=="\" set "DASH=%DASH:~0,-1%"
for %%I in ("%DASH%\..") do set "PROJ=%%~fI"
set "LOG=%DASH%\data\scrape.log"
if not exist "%DASH%\data" mkdir "%DASH%\data"

set "BUN="
for /f "delims=" %%B in ('where bun 2^>nul') do if not defined BUN set "BUN=%%B"
if not defined BUN if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\bun.exe" set "BUN=%LOCALAPPDATA%\Microsoft\WinGet\Links\bun.exe"
if not defined BUN for /d %%P in ("%LOCALAPPDATA%\Microsoft\WinGet\Packages\Oven-sh.Bun_*") do if exist "%%P\bun-windows-x64\bun.exe" set "BUN=%%P\bun-windows-x64\bun.exe"
if not defined BUN if exist "%USERPROFILE%\.bun\bin\bun.exe" set "BUN=%USERPROFILE%\.bun\bin\bun.exe"
if not defined BUN (
    echo ===== %DATE% %TIME% bun not found - run setup.cmd again ===== >> "%LOG%"
    exit /b 1
)

echo. >> "%LOG%"
echo ===== run start %DATE% %TIME% ===== >> "%LOG%"
cd /d "%PROJ%"
"%BUN%" run "%DASH%\scrape-daily.ts" --jobage 1 >> "%LOG%" 2>&1
set "CODE=%ERRORLEVEL%"
echo ===== run end %DATE% %TIME% (exit %CODE%) ===== >> "%LOG%"
exit /b %CODE%
