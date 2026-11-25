#!/usr/bin/env zsh
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
chmod +x "$ROOT_DIR/flowboard_ctl.sh"
"$ROOT_DIR/flowboard_ctl.sh" stop
echo ""
echo "✅ Lube 影视画布已安全停止。"
sleep 2
