#!/bin/sh
set -eu
PLUGIN_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PLUGIN_DIR"
if command -v pnpm >/dev/null 2>&1; then
  exec pnpm install --frozen-lockfile --ignore-scripts --store-dir "$PLUGIN_DIR/.local/pnpm-store"
elif [ -x "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm" ]; then
  exec "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm" install --frozen-lockfile --ignore-scripts --store-dir "$PLUGIN_DIR/.local/pnpm-store"
elif command -v npm >/dev/null 2>&1; then
  exec npm install --ignore-scripts --no-audit --no-fund
else
  echo '请安装 Node.js 20+（含 npm）或 pnpm，再运行此脚本。' >&2
  exit 1
fi
