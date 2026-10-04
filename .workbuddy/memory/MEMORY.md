# 项目长期记忆：铜数据看板（wb-checkout）

## 云数据库（public.projects ＝ 站点上的「我的库 / 收录项目」）
- 应用 ID：`wbapp_SzEJc2waV6zqr78qhIU3M1`；运营方 owner_id：`2099891421614968832`（全表唯一）。
- ⚠️ **用 `workbuddy_cloudservice_db_exec_sql`（mode=write）直插时必须显式给 `owner_id`**：
  该通道下 `auth.uid()` 返回 **NULL**，靠列 DEFAULT 会撞 NOT NULL 违约。
  取法：`SELECT owner_id, count(*) FROM public.projects GROUP BY owner_id`。
  （这与 AGENTS.md「客户端 insert 不得传 owner_id」不冲突——那条约束的是 RLS 下的前端代码路径。）
- 列契约（12 列）：id(text PK, 前端 uid 风格 `p<base36><5随机>`)、owner_id、added_at(text 'YYYY-MM-DD')、
  name、url、category、summary、openness、stars(integer)、note、created_at、updated_at。
- note 的既有写法：`热点推荐 · 日榜 +N ｜ 商业价值：…`；手工补录用 `手动收录 · <许可> · <语言> ｜ 商业价值：…`。
- 前端（build/projects.js）直接读写该表，**改数据不需要重新部署**；只有改代码才需 build + verify + 部署。

## 热点榜单（assets/hot-projects.json）
- 每晚由 `build/refresh_hot.py` 全量重写（trending 日榜∪周榜 → 去重 → 按热度取前 20），
  **手工加进去的条目会在下次刷新时被冲掉**；想长期留档要收进「我的库」（public.projects）。
- ⚠️ **「热点推荐」板块永远是 20 条**（脚本 `--top 20` 写死），且首页默认只展开 6 张卡（`HOT_PREVIEW = 6`），
  点「展开全部」才看全。用户说「网站上一直只有 20 个」通常指这个板块，**不是没上线**；
  判断上线与否要看 `assets/hot-projects.json` 的 `updated_at` 与 index.html 的 sha256。
- 「收录项目」统计卡的数字＝我的库行数（当前 22），与热点榜单的 20 是两回事，别混。

## 前端（build/projects.js）结构约定（2026-10-04 改版后）
- 模块有**两个视图**：`data-pr-view="lib"`（我的库，默认）与 `"hot"`（热点榜）；
  由 `renderView()` 切 `.pr-pane[hidden]`，切换按钮计数写在按钮里。
- 热点榜排序：`hotGain()`＝日均升星（有日增取日增，只有周增则 ÷7），`hotRank(list, 'gain'|'stars')`
  —— 排序必须**不改原数组**，否则「收进我的库」按钮上的 `list.indexOf(h)` 索引会错位。
- ⚠️ **`theme.css` 有一条全局 `th,td{white-space:nowrap}`**，会被继承进单元格里的段落。
  往表格塞长文本必须显式 `white-space:normal`，否则横向溢出到隔壁列、且不出滚动条，肉眼发现不了。
  验收脚本靠量 `scrollWidth > clientWidth` 才抓得住（`_verify/run_hot_board_render.py` 已内置）。
- 本地渲染/验收：`python ../_verify/run_hot_board_render.py`（37 条断言 + 6 张图）。
  旧的 `_verify/run_projects_render.py` 断言基于"热点 6 张卡 + 展开全部"，**已失效**。
