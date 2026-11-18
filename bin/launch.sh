#!/bin/sh
set -eu
PLUGIN_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NODE_BIN=${TONGJI_NODE_PATH:-}
if [ -z "$NODE_BIN" ]; then
  if command -v node >/dev/null 2>&1; then
    NODE_BIN=$(command -v node)
  elif [ -x "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" ]; then
    NODE_BIN="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
  elif [ -x "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" ]; then
    NODE_BIN="/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"
  else
    echo '需要 Node.js 20+。请安装 Node，或设置 TONGJI_NODE_PATH 为 node 可执行文件的绝对路径。' >&2
    exit 1
  fi
fi
cd "$PLUGIN_DIR"
if [ "${1:-}" = "cli" ]; then
  shift
  exec "$NODE_BIN" "$PLUGIN_DIR/src/cli.mjs" "$@"
elif [ "${1:-}" = "install-browser" ]; then
  shift
  exec "$NODE_BIN" "$PLUGIN_DIR/node_modules/playwright-core/cli.js" install --no-shell --no-remove chromium "$@"
elif [ "${1:-}" = "test" ]; then
  shift
  exec "$NODE_BIN" --test test/*.test.mjs "$@"
else
  exec "$NODE_BIN" "$PLUGIN_DIR/src/server.mjs" "$@"
fi
