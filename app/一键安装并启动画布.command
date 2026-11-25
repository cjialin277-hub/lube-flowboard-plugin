#!/usr/bin/env zsh
set -euo pipefail

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if [[ -d "$HOME/.nvm/versions/node" ]]; then
  latest_nvm_node=$(ls -1d "$HOME/.nvm/versions/node"/*/bin 2>/dev/null | tail -n 1 || true)
  [[ -n "$latest_nvm_node" ]] && export PATH="$latest_nvm_node:$PATH"
fi
export NO_PROXY="localhost,127.0.0.1,::1"
export no_proxy="localhost,127.0.0.1,::1"

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

echo "============================================================"
echo "  Lube 影视画布 v2.0 · Mac 一键安装与启动器"
echo "  目录: $ROOT_DIR"
echo "============================================================"
echo ""

# 1. Check Node.js / npm
if ! command -v npm >/dev/null 2>&1; then
  echo "❌ 未检测到 Node.js / npm。"
  if command -v brew >/dev/null 2>&1; then
    echo "👉 正在尝试通过 Homebrew 自动安装 Node.js..."
    brew install node
  else
    echo "请先前往 https://nodejs.org/ 下载安装 macOS LTS 版 Node.js，装完再双击本脚本即可。"
    read -r "?按回车键退出..."
    exit 1
  fi
fi

# 2. Ensure .env exists (clean template for fresh Mac; never overwrites user's existing .env)
if [[ ! -f "$ROOT_DIR/.env" && -f "$ROOT_DIR/.env.example" ]]; then
  cp "$ROOT_DIR/.env.example" "$ROOT_DIR/.env"
  echo "✅ 已初始化默认配置文件 .env（稍后请在浏览器向导里绑定你自己的 Flow 项目）"
fi

# 3. Install backend Python >=3.10 venv if missing
if [[ ! -x "$ROOT_DIR/agent/.venv/bin/uvicorn" ]]; then
  echo ""
  echo "📦 首次启动：正在配置后端运行环境（Python >= 3.10）..."
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
    echo "⚡ 使用 uv 快速构建 Python 3.12 虚拟环境..."
    (cd "$ROOT_DIR/agent" && uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -e .)
  elif [[ -n "$PY_BIN" ]]; then
    echo "🐍 使用 $PY_BIN 构建虚拟环境..."
    (cd "$ROOT_DIR/agent" && "$PY_BIN" -m venv .venv && .venv/bin/pip install --upgrade pip && .venv/bin/pip install -e .)
  else
    echo "⚡ 未检测到 Python 3.10+，正在安装轻量工具 uv 以自动下载独立 Python 3.12..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
    (cd "$ROOT_DIR/agent" && uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -e .)
  fi
  echo "✅ 后端环境安装完成！"
fi

# 4. Install frontend dependencies if missing
if [[ ! -d "$ROOT_DIR/frontend/node_modules" ]]; then
  echo ""
  echo "📦 首次启动：正在安装前端画布依赖（npm install）..."
  (cd "$ROOT_DIR/frontend" && npm install)
  echo "✅ 前端依赖安装完成！"
fi

# 5. Start services via portable controller
echo ""
echo "🚀 正在启动 Lube 影视画布后端 (:8434) 与前端 (:5173)..."
chmod +x "$ROOT_DIR/flowboard_ctl.sh"
"$ROOT_DIR/flowboard_ctl.sh" start

# 6. Wait for backend & frontend readiness
echo "⏳ 等待画布服务就绪..."
for i in {1..30}; do
  if curl -s --noproxy '*' http://127.0.0.1:8434/api/health >/dev/null 2>&1 && curl -s --noproxy '*' http://127.0.0.1:5173 >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo ""
echo "🎉 启动成功！正在为你打开画布页面（首次进入会自动弹出 3 步中文绑定向导）："
echo "   http://localhost:5173"
echo ""
if [[ -d "/Applications/Google Chrome.app" ]]; then
  open -a "Google Chrome" "http://localhost:5173"
else
  open "http://localhost:5173"
fi
echo "提示：本窗口可关闭，画布将在后台持续运行；如需停止请双击「停止画布.command」。"
sleep 3
