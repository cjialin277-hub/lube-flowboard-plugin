#!/usr/bin/env zsh
set -euo pipefail

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if [[ -d "$HOME/.nvm/versions/node" ]]; then
  latest_nvm_node=$(ls -1d "$HOME/.nvm/versions/node"/*/bin 2>/dev/null | tail -n 1 || true)
  [[ -n "$latest_nvm_node" ]] && export PATH="$latest_nvm_node:$PATH"
fi
export NO_PROXY="localhost,127.0.0.1,::1"
export no_proxy="localhost,127.0.0.1,::1"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="${FLOWBOARD_PLUGIN_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
DATA_DIR="${FLOWBOARD_PLUGIN_DATA:-$HOME/.flowboard/plugin-data}"
APP_DIR="$PLUGIN_ROOT/app"
VENV_DIR="$DATA_DIR/venv"
STORAGE_DIR="$DATA_DIR/storage"
mkdir -p "$DATA_DIR" "$STORAGE_DIR"

export FLOWBOARD_STORAGE="$STORAGE_DIR"
export FLOWBOARD_DB="$STORAGE_DIR/flowboard.db"

# 1. Start backend (:8434) if not already listening
if ! curl -sf --noproxy '*' http://127.0.0.1:8434/api/health >/dev/null 2>&1; then
  if [[ ! -x "$VENV_DIR/bin/uvicorn" ]]; then
    echo "ERROR: backend venv not initialized at $VENV_DIR" >&2
    exit 1
  fi
  nohup /usr/bin/caffeinate -dimsu "$VENV_DIR/bin/uvicorn" flowboard.main:app \
    --host 127.0.0.1 --port 8434 --timeout-graceful-shutdown 2 \
    >>"$DATA_DIR/agent.log" 2>&1 </dev/null &
  echo $! >"$DATA_DIR/.agent.pid"
fi

# 2. Start frontend (:5173) if not already listening
if ! curl -sf --noproxy '*' http://127.0.0.1:5173 >/dev/null 2>&1; then
  if command -v npm >/dev/null 2>&1; then
    FE_WORK="$DATA_DIR/frontend"
    if [[ ! -d "$FE_WORK/node_modules" ]]; then
      mkdir -p "$FE_WORK"
      rsync -a --exclude='node_modules' --exclude='dist' "$APP_DIR/frontend/" "$FE_WORK/"
      (cd "$FE_WORK" && npm install >>"$DATA_DIR/frontend_install.log" 2>&1)
    fi
    (
      cd "$FE_WORK"
      nohup /usr/bin/caffeinate -dimsu npm run dev >>"$DATA_DIR/frontend.log" 2>&1 </dev/null &
      echo $! >"$DATA_DIR/.frontend.pid"
    )
  else
    echo "WARN: npm not found; please install Node.js 18+ to start the canvas web UI (:5173)." >&2
  fi
fi

# Wait briefly for backend readiness
for i in {1..20}; do
  curl -sf --noproxy '*' http://127.0.0.1:8434/api/health >/dev/null 2>&1 && break
  sleep 0.5
done

echo "STUDIO_READY"
