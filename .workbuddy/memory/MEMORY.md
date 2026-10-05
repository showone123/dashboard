# 项目长期记忆：铜数据看板（wb-checkout）

## 云数据库（public.projects ＝ 站点上的「收录项目」）
- 应用 ID：`wbapp_SzEJc2waV6zqr78qhIU3M1`；运营方 owner_id：`2099891421614968832`（全表唯一）。
- ⚠️ **用 `workbuddy_cloudservice_db_exec_sql`（mode=write）直插时必须显式给 `owner_id`**：
  该通道下 `auth.uid()` 返回 **NULL**，靠列 DEFAULT 会撞 NOT NULL 违约。
  取法：`SELECT owner_id, count(*) FROM public.projects GROUP BY owner_id`。
  （这与 AGENTS.md「客户端 insert 不得传 owner_id」不冲突——那条约束的是 RLS 下的前端代码路径。）
- 列契约（12 列）：id(text PK, 前端 uid 风格 `p<base36><5随机>`)、owner_id、added_at(text 'YYYY-MM-DD')、
  name、url、category、summary、openness、stars(integer)、note、created_at、updated_at。
- note 的既有写法：`热点推荐 · 日榜 +N ｜ 商业价值：…`；手工补录用 `手动收录 · <许可> · <语言> ｜ 商业价值：…`。
- ★ **读公开、写运营方独占**（迁移 004，2026-10-04 已应用生产）：
  `GRANT SELECT TO anon` + `projects_public_read`（FOR SELECT TO anon, authenticated USING(true)）。
  全库策略 14 条。**前端一律直读云表 → 改数据不需要重新部署**；只有改代码才需 build + verify + 部署。
- ⚠️ **前端已无任何写入口**（2026-10-04 改版删净）。新收录只能由运维侧用管理通道写：
  见 `docs/HOT_PROJECTS.md` 的 INSERT 模板。

## 热点榜单（assets/hot-projects.json）
- 每晚由 `build/refresh_hot.py` 全量重写（trending 日榜∪周榜 → 去重 → 按热度取前 20），
  **手工加进去的条目会在下次刷新时被冲掉**；想长期留档要收进 public.projects。
- ⚠️ **热点榜永远是 20 条**（脚本 `--top 20` 写死），页面上**全铺 20 张卡**（旧版"6 张 + 展开全部"
  已随 2026-10-04 改版删除，`HOT_PREVIEW` 与「展开全部」在产物里已不存在）。
  用户说「网站上一直只有 20 个」通常指这个数字，**不是没上线**；
  判断上线与否要看 `assets/hot-projects.json` 的 `updated_at` 与 index.html 的字节比对。
- 「收录项目」统计卡的数字＝云表行数（2026-10-04 为 22），与热点榜的 20 是两回事，别混。

## 前端（build/projects.js）结构约定（2026-10-04 深夜版）
- 模块只有一个只读展示页 + 两个视图：`data-pr-view` = `"all"`（收录项目，**默认**，云表全量）
  与 `"hot"`（热点榜，静态 JSON）。由 `renderView()` 切 `.pr-pane[hidden]`，计数写在切换按钮里。
  ⚠️ `render()` 里 `renderView()` 必须**最先**调用（它负责往根节点写 `data-pr-view`）。
- 默认排序 = **"更新顺序"**：`orderOf()`/`sortRows()` 取 `updated_at` 倒序，缺则退
  `added_at + 'T00:00:00Z'`，副键 Star 降序；纯函数、**不改原数组**（`slice()` 后再 sort）。
- ⚠️ **加载状态必须由读取计数 `pending` 决定**，不能拿 `items.length === 0` 反推：
  否则首帧会写成 `empty`（先闪"暂无收录项目"），而验收探针等的是「≠ loading」，
  会被这个假 empty 提前放行并量到 0 行（2026-10-04 一次 6 项假红就是它）。
- ⚠️ **导出按钮必须常驻右上角 `.pr-actions`**（和「刷新数据」并排）。它曾被放在表格下方工具栏，
  22 行表格要滚到底才看得见 ⇒ 用户直接问"导出按钮去哪儿了"。验收已加两条断言锁住
  （结构上在 `.pr-actions` 内 + rect 在首屏内）。
- ⚠️ **导出列 ≠ 页面列**：导出走 `COLS` 8 列（历史 Excel 契约，含备注）；页面是 7 列（有序号、无备注）。
- ⚠️ **`theme.css` 有一条全局 `th,td{white-space:nowrap}`**，会被继承进单元格里的段落。
  往表格塞长文本必须显式 `white-space:normal`，否则横向溢出到隔壁列、且不出滚动条，肉眼发现不了。
  验收脚本靠量 `scrollWidth > clientWidth` 才抓得住。
- ⚠️ `app.js` 必须 `window.cloud = cloud;` —— `projects.js` 读的是 `global.cloud`，
  而 SDK 只暴露 `WorkBuddyCloud`。漏了这句，页面会**静默空表**且看不出任何异常（2026-10-04 修）。

## 本地渲染 / 验收
- `python verify.py` —— 门禁 **59 项**（含 §6.2b：projects.js 只读哨兵，扫 `.insert(/.update(/.upsert(/.delete(`）。
- `python _verify/run_collection_render.py [--keep]` —— 渲染验收 **41 条断言 + 6 张图**。
  真实产物 + 忠实假 SDK（默认**非运营方**，`?op=1` 才是运营方）+ 无头 Chrome；
  带 `?rls=0` 对照用例（未应用公开读策略时非运营方必须看到 0 条）。
- 两个脚手架坑（已修，别再踩）：`hold.png` 的就绪标记必须按 `?run=N` **按次握手**（共享 Event 会让
  第二个用例之后提前放行、DOM 被拍走）；桩的参数解析**不能用 `!flag('op', false)`**（默认身份会变成运营方 ⇒ 假绿）。
- 仓库外的 `../_verify/run_projects_render.py` 与 `../_verify/run_hot_board_render.py` 基于旧形态，**已失效**。
