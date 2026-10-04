# 热点榜（GitHub 升星榜）—— 数据管线与日常运维

> 面向「GitHub 项目收藏」模块的 **热点榜** 视图。该模块有两个视图：
> **我的库**（默认，云数据库 `public.projects`）与 **热点榜**（本文件，只读静态情报）。
> 两者互不遮挡，切换按钮在最上方，计数写在按钮上。

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
build/projects.js  →  热点榜视图（20 条全铺，带排名）
                        └─「收进我的库」→ 写进云库 public.projects
```

## 两个榜怎么排的（2026-10-04 改版）

界面右上角有一组 tab，切换排序口径；两个榜用的是**同一份数据**，只是排序键不同。

| tab | 排序键 | 口径说明 |
|---|---|---|
| 升星速度（默认） | `hotGain()` | 日榜项取日增；**只有周榜数据的按「周增 ÷ 7」折算成日均**。不折算的话，周榜项（数值天然大 7 倍）会永远碾压日榜项 |
| 总星数 | `stars` | 按仓库总 Star 降序，看存量不看热度 |

- 主键相等时用副键兜底（升星相同时比总星），保证排序稳定、两次渲染顺序一致。
- 每张卡上同时给出：名次徽标、总星数、日均升星、原始日榜/周榜数字 —— 口径透明，
  排序看起来"不合直觉"时能自己核对。
- 前三名有单独的头部样式（金色名次 + 左侧金边）。
- 榜尾一行写明当前排序口径。

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

# 3) 本地看一眼（两个视图 / 两个榜 / 深浅主题都出图 + 打断言）
python ../_verify/run_hot_board_render.py
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
| 榜上只有 20 条、「一直不变」 | 「热点榜」本身是 `--top 20`，条数固定 | 是设计如此；要看自己收录的东西请切「我的库」 |

## 前端行为约定（改代码前先看）

- 区块状态暴露为 `data-pr-hot-state` = `loading` / `ready` / `empty` / `error`。
  **验收脚本靠它轮询到非 loading 才断言** —— 数据是异步 fetch 的，固定 sleep 会得到假红。
- 热点榜**全铺 20 条**，不再有"前 6 张 + 展开全部"（2026-10-04 改版：榜单独立成视图后，
  挤占主表的问题不存在了，隐藏条目反而让用户以为榜单就 6 条）。
- 「收进我的库」按 `(url || name).toLowerCase()` 去重，**与 Excel 导入同一口径**；
  已存在的不会被覆盖成两份。
- 收进后就是普通库记录：可编辑、可筛选、可导出，`备注` 会记成 `热点推荐 · 日榜 +N`。
- 库视图的导出是**跟随筛选**的：按钮上直接写「导出当前 N 条」，筛选生效时旁边多一个
  「导出全部 M 条」。改导出逻辑时别把这个口径拆散（模板说明书里也是这么写的）。
- ⚠️ `theme.css` 有一条全局 `th,td{white-space:nowrap}`，会被继承进单元格里的段落。
  往表格里塞长文本（简介/备注）必须显式 `white-space:normal`，否则文字横向溢出到隔壁列
  且**不会**触发横向滚动条，肉眼极易放过。
