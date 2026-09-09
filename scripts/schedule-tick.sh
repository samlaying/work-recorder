#!/bin/bash
# launchd tick: weekday + before 20:00 Beijing → start; weekday after 20:00 → stop.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ELECTRON="$ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
LOCK_DIR="$HOME/Library/Application Support/work-recorder"
export TZ=Asia/Shanghai

dow="$(date +%u)"   # 1=Mon … 7=Sun
hm="$(date +%H%M)"
is_weekday=0
[[ "$dow" -ge 1 && "$dow" -le 5 ]] && is_weekday=1

running_pid() {
  pgrep -f "$ELECTRON $ROOT" || true
}

# Manual "stop on these days": one YYYY-MM-DD per line in "$LOCK_DIR/skip-date"
skip_today() {
  local f="$LOCK_DIR/skip-date"
  [[ -f "$f" ]] || return 1
  grep -qx "$(date +%F)" "$f"
}

start_recorder() {
  if [[ ! -x "$ELECTRON" ]]; then
    echo "$(date '+%F %T') electron binary missing: $ELECTRON"
    exit 1
  fi
  mkdir -p "$LOCK_DIR"
  # Drop stale single-instance lock if Electron is not actually running.
  if [[ -z "$(running_pid)" ]]; then
    rm -f "$LOCK_DIR/SingletonLock" "$LOCK_DIR/SingletonCookie" "$LOCK_DIR/SingletonSocket" 2>/dev/null || true
  fi
  echo "$(date '+%F %T') starting work-recorder"
  cd "$ROOT"
  nohup "$ELECTRON" "$ROOT" >>"$LOCK_DIR/electron.stderr.log" 2>&1 &
}

stop_recorder() {
  local pids
  pids="$(running_pid)"
  if [[ -n "$pids" ]]; then
    echo "$(date '+%F %T') stopping work-recorder ($pids)"
    # shellcheck disable=SC2086
    kill -TERM $pids 2>/dev/null || true
  fi
}

if skip_today; then
  stop_recorder
  echo "$(date '+%F %T') skip-date $(date +%F) — not starting"
  exit 0
fi

# 10# avoids bash treating 08xx/09xx as invalid octal.
if [[ "$is_weekday" -eq 1 && $((10#$hm)) -lt 2000 ]]; then
  if [[ -z "$(running_pid)" ]]; then
    start_recorder
  fi
elif [[ "$is_weekday" -eq 1 ]]; then
  stop_recorder
fi
