#!/usr/bin/env bash
# setup.sh - one-step setup for Job Radar on macOS and Linux.
#
#   bash setup.sh          install Bun if needed, start Job Radar, open it in the browser
#   bash setup.sh --stop   stop Job Radar
#
# Job Radar keeps running in the background until you log out or restart;
# run this script again to start it afterwards.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8899}"
URL="http://127.0.0.1:$PORT"
say() { printf '==> %s\n' "$*"; }
up() { curl -fs -o /dev/null --max-time 2 "$URL"; }

if [ "${1:-}" = "--stop" ]; then
  pkill -f "$ROOT/dashboard/start-dashboard.sh" || true
  pkill -f "$ROOT/dashboard/serve.ts" || true
  say "Job Radar stopped."
  exit 0
fi

for tool in curl unzip; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Please install '$tool' first (for example: sudo apt install $tool), then run this again." >&2
    exit 1
  fi
done

if ! command -v bun >/dev/null 2>&1 && [ ! -x "$HOME/.bun/bin/bun" ]; then
  say "Installing Bun (https://bun.sh)..."
  curl -fsSL https://bun.sh/install | bash
fi
export PATH="$HOME/.bun/bin:$PATH"
say "Bun $(bun --version) is installed"

if up; then
  say "Job Radar is already running."
else
  say "Starting Job Radar..."
  nohup bash "$ROOT/dashboard/start-dashboard.sh" >/dev/null 2>&1 &
  for _ in $(seq 1 60); do
    if up; then break; fi
    sleep 1
  done
fi

if ! up; then
  echo "Job Radar did not start. Details are in $ROOT/dashboard/data/server.log" >&2
  exit 1
fi
say "Job Radar is running at $URL"
if command -v open >/dev/null 2>&1; then
  open "$URL"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1 || true
fi
echo
echo 'Next: click "Upload CV" in the browser, then "Scrape Now" or Smart Search.'
