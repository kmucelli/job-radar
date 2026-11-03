#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# start-dashboard.sh — launches the local Job Radar server on macOS / Linux.
#
# Equivalent of start-dashboard.cmd. Binds 127.0.0.1 only, so the dashboard is
# never reachable from the network.
#
#   ./start-dashboard.sh            # run in the foreground
#   PORT=9000 ./start-dashboard.sh  # different port
#
# All paths are resolved relative to this script, so the repo can live anywhere.
# ---------------------------------------------------------------------------
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8899}"
LOG="$HERE/data/server.log"

mkdir -p "$HERE/data"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun was not found on PATH." >&2
  echo "Run setup.sh in the Job Radar folder to install it." >&2
  exit 1
fi

# Refuse to start a second copy — a double launch just spins on EADDRINUSE.
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Something is already listening on port $PORT — not starting a second copy."
  echo "Open http://127.0.0.1:$PORT"
  exit 0
fi

echo "Job Radar → http://127.0.0.1:$PORT  (local only)"
echo "Logging to $LOG"

# Keep-alive loop: if the server exits for any reason (clean exit, crash, the
# machine sleeping) wait 5s and start it again.
while true; do
  echo "===== server start $(date) =====" >>"$LOG"
  bun run "$HERE/serve.ts" --port "$PORT" >>"$LOG" 2>&1
  code=$?
  echo "===== server exited (code $code) $(date) - restarting in 5s =====" >>"$LOG"
  sleep 5
done
