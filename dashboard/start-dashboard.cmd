@echo off
REM ---------------------------------------------------------------------------
REM start-dashboard.cmd - launches the local Job Radar server on Windows.
REM Registered to run at logon; also fine to double-click manually.
REM Binds 127.0.0.1 only - not reachable from the network.
REM
REM Paths are resolved RELATIVE to this script, so the repo can be cloned
REM anywhere. bun is taken from PATH; known install locations are used as a
REM fallback, because Task Scheduler does not load the interactive user's PATH
REM and a bare "bun" would fail silently there.
REM ---------------------------------------------------------------------------
setlocal enabledelayedexpansion

set "DASH=%~dp0"
if "%DASH:~-1%"=="\" set "DASH=%DASH:~0,-1%"
for %%I in ("%DASH%\..") do set "PROJ=%%~fI"
set "LOG=%DASH%\data\server.log"
if "%PORT%"=="" set "PORT=8899"

if not exist "%DASH%\data" mkdir "%DASH%\data"

REM --- locate bun ------------------------------------------------------------
set "BUN="
for /f "delims=" %%B in ('where bun 2^>nul') do if not defined BUN set "BUN=%%B"
if not defined BUN (
    if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\bun.exe" set "BUN=%LOCALAPPDATA%\Microsoft\WinGet\Links\bun.exe"
)
if not defined BUN (
    set "CAND=%LOCALAPPDATA%\Microsoft\WinGet\Packages\Oven-sh.Bun_Microsoft.Winget.Source_8wekyb3d8bbwe\bun-windows-x64\bun.exe"
    if exist "!CAND!" set "BUN=!CAND!"
)
if not defined BUN (
    if exist "%USERPROFILE%\.bun\bin\bun.exe" set "BUN=%USERPROFILE%\.bun\bin\bun.exe"
)
if not defined BUN (
    REM No "pause" here: this script usually runs hidden, where a pause would wait forever.
    echo ===== %DATE% %TIME% bun not found - run setup.cmd again ===== >> "%LOG%"
    echo bun was not found. Run setup.cmd in the Job Radar folder to install it.
    exit /b 1
)

REM --- guard against a second copy -------------------------------------------
REM A double launch would otherwise spin forever on EADDRINUSE.
netstat -ano | findstr /R /C:"127.0.0.1:%PORT% .*LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo ===== server already running, exiting %DATE% %TIME% ===== >> "%LOG%"
    echo Something is already listening on port %PORT%.
    echo Open http://127.0.0.1:%PORT%
    exit /b 0
)

echo Job Radar -^> http://127.0.0.1:%PORT%  (local only)
echo Logging to %LOG%

cd /d "%PROJ%"

REM ---------------------------------------------------------------------------
REM Keep-alive loop: if the server exits for any reason (clean exit, crash,
REM killed by sleep/logoff) wait 5s and start it again, forever. This is what
REM makes the dashboard 24/7 - previously a single clean exit left it down.
REM ---------------------------------------------------------------------------
:serverloop
echo ===== server start %DATE% %TIME% ===== >> "%LOG%"
"%BUN%" run "%DASH%\serve.ts" --port %PORT% >> "%LOG%" 2>&1
echo ===== server exited (code %ERRORLEVEL%) %DATE% %TIME% - restarting in 5s ===== >> "%LOG%"
timeout /t 5 /nobreak >nul
goto serverloop
