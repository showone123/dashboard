#!/usr/bin/env bash
# =============================================================================
#  本地启动 http://localhost:3000
#
#  ⚠️ 前端直连的是**线上云服务**（endpoint 写死在 build/app.js 里），
#     本地做的增删改会真的写进线上数据库。隔离做法见 docs/API.md §7。
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f dist/index.html ]; then
  echo "[错误] dist/index.html 不存在，请先跑 build.sh 或 build.bat。" >&2
  exit 1
fi

echo "服务 dist/ 于 http://localhost:3000  （Ctrl+C 停止）"
echo
exec python dist/server.py
