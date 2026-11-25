#!/usr/bin/env zsh
set -euo pipefail

# Strict stdio hygiene: NEVER print anything to stdout before exec'ing MCP server!
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
BOOT_LOG="$DATA_DIR/bootstrap.log"

mkdir -p "$DATA_DIR" "$DATA_DIR/storage"

# Guard against unexpanded placeholder strings if plugin was enabled before filling variables
if [[ "${FLOWBOARD_FLOW_PROJECT_ID:-}" == *'${'* ]]; then
  export FLOWBOARD_FLOW_PROJECT_ID=""
fi
if [[ "${FLOWBOARD_PAYGATE_TIER:-}" == *'${'* ]]; then
  export FLOWBOARD_PAYGATE_TIER=""
fi

# Normalize FLOWBOARD_FLOW_PROJECT_ID if user pasted a full Flow URL into plugin variable prompt
if [[ -n "${FLOWBOARD_FLOW_PROJECT_ID:-}" ]]; then
  CLEAN_UUID=$(python3 -c '
import os, re
raw = os.environ.get("FLOWBOARD_FLOW_PROJECT_ID", "")
m = re.search(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", raw)
print(m.group(0).lower() if m else raw.strip())
' 2>/dev/null || echo "${FLOWBOARD_FLOW_PROJECT_ID}")
  export FLOWBOARD_FLOW_PROJECT_ID="$CLEAN_UUID"
fi

if [[ -z "${FLOWBOARD_PAYGATE_TIER:-}" ]]; then
  export FLOWBOARD_PAYGATE_TIER="PAYGATE_TIER_TWO"
fi
export FLOWBOARD_STORAGE="$DATA_DIR/storage"
export FLOWBOARD_DB="$DATA_DIR/storage/flowboard.db"

# Ensure isolated Python >= 3.10 venv with FastAPI + MCP SDK exists (all output redirected to log)
if [[ ! -x "$VENV_DIR/bin/python" ]] || ! "$VENV_DIR/bin/python" -c "import mcp, httpx, fastapi" >/dev/null 2>&1; then
  {
    echo "[$(date)] Bootstrapping plugin venv at $VENV_DIR ..."
    PY_BIN=""
    for cand in python3.12 python3.13 python3.11 python3.10 python3; do
      if command -v "$cand" >/dev/null 2>&1; then
        ok=$("$cand" -c 'import sys; print(1 if sys.version_info >= (3, 10) else 0)' 2>/dev/null || echo 0)
        if [[ "$ok" == "1" ]]; then
          PY_BIN="$(command -v "$cand")"
          break
        fi
      fi
    done
    if command -v uv >/dev/null 2>&1; then
      uv venv --python 3.12 "$VENV_DIR"
      uv pip install --python "$VENV_DIR/bin/python" -e "$APP_DIR/agent" "mcp>=1.2.0"
    elif [[ -n "$PY_BIN" ]]; then
      "$PY_BIN" -m venv "$VENV_DIR"
      "$VENV_DIR/bin/pip" install --upgrade pip
      "$VENV_DIR/bin/pip" install -e "$APP_DIR/agent" "mcp>=1.2.0"
    else
      curl -LsSf https://astral.sh/uv/install.sh | sh
      export PATH="$HOME/.local/bin:$PATH"
      uv venv --python 3.12 "$VENV_DIR"
      uv pip install --python "$VENV_DIR/bin/python" -e "$APP_DIR/agent" "mcp>=1.2.0"
    fi
    echo "[$(date)] Plugin venv ready."
  } >>"$BOOT_LOG" 2>&1
fi

export FLOWBOARD_PLUGIN_ROOT="$PLUGIN_ROOT"
export FLOWBOARD_PLUGIN_DATA="$DATA_DIR"

exec "$VENV_DIR/bin/python" "$PLUGIN_ROOT/scripts/flowboard_mcp.py"
