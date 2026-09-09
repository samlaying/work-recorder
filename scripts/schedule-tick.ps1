# work-recorder tick (Windows): weekday + before 20:00 Beijing → start; after 20:00 → stop.
$ErrorActionPreference = 'Continue'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Electron = Join-Path $Root 'node_modules\electron\dist\electron.exe'
$LockDir = Join-Path $env:APPDATA 'work-recorder'
$Log = Join-Path $LockDir 'schedule-tick.log'

function Write-TickLog([string]$msg) {
  if (-not (Test-Path $LockDir)) { New-Item -ItemType Directory -Path $LockDir -Force | Out-Null }
  Add-Content -Path $Log -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg) -Encoding UTF8
}

function Get-BeijingNow {
  try {
    return [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId((Get-Date), 'China Standard Time')
  } catch {
    return (Get-Date).ToUniversalTime().AddHours(8)
  }
}

function Get-RecorderPids {
  Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($Root) } |
    Select-Object -ExpandProperty ProcessId
}

$bj = Get-BeijingNow
$weekday = [int]$bj.DayOfWeek -ge 1 -and [int]$bj.DayOfWeek -le 5
$hm = $bj.Hour * 100 + $bj.Minute
$pids = @(Get-RecorderPids)
# skip-date: one YYYY-MM-DD per line — stop recording on those days.
$skipFile = Join-Path $LockDir 'skip-date'
$skipToday = (Test-Path $skipFile) -and @(
  Get-Content $skipFile | ForEach-Object { $_.Trim() }
) -contains $bj.ToString('yyyy-MM-dd')

if ($skipToday) {
  foreach ($pid in $pids) {
    Write-TickLog "skip-date $($bj.ToString('yyyy-MM-dd')) — stopping ($pid)"
    Stop-Process -Id $pid -ErrorAction SilentlyContinue
  }
  if ($pids.Count -eq 0) { Write-TickLog "skip-date $($bj.ToString('yyyy-MM-dd')) — not starting" }
  exit 0
}

if ($weekday -and $hm -lt 2000) {
  if ($pids.Count -eq 0) {
    if (-not (Test-Path $Electron)) {
      Write-TickLog "electron binary missing: $Electron"
      exit 1
    }
    if (-not (Test-Path $LockDir)) { New-Item -ItemType Directory -Path $LockDir -Force | Out-Null }
    Write-TickLog 'starting work-recorder'
    Start-Process -FilePath $Electron -ArgumentList @($Root) -WorkingDirectory $Root -WindowStyle Hidden
  }
} elseif ($weekday) {
  foreach ($pid in $pids) {
    Write-TickLog "stopping work-recorder ($pid)"
    Stop-Process -Id $pid -ErrorAction SilentlyContinue
  }
}
