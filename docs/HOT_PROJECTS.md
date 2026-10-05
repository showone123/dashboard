# 收录项目 / 热点榜 —— 数据管线与日常运维

> 「收录项目」模块有两个视图，**切换按钮在最上方，计数写在按钮上**：
>
> | 视图 | 数据源 | 性质 |
> |---|---|---|
> | **收录项目**（默认） | 云数据库 `public.projects` | **公开只读**，全量铺开、按更新时间倒序 |
> | **热点榜** | 静态资源 `/assets/hot-projects.json` | 只读情报，每晚由脚本重写 |

**2026-10-04 改版要点**：这个分区**去掉了全部写入口**（新增 / 编辑 / 删除 / Excel 导入 /
下载模板 / 云同步状态条）。它现在是一张**纯展示页**：热点排行 + 筛选 + 导出。
写数据这件事从"页面上点"搬到了**运维侧**（见下文「新数据怎么进去」）。

---

## 两条数据流

### A. 热点榜（静态资源，每晚重写）

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
```

### B. 收录项目（云表，运维侧写入）

```
运维侧定时任务（agent 用 db_exec_sql 管理通道，绕过 RLS）
        │  显式带上 owner_id（该通道 auth.uid() 为 NULL，靠 DEFAULT 会撞 NOT NULL）
        ▼
云数据库 public.projects
        │  RLS：projects_public_read（FOR SELECT TO anon, authenticated USING(true)）
        ▼
