<#
  setup.ps1 - one-step setup for Job Radar on Windows. Double-click setup.cmd to run it.

  It:
    1. installs Bun (https://bun.sh), the only thing Job Radar needs, if it is missing;
    2. registers two scheduled tasks for the current user (no admin rights needed):
         "JobRadar"               starts the dashboard at logon and restarts it if it stops
         "JobRadar Daily Scrape"  runs the daily job search at 09:00
    3. starts Job Radar and opens http://127.0.0.1:8899 in your browser.
  Running it again is safe: it refreshes the tasks and leaves a running server alone.

    setup.ps1 -Uninstall   stop Job Radar and remove both tasks (what uninstall.cmd does)
    setup.ps1 -NoBrowser   do not open the browser at the end
#>
param(
  [switch]$Uninstall,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$Dash = Join-Path $Root 'dashboard'
$Port = 8899
$Url = "http://127.0.0.1:$Port"
$Tasks = @('JobRadar', 'JobRadar Daily Scrape')

function Say([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }

function Find-Bun {
  $cmd = Get-Command bun -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @("$env:LOCALAPPDATA\Microsoft\WinGet\Links\bun.exe", "$env:USERPROFILE\.bun\bin\bun.exe")
  $candidates += @(Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Oven-sh.Bun_*\bun-windows-x64\bun.exe" -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
  foreach ($p in $candidates) { if ($p -and (Test-Path $p)) { return $p } }
  return $null
}

function Install-Bun {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Say 'Installing Bun with winget (about a minute)...'
    & winget install --id Oven-sh.Bun --exact --silent --accept-source-agreements --accept-package-agreements | Out-Host
    if (Find-Bun) { return }
  }
  Say 'Installing Bun with its official installer...'
  & powershell -NoProfile -ExecutionPolicy Bypass -Command 'irm https://bun.sh/install.ps1 | iex' | Out-Host
}

function Test-Port {
  $client = New-Object System.Net.Sockets.TcpClient
  try { $client.Connect('127.0.0.1', $Port); return $true }
  catch { return $false }
  finally { $client.Dispose() }
}

# The process listening on the port, if any.
function Get-PortOwner {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($conn) { Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)" }
}

# This copy's keep-alive loop (start-dashboard.cmd) and the server it runs; the loop first,
# so it cannot restart the server in between.
function Get-OwnProcesses {
  $here = [Regex]::Escape($Dash)
  Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -match $here -and $_.CommandLine -match 'start-dashboard\.cmd|serve\.ts' } |
    Sort-Object { $_.Name -ne 'cmd.exe' }
}

if ($Uninstall) {
  foreach ($t in $Tasks) {
    if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $t -Confirm:$false
      Say "Removed scheduled task '$t'"
    }
  }
  $procs = @(Get-OwnProcesses)
  foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  if ($procs.Count) { Say 'Job Radar stopped.' } else { Say 'Job Radar was not running.' }
  Say "Your data is still in $Dash\data. Delete the Job Radar folder to remove everything."
  return
}

Say 'Setting up Job Radar'

# Files from a downloaded ZIP carry a "downloaded from the internet" mark that can make
# Windows ask before running a script; clear it for this folder's scripts.
Get-ChildItem -LiteralPath $Root -Recurse -File -Include *.cmd, *.ps1, *.vbs | Unblock-File

$bun = Find-Bun
if (-not $bun) {
  Install-Bun
  $bun = Find-Bun
  if (-not $bun) { throw 'Bun could not be installed automatically. Install it from https://bun.sh and run setup again.' }
}
Say "Bun $(& $bun --version) is installed"

# Scheduled tasks for the current user. -Force replaces older versions, including ones
# that point to a previous location of this folder.
$user = "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$serverSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
$serverAction = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + (Join-Path $Dash 'launch-hidden.vbs') + '"') -WorkingDirectory $Root
$serverTriggers = @(
  (New-ScheduledTaskTrigger -AtLogOn -User $user),
  # Watchdog every 5 minutes: start-dashboard.cmd exits at once when the server is already up.
  (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(-1) -RepetitionInterval (New-TimeSpan -Minutes 5))
)
Register-ScheduledTask -TaskName 'JobRadar' -Action $serverAction -Trigger $serverTriggers -Principal $principal `
  -Settings $serverSettings -Description "Job Radar dashboard at $Url (starts at logon, restarts if stopped)" -Force | Out-Null
Say 'Job Radar will start automatically with Windows'

$dailySettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 3)
$dailyAction = New-ScheduledTaskAction -Execute (Join-Path $Dash 'run-daily.cmd') -WorkingDirectory $Root
Register-ScheduledTask -TaskName 'JobRadar Daily Scrape' -Action $dailyAction -Trigger (New-ScheduledTaskTrigger -Daily -At '09:00') `
  -Principal $principal -Settings $dailySettings -Description 'Job Radar daily job search' -Force | Out-Null
Say 'A job search will run every day at 09:00'

# Start the server, unless it already runs. Refuse to sit behind another copy on the same port.
$owner = Get-PortOwner
if ($owner -and $owner.CommandLine -notmatch [Regex]::Escape($Dash)) {
  Write-Warning "Port $Port is already used by another program or another copy of Job Radar:`n  $($owner.CommandLine)`nStop it (run uninstall.cmd in that copy) and run setup again."
  exit 1
}
if (-not (Test-Port)) {
  Say 'Starting Job Radar...'
  Start-ScheduledTask -TaskName 'JobRadar'
  $deadline = (Get-Date).AddSeconds(60)
  while (-not (Test-Port) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 1 }
}
if (-not (Test-Port)) { throw "Job Radar did not start. Details are in $Dash\data\server.log" }

Say "Job Radar is running at $Url"
if (-not $NoBrowser) { Start-Process $Url }
Write-Host ''
Write-Host 'Next: click "Upload CV" in the browser, then "Scrape Now" or Smart Search.' -ForegroundColor Green
