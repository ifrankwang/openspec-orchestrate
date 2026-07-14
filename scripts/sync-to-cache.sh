#!/usr/bin/env bash
# 将本地源码同步到 opencode GitHub 插件缓存
# cd 到项目根目录后运行

set -euo pipefail

CACHE_DIR="$HOME/.cache/opencode/packages/github:ifrankwang/openspec-orchestrate/node_modules/openspec-orchestrate"

if [ ! -d "$CACHE_DIR" ]; then
  echo "ERROR: Cache directory not found: $CACHE_DIR"
  echo "Run opencode at least once with the plugin loaded to create the cache."
  exit 1
fi

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

rsync -a --delete \
  --exclude=node_modules \
  --exclude=.git \
  "$PROJECT_DIR/" \
  "$CACHE_DIR/"

echo "Synced workspace → $CACHE_DIR"
echo "Restart opencode for changes to take effect."
