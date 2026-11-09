#!/usr/bin/env bash
# grokbot-BYOK — Grok Bot sandbox (box) installer.
#
# Run this INSIDE the Grok Bot box terminal (the Linux sandbox you see in
# the app). It installs the BYOK shim next to the running host, patches
# host-main.cjs so inference routes to your own providers, and starts the
# shim + re-patch watcher daemons.
#
# Usage:
#   bash box-install.sh <ZAI_API_KEY>
#
# Optional env:
#   SAND_HOST_DIR   host dir (default /opt/sand/sand-host)
#   BYOK_REPO       repo URL (default your GitHub fork)
set -euo pipefail

KEY="${1:-}"
if [ -z "$KEY" ]; then
  echo "usage: bash box-install.sh <ZAI_API_KEY>" >&2
  exit 1
fi

HOST_DIR="${SAND_HOST_DIR:-/opt/sand/sand-host}"
REPO="${BYOK_REPO:-https://github.com/TommyG0105/grokbot-BYOK.git}"
DEST="$HOME/byok"

echo "==> checking environment"
command -v node >/dev/null 2>&1 || { echo "ERROR: node not found in box" >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "ERROR: node >=18 required, found $(node -v)" >&2
  exit 1
fi
if [ ! -f "$HOST_DIR/host-main.cjs" ]; then
  echo "ERROR: host-main.cjs not found at $HOST_DIR" >&2
  echo "hint: ls /opt/sand/ to inspect; set SAND_HOST_DIR if it lives elsewhere" >&2
  exit 1
fi
echo "    node $(node -v), host at $HOST_DIR ✓"

echo "==> fetching repo"
if [ -d "$DEST/.git" ]; then
  git -C "$DEST" pull --ff-only >/dev/null 2>&1 || true
else
  git clone --depth 1 "$REPO" "$DEST" >/dev/null
fi
cd "$DEST"

echo "==> installing deps + building"
if [ -f package-lock.json ]; then npm ci --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund >/dev/null 2>&1
else npm install --no-audit --no-fund >/dev/null 2>&1; fi
npm run build:all >/dev/null

echo "==> writing credentials (0600)"
umask 177
printf 'ZAI_API_KEY=%s\n' "$KEY" > .env
umask 022

echo "==> installing: patch host + start daemons"
SAND_HOST_DIR="$HOST_DIR" node dist/scripts/setup.js

echo "==> reloading the running host (supervisor restarts it)"
if pgrep -f "host-main.cjs" >/dev/null 2>&1; then
  pkill -f "host-main.cjs" || true
  sleep 2
fi

echo ""
echo "DONE ✓  inference now routes: host → localhost:8788 → your providers"
echo "verify: curl -s http://127.0.0.1:8788/ -o /dev/null -w '%{http_code}\\n'  (expect 404 = alive)"
echo "logs:   tail -f /tmp/inference-shim.log"
