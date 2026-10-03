# 热点推荐（GitHub 升星榜）—— 数据管线与日常运维

> 面向「GitHub 项目收藏」模块顶部的 **热点推荐** 区块。个人库仍是 localStorage，
> 这块是**只读情报**，两种数据互不干扰。

## 数据流

```
GitHub Trending（日榜 + 周榜）
        │  build/refresh_hot.py   ← 每晚跑一次（确定性取数）
        ▼
assets/hot-projects.json            ← 仓库内的源文件（唯一真源）
        │  build/make_app.py        ← assets 白名单里必须包含它
        ▼
dist/assets/hot-projects.json       ← 部署产物（与源文件逐字节一致，verify.py §7 会拦）
        │  GET /assets/hot-projects.json
        ▼
build/projects.js  →  热点推荐区块（默认铺前 6 张，可展开全部）
                        └─「收进我的库」→ 写进 localStorage 个人库
```

## 为什么放在 `assets/` 而不是新开一个 API 路由

`dist/server.py` 的 **sha256 是 contract.json 里的冻结契约**（改它要连带改契约 + 记录原因）。
而 `server.py` 的静态服务本来就放行任意非 `.py`/非隐藏文件，且 `_serve_file` 已处理
`application/json` —— 所以**放一个静态 JSON 就能进前端，一行 server.py 都不用动**。
这和「豆粕看板」用 `assets/soymeal-dashboard.html` 是同一套做法。

## 每晚人工/自动怎么跑

```bash
cd wb-checkout
export no_proxy='*' NO_PROXY='*'          # 本机残留代理会干扰

# 1) 取数（已有商业价值覆盖文件就直接用）
python build/refresh_hot.py --top 20 --biz ../_verify/hot_biz.json

# 2) 门禁（会重建 dist/ 并校验热点数据与产物一致）
python verify.py

# 3) 本地看一眼
python ../_verify/run_projects_render.py
```

`--biz` 覆盖文件（键 = `owner/repo`，三个字段都可选）：

```json
{"obra/superpowers": {"zh": "中文一句话", "biz": "商业价值一句话", "category": "开发者工具"}}
```

**为什么把"商业价值"外置成覆盖文件**：取数、去重、分类、校正星数是**确定性**工作，交给脚本；
「这东西值不值得做、能怎么变现」是**判断**，脚本写不出，由模型每晚产出覆盖文件。
两边职责不混，脚本也就永远可重跑、可测。

## 分类是怎么定的

`refresh_hot.py` 的 `RULES` 是一张**有序**关键词表（先命中的赢）。两个已知坑：

- 「学习资源」必须排在 **AI / LLM 之后**，且不能用裸 `learn` ——
  实测 `vectorize-io/hindsight` 的简介是 "Agent Memory That **Learn**s"，
  会被抢先判成学习资源。
- 关键词分类天生只能给个初判，**要准就在 `--biz` 里用 `category` 覆盖**。

## 常见故障怎么判断

| 现象 | 真正原因 | 怎么确认 |
|---|---|---|
| 页面显示「热点数据没读到」 | `dist/assets/hot-projects.json` 缺失/不合法 | `python verify.py` §7 会直接报 |
| 页面上「更新于」是很久以前 | 改了 `assets/hot-projects.json` 但没重建 | 比对两个文件的 sha256 |
| 抓取返回 0 条 | trending 页 DOM 改了（脚本会退回搜索 API 兜底） | 看脚本输出的 `trending daily: N 条` |
| 收录数量只有个位数 | GitHub API 限流（匿名 60 次/时） | 看脚本输出的 `token: 有/无` |
| 卡片全都没了 | 前端 fetch 被拦或资源被 `BLOCKED` | 浏览器 Network 看 `/assets/hot-projects.json` |

## 前端行为约定（改代码前先看）

- 区块状态暴露为 `data-pr-hot-state` = `loading` / `ready` / `empty` / `error`。
  **验收脚本靠它轮询到非 loading 才断言** —— 数据是异步 fetch 的，固定 sleep 会得到假红。
- 默认只铺 **前 6 张**（`HOT_PREVIEW`）：热点全展开会把「我的库」挤到两屏之外。
- 「收进我的库」按 `(url || name).toLowerCase()` 去重，**与 Excel 导入同一口径**；
  已存在的不会被覆盖成两份。
- 收进后就是普通库记录：可编辑、可筛选、可导出，`备注` 会记成 `热点推荐 · 日榜 +N`。