build/projects.js  →  收录项目视图（全量、按 updated_at 倒序、可筛选、可导出）
```

## 新数据怎么进去（页面上不能写了）

前端已无任何写调用（`verify.py §6.2b` 从源码层面拦 `.insert(` / `.update(` / `.upsert(` /
`.delete(`）。新增收录只有一条路：**运维侧定时任务走 `db_exec_sql` 管理通道**。

```sql
-- mode=write；单条语句一次调用。★ owner_id 必须显式给：
-- 管理通道下 auth.uid() 是 NULL，靠列 DEFAULT 会直接撞 NOT NULL 违约。
INSERT INTO public.projects
  (id, owner_id, added_at, name, url, category, summary, openness, stars, note)
VALUES
  ('p<hot-id>', '2099891421614968832', 'YYYY-MM-DD', 'owner/repo', 'https://github.com/owner/repo',
   'AI / LLM', '一句话简介', '完全开源', 12345, '热点推荐 · 日榜 +N ｜ 商业价值：…')
ON CONFLICT (id) DO NOTHING;
```

去重口径 = `(url || name).toLowerCase()`，与前端"待收录 / 已收录"徽标的判据一致：
**库里已有同 url 的行，就显示「✓ 已收录」**，不需要再插一次。

> 为什么不做成"页面上点一下收进来"：那个按钮属于写入口，本次改版已经删掉；
> 而且"哪些值得收"是判断，不是用户操作 —— 交给每晚的运维任务更合适。

## 两个榜怎么排的

界面右上角有一组 tab，切换排序口径；两个榜用的是**同一份数据**，只是排序键不同。

| tab | 排序键 | 口径说明 |
|---|---|---|
| 升星速度（默认） | `hotGain()` | 日榜项取日增；**只有周榜数据的按「周增 ÷ 7」折算成日均**。不折算的话，周榜项（数值天然大 7 倍）会永远碾压日榜项 |
| 总星数 | `stars` | 按仓库总 Star 降序，看存量不看热度 |

- 主键相等时用副键兜底（升星相同时比总星），保证排序稳定、两次渲染顺序一致。
- 每张卡上同时给出：名次徽标、总星数、日均升星、原始日榜/周榜数字 —— 口径透明，
  排序看起来"不合直觉"时能自己核对。
- 前三名有单独的头部样式（金色名次 + 左侧金边）；榜尾一行写明当前排序口径。

## 收录项目的排序口径（"更新顺序"）

需求原话是「点进去默认按照更新顺序全部显示」，落到代码里就是 `orderOf()` / `sortRows()`：

- 主键取 **`updated_at` 倒序** —— 它才是"更新顺序"；`added_at` 只是"第一次收录的日期"，
  手工补录/回填的数据两者会不一致。
- **兜底不能省**：早期数据与运维侧直插的行可能没有 `updated_at`，
  这时退到 `added_at` 并补 `T00:00:00Z`，让两种格式能直接比字符串。
- 副键 = Star 降序（同日/同秒的用它定序），否则同一份数据两次渲染顺序会漂。
- 两条路径同一口径：服务端 `.order(c, {ascending:false})` 先取，客户端再用同一个
  `sortRows()` 算一遍 —— 表格与导出不会分叉。
- ⚠️ 排序必须**不改原数组**（`slice()` 之后再 sort），否则列表索引会错位。

## 为什么热点数据放在 `assets/` 而不是新开一个 API 路由

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

# 2) 需要的话把新上榜的仓库补进云表（见上文 INSERT 模板，走 db_exec_sql）

# 3) 门禁（会重建 dist/ 并校验热点数据与产物一致）
python verify.py

# 4) 本地渲染验收：两个视图 / 两个榜 / 深浅主题 + 38 条断言
python _verify/run_collection_render.py
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

## 前端行为约定（改代码前先看）

- 区块状态暴露为两个属性，**验收脚本靠它轮询到终态才断言**（固定 sleep 会读到中间态 = 假红）：
  - `data-pr-state` = `loading` / `ready` / `empty` / `error`
  - `data-pr-hot-state` = `loading` / `ready` / `empty` / `error`
- ⚠️ **`loading` 由"读取计数"决定，不能拿 `items.length === 0` 反推**。
  改版时踩过：`open()` 先渲染骨架时 `items` 为空、`loadErr` 也为空，状态位被立刻写成
  `empty`（"暂无收录项目"），而数据还在路上。后果有两个：① 页面先闪一句"暂无收录项目"
  再跳出 22 条，像 bug；② 验收探针等的是「≠ loading」，被这个**假的 empty** 提前放行，
  量到 0 行 —— 排序/筛选/全量铺开一共 6 项断言集体假红。**错的是测量时机，不是页面。**
  修法：`load()` 进出各动一次 `pending`，`renderState()` 只看 `pending > 0`。
- 热点榜**全铺 20 条**，不再有"前 6 张 + 展开全部"。
- 导出是**跟随筛选**的：按钮上直接写「导出当前 N 条」，筛选生效时旁边多一个
  「导出全部 M 条」。改导出逻辑时别把这个口径拆散。
- ⚠️ **导出按钮必须待在右上角动作区 `.pr-actions` 里**（和「刷新数据」并排）。
  它原来挂在 22 行表格下面的工具栏里，得滚到底才看得见 —— 用户直接来问
  "导出按钮去哪儿了"（2026-10-04）。`_verify/run_collection_render.py` 已加两条断言锁住：
  结构上必须在 `.pr-actions` 内，视觉上 rect 必须落在首屏内。别再把导出的
  `data-pr-export-row` 挪回表格下方。
- ⚠️ **导出列 ≠ 页面列**：导出走 `COLS` 那 8 列（与历史 Excel 模板逐列一致，含 `备注`），
  页面是 7 列（多了序号、少了备注列）。两套列不是一回事，别互相改。
- ⚠️ `theme.css` 有一条全局 `th,td{white-space:nowrap}`，会被继承进单元格里的段落。
  往表格里塞长文本（简介/备注）必须显式 `white-space:normal`，否则文字横向溢出到隔壁列
  且**不会**触发横向滚动条，肉眼极易放过（验收脚本量 `scrollWidth > clientWidth` 才抓得住）。

## 常见故障怎么判断

| 现象 | 真正原因 | 怎么确认 |
|---|---|---|
| 页面显示「暂无收录项目」 | 云表真的空 **或** 云实例没接上 | 看状态位文字：`读取失败：…` 才是故障；先跑 `python verify.py` |
| 「读取失败：云服务未就绪」 | `app.js` 忘了把 cloud 实例挂到 `window` | 2026-10-04 真实故障：`cloud` 曾是模块局部变量，SDK 只暴露 `WorkBuddyCloud` ⇒ 页面永远空着却"看着正常"。修法见 `build/app.js` 的 `window.cloud = cloud;` |
| 「读取失败：没有权限读取」 | 迁移 004 没应用 | 跑 004 的自检三条查询（见迁移文件末尾） |
| 页面上「更新于」是很久以前 | 改了 `assets/hot-projects.json` 但没重建 | 比对源文件与 `dist/` 的 sha256 |
| 抓取返回 0 条 | trending 页 DOM 改了（脚本会退回搜索 API 兜底） | 看脚本输出的 `trending daily: N 条` |
| 收集数量只有个位数 | GitHub API 限流（匿名 60 次/时） | 看脚本输出的 `token: 有/无` |
| 热点卡片全没了 | 前端 fetch 被拦或资源被 `BLOCKED` | 浏览器 Network 看 `/assets/hot-projects.json` |
| 榜上只有 20 条、「一直不变」 | 「热点榜」本身是 `--top 20`，条数固定 | 是设计如此；要看收录全集请切「收录项目」 |

## 本地渲染验收

```bash
python _verify/run_collection_render.py          # 38 断言 + 6 张图
python _verify/run_collection_render.py --keep   # 保留 work/ 与原始 DOM dump
```

跑的是**真实产物**（单文件 `index.html` + 真实 `app.js`/`projects.js`），
只把"数据从哪儿来"换成假 SDK；默认身份是**非运营方**（`?op=1` 才是运营方），
并且带一个 `?rls=0` 的对照用例 —— 未应用公开读策略时非运营方必须看到 **0 条**，
用来证明"所有人能看到"是**后端 RLS 策略**起的作用，而不是前端写死了数据。

> 旧脚本 `../_verify/run_projects_render.py` 与 `../_verify/run_hot_board_render.py`
> （在仓库外，不参与 git）的断言基于"我的库 6 张卡 + 展开全部"的旧形态，**已失效**，
> 别再当门禁用 —— 它们的结论会与现在这个页面完全对不上。
