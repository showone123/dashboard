#!/usr/bin/env bash
# =============================================================================
#  构建 + 全量校验（等价于 build.bat）
#  它只是调 verify.py，后者依次完成：
#    环境检查 → 依赖校验 → 重建 → 产物检查 → 静态自检 → 契约检查 → dist 同步检查
#  退出码 0 = 可以部署；1 = 不要部署。
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v python >/dev/null 2>&1; then
  echo "[错误] PATH 里找不到 python。请安装 Python 3.8+ 并加入 PATH。" >&2
  exit 1
fi

echo "运行 verify.py ..."
echo
set +e
python verify.py
RC=$?
set -e
echo

if [ "$RC" -ne 0 ]; then
  echo "[失败] verify.py 退出码 $RC —— 不要部署。"
  echo "       按上面的失败项修完，再跑一次本脚本。"
  exit "$RC"
fi

echo "[OK] 全部通过，dist/index.html 已同步。"
echo "     下一步：在 WorkBuddy 里说「覆盖上线」，部署 dist/ 目录。"
