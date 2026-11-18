#!/bin/sh
set -eu
PLUGIN_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PLUGIN_DIR"
case "${1:-}" in
  '') ;;
  --with-browser) ;;
  *) echo '用法：sh bin/setup.sh [--with-browser]' >&2; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then
  echo '用法：sh bin/setup.sh [--with-browser]' >&2
  exit 2
fi
if command -v pnpm >/dev/null 2>&1; then
  pnpm install --frozen-lockfile --ignore-scripts --store-dir "$PLUGIN_DIR/.local/pnpm-store"
elif [ -x "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm" ]; then
  "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm" install --frozen-lockfile --ignore-scripts --store-dir "$PLUGIN_DIR/.local/pnpm-store"
elif command -v npm >/dev/null 2>&1; then
  npm install --ignore-scripts --no-audit --no-fund
else
  echo '请安装 Node.js 20+（含 npm）或 pnpm，再运行此脚本。' >&2
  exit 1
fi
if [ "${1:-}" = "--with-browser" ]; then
  exec sh bin/launch.sh install-browser
fi
