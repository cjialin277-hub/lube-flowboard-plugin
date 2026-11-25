#!/usr/bin/env zsh
set -euo pipefail

# Portable PATH supporting Apple Silicon Homebrew, Intel Homebrew, nvm/fnm, and ~/.local
export PATH="$HOME/.local/bin:$HOME/.local/node-v22.14.0-darwin-arm64/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/Library/Python/3.9/bin:$PATH"
if [[ -d "$HOME/.nvm/versions/node" ]]; then
  latest_nvm_node=$(ls -1d "$HOME/.nvm/versions/node"/*/bin 2>/dev/null | tail -n 1 || true)
  [[ -n "$latest_nvm_node" ]] && export PATH="$latest_nvm_node:$PATH"
fi
export NO_PROXY="localhost,127.0.0.1,::1"
export no_proxy="localhost,127.0.0.1,::1"

# Resolve project root dynamically so friends can unzip anywhere on their Mac
FLOWBOARD_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_LOG="$FLOWBOARD_DIR/agent.log"
FRONTEND_LOG="$FLOWBOARD_DIR/frontend.log"
AGENT_PID_FILE="$FLOWBOARD_DIR/.agent.pid"
FRONTEND_PID_FILE="$FLOWBOARD_DIR/.frontend.pid"

stop_services() {
  for pf in "$AGENT_PID_FILE" "$FRONTEND_PID_FILE"; do
    if [[ -f "$pf" ]]; then
      pid=$(cat "$pf" 2>/dev/null || true)
      if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        pkill -P "$pid" 2>/dev/null || true
        kill "$pid" 2>/dev/null || true
      fi
      rm -f "$pf"
    fi
  done
  # Clean any residual listeners on 8434, 8355, 5173
  for port in 8434 8355 5173; do
    pids=$(lsof -ti tcp:$port 2>/dev/null || true)
    if [[ -n "$pids" ]]; then
      echo "$pids" | xargs kill -9 2>/dev/null || true
    fi
  done
  sleep 1
}

start_services() {
  defaults write com.google.Chrome NSAppSleepDisabled -bool YES 2>/dev/null || true
  defaults write com.google.Chrome IntensiveWakeUpThrottlingEnabled -bool NO 2>/dev/null || true
  defaults write com.google.Chrome HighEfficiencyModeEnabled -bool NO 2>/dev/null || true
  defaults write com.google.Chrome TabDiscardingExceptions -array "flow.google.com" "labs.google" "localhost" "127.0.0.1" 2>/dev/null || true

  FLOWBOARD_ROOT_ENV="$FLOWBOARD_DIR" python3 - <<'PY'
import os, shutil, subprocess, sys
from pathlib import Path

root = Path(os.environ["FLOWBOARD_ROOT_ENV"]).resolve()
env = os.environ.copy()
env["NO_PROXY"] = "localhost,127.0.0.1,::1"
env["no_proxy"] = "localhost,127.0.0.1,::1"

uvicorn_bin = root / "agent/.venv/bin/uvicorn"
if not uvicorn_bin.is_file():
    sys.stderr.write(f"ERROR: 未找到后端虚拟环境 {uvicorn_bin}，请先运行一键安装脚本。\n")
    sys.exit(1)

npm_bin = shutil.which("npm")
if not npm_bin:
    sys.stderr.write("ERROR: 未检测到 npm（请先安装 Node.js 18+）。\n")
    sys.exit(1)

agent_log = open(root / "agent.log", "ab", buffering=0)
p_agent = subprocess.Popen(
    [
        "/usr/bin/caffeinate", "-dimsu",
        str(uvicorn_bin),
        "flowboard.main:app",
        "--host", "127.0.0.1",
        "--port", "8434",
        "--timeout-graceful-shutdown", "2",
    ],
    cwd=str(root / "agent"),
    env=env,
    stdin=subprocess.DEVNULL,
    stdout=agent_log,
    stderr=subprocess.STDOUT,
    start_new_session=True,
)
(root / ".agent.pid").write_text(f"{p_agent.pid}\n")

fe_log = open(root / "frontend.log", "ab", buffering=0)
p_fe = subprocess.Popen(
    [
        "/usr/bin/caffeinate", "-dimsu",
        npm_bin,
        "run", "dev",
    ],
    cwd=str(root / "frontend"),
    env=env,
    stdin=subprocess.DEVNULL,
    stdout=fe_log,
    stderr=subprocess.STDOUT,
    start_new_session=True,
)
(root / ".frontend.pid").write_text(f"{p_fe.pid}\n")
print(f"Started caffeinate+agent PID={p_agent.pid}, caffeinate+frontend PID={p_fe.pid} (root={root})")
PY
}

status_services() {
  echo "=== Flowboard Root: $FLOWBOARD_DIR ==="
  [[ -f "$AGENT_PID_FILE" ]] && echo "agent wrapper PID: $(cat "$AGENT_PID_FILE")"
  [[ -f "$FRONTEND_PID_FILE" ]] && echo "frontend wrapper PID: $(cat "$FRONTEND_PID_FILE")"
  echo "=== Listening Ports (:8434 / :8355 / :5173) ==="
  lsof -nP -iTCP:8434 -iTCP:8355 -iTCP:5173 -sTCP:LISTEN || true
}

case "${1:-status}" in
  start)
    stop_services
    start_services
    ;;
  stop)
    stop_services
    echo "Stopped Flowboard services."
    ;;
  restart)
    stop_services
    start_services
    status_services
    ;;
  status)
    status_services
    ;;
  logs)
    tail -n 40 "$AGENT_LOG" "$FRONTEND_LOG"
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs}"
    exit 1
    ;;
esac
