# 铜数据看板 · 订阅版 —— 源码交付包

> 交付用途：把本项目的一部分开发工作迁移到 Codex（或任何其他开发环境）继续做。
> 本包**自包含、可独立重建**：不依赖原工作区的任何其他文件。

---

## ⚡ 如果你是从 Codex 过来的：你要的东西在哪

| 你要的 | 在哪 | 备注 |
|---|---|---|
| 完整源码 | `build/`（6 个源文件）+ `dist/server.py` | 见 §2 目录结构 |
| 依赖文件 | `requirements.txt`（Python 工具链）、`deps.lock.json`（前端 3 个依赖 + SHA-256）、`vendor/`（已下载的锁定副本） | **没有 npm 依赖树** —— 没有 `package.json`、没有 `node_modules`。工具：`python vendor_deps.py` |
| 数据库结构 | `db/DB_SCHEMA.sql`（带注释快照） | 含 4 表 / 11 条 RLS 策略 / 授权 / 变更历史 |
| 数据库迁移文件 | `migrations/001_init.sql`（初始，已应用） | 要改结构就**新增** `00N_*.sql`，别改 001。见 `migrations/README.md` |
| `.env.example` | 仓库根 `.env.example` | ⚠️ 本项目**没有服务端密钥**，里面的值都可公开。**不要把它放进 `dist/`**（会导致发布被拒） |
| 构建和启动说明 | `docs/BUILD.md` | 也提供了一键脚本 `build.sh` / `build.bat` / `start.sh` / `start.bat` |
| 前后端 API 地址 | `docs/API.md` | ⚠️ 先读开头：**本项目没有自建后端**，前端直连云服务 |
| 重新部署步骤 | `docs/DEPLOY.md` | 含部署参数、验收清单、回滚 |
| GitHub 自动部署 | ❌ **不支持** | 结论 + 理由 + 替代方案见 `docs/DEPLOY.md` §0 |
| **改完怎么稳定回来部署** | `docs/HANDOFF.md` + **`python verify.py`** | ← 这个才是最关键的，见下 |

### 最关键的答案：`python verify.py`

在这个没有类型系统、没有 linter、没有 CI 的单文件项目里，**唯一能拦住"静默破坏"的关卡就是它**。
Codex 改完 → 源码回传 → 跑它 → **绿了才部署**。

```bash
python verify.py      # 35 项检查；退出码 0 = 可以部署，1 = 不要部署
```

它按顺序做：环境检查 → 依赖校验（SHA-256）→ 重建 → 产物检查 → 3 个静态自检 →
**契约检查** → 部署目录同步检查。

「契约检查」是核心：它会逐项比对 `contract.json`，抓出那些**本地看不出、线才暴露**的改动 ——
比如往 insert 里加回 `created_by`（曾导致线上 `invalid input syntax for type uuid` 事故）、
改 Excel sheet 名（已交付客户的模板会静默失效）、改通知的 localStorage 键名（老用户已读记录全丢）。
已做过负向测试：故意注入 4 处破坏，它全部拦下并返回退出码 1。

**别为了让 verify 变绿去改 `contract.json`** —— 那是把告警关掉，不是修问题。见 `docs/HANDOFF.md` §4。

---

## 0. 一句话说明这是什么

一个**零构建工具链**的单页应用：客户上传一份 Excel，前端在浏览器里解析、渲染成专业期货数据看板，并支持导出（单文件 HTML / PNG 长图）。带订阅制权限门禁、站内通知、运营后台。

技术形态是刻意的选择，不是权宜之计：

- **没有 npm / webpack / vite / TypeScript**。源码就是几个 `.js` / `.css`，用一个 Python 脚本拼成一个 `index.html`。
- **运行时只有 3 个前端依赖**：WorkBuddy Cloud SDK、SheetJS(xlsx)、JSZip。除此之外零外部请求。
  锁定清单见 `deps.lock.json`，本地副本在 `vendor/`。
- 整个应用 = **一个 HTML 文件**（约 244 KB），部署 = 把这个文件放进一个静态目录。

> 云服务 SDK 已固定为 `0.1.1-dev.111acaf.202609102031`，并由 `deps.lock.json`
> 和 `vendor/index.global.js` 的 SHA-256 共同校验。升级时必须同时更新三处并重新验收登录链路。

这么做的原因：交付对象是「双击就能用」的散户级用户，且服务端只需要一个能兜底的静态服务器。改造成现代前端工程是可以的，但**先确认这是你要做的方向**——收益主要是工程体验，功能上目前没有瓶颈。

---

## 1. 30 秒上手

环境要求：Python 3.8+（本机用的是 3.13）。**不需要 Node 工程链。**

```bash
# ① 一键：构建 + 全部校验（推荐，改完代码就跑这个）
python verify.py
#    → 退出码 0 = 可以部署；1 = 不要部署
#    本包交付时：35 项通过 / 0 警告 / 0 失败

# ② 本地跑起来（verify.py 已同步 dist/index.html）
python dist/server.py
#    然后打开 http://localhost:3000

# ③ 装有 Python 的机器也可以直接双击脚本
#    build.bat / build.sh  ← 等价于 ①
#    start.bat / start.sh  ← 等价于 ②
```

只想手动分步跑（排查问题时有）：

```bash
python build/make_app.py                      # 重建：同时生成根目录与 dist/index.html
python build/check_hazard.py                  # 内联 JS 里有没有未转义的 </script>
python build/check_wiring.py                  # HTML 的 id 与 app.js 的 getElementById 是否对得上
python build/probe_scripts.py ../index.html   # 每个 <script> 块是否语法完整
```

> `218586` 是**字符数**不是字节数（`make_app.py` 打印的是 `len(str)`）。
> 文件里有大量中文，UTF-8 落盘后是 **244153 字节**。别把这个数字当"文件被截断了"。

验证包本身没缺件（推荐先跑一次，确认基线是绿的）：

```bash
python verify.py && cmp index.html dist/index.html && echo OK
```
> 本包交付时已跑过：导出包重建出的 `index.html` 与原工作区产物**字节完全一致**；
> 并且**解压 zip 后重新构建**同样字节一致（证明包自包含）。

---

## 2. 目录结构

```
copper-dashboard-src/
│
├── ★ 交接文档区 ─────────────────────────────────────────────
├── README.md                    ← 本文件（总览 / 上手 / 架构 / 契约 / 技术债）
├── docs/
│   ├── HANDOFF.md               ★ 回传闭环：Codex 改完怎么稳定回到可部署状态
│   ├── BUILD.md                 构建与启动说明 + 排错速查
│   ├── API.md                   前后端 API 地址（含"本项目没有自建后端"的说明）
│   └── DEPLOY.md                重新部署步骤 + 验收清单 + 回滚 + GitHub 结论
│
├── ★ 门禁与契约（本项目质量控制的核心）─────────────────────
├── verify.py                    ★★ 一键回传门禁，35 项检查。绿了才能部署
├── contract.json                ★ 「不可破坏契约」基线，verify.py 逐项比对它
├── deps.lock.json               外部依赖锁定清单（固定版本、文件大小与 SHA-256）
├── vendor_deps.py               依赖校验 / 重下载 / 离线化工具
│
├── ★ 一键脚本 ───────────────────────────────────────────────
├── build.bat / build.sh         → verify.py（构建 + 全量校验）
├── start.bat / start.sh         本地起服务 http://localhost:3000
├── .env.example                 可配项说明（⚠️ 里面都不是秘密，见文件头注释）
├── requirements.txt             构建工具链依赖（只有 openpyxl；运行时不需要）
├── .gitignore                   已配好：构建产物与截图不入库
│
├── ★ 源码 ──────────────────────────────────────────────────
├── build/                       ← 改代码都在这里
│   ├── ── 运行时源码（会被拼进 index.html）──
│   ├── theme.css                 设计变量（配色 / 字体 / 间距 / 明暗）
│   ├── app.css                   组件样式（卡片 / 表格 / 弹窗 / 通知 / 表单）
│   ├── render.js                 看板渲染引擎（CuRender：把数据变成 DOM）
│   ├── parser.js                 Excel → 标准数据结构（CuParser）★ 含对客户的 sheet 契约
│   ├── exporter.js               成果导出引擎（CuExport：单文件 HTML / PNG 长图）
│   ├── app.js                    ★ 应用主逻辑（认证 / 门禁 / 上传 / 历史 / 运营台 / 通知）
│   │
│   ├── ── 数据与生成器 ──
│   ├── copper_data.py            canonical 数据生成器（唯一数据源头）
│   ├── copper_data.json          canonical 数据（被 make_app.py 内嵌为示例数据）
│   ├── make_app.py               ★ 组装 index.html（构建入口）
│   ├── make_excel.py             反向导出「客户上传用」Excel 模板 → outputs/
│   ├── make_dashboard.py         轻量单文件看板（只有渲染，不带订阅逻辑）
│   │
│   ├── ── 自检（静态，秒级）──
│   ├── check_hazard.py           查未转义的 </script> / </style>
│   ├── check_wiring.py           DOM id ↔ JS 引用 一致性
│   ├── probe_scripts.py          每个 <script> 块语法完整性（需 node）
│   │
│   └── ── 端到端测试台（生成 HTML，用无头 Chrome 跑）──
│       ├── make_notiftest.py     通知模块 + 验证码冷却（★ 最重要的测试）
│       ├── make_authtest.py      登录/注册分段控件切换
│       ├── make_authflow.py      登录链路（含"账号无密码"分支）
│       ├── make_authprobe.py     探针：打印 SDK 递回来的真实 error 对象
│       ├── make_exporttest.py    导出引擎（单文件 HTML / 长图）
│       ├── make_exportui.py      导出二级界面视觉预览
│       └── make_test.py          Excel(base64) → CuParser 往返一致性
│
├── ★ 部署 ──────────────────────────────────────────────────
├── index.html                   构建产物（= dist/index.html）。可直接双击打开
├── dist/
│   ├── server.py                ★ 部署用静态服务器（带兜底路由；sha256 被门禁锁定）
│   └── index.html               部署产物（server.py 读它；上传的就是这个目录）
│
├── ★ 数据库 ────────────────────────────────────────────────
├── db/
│   └── DB_SCHEMA.sql            期望状态快照：表 / RLS 策略 / 授权 / 变更历史
├── migrations/
│   ├── README.md                迁移机制：怎么执行、编号约定、6 条注意事项
│   ├── 001_init.sql             初始迁移（已应用）★ 不要再执行、不要再修改
│   └── _applied.md              执行记录 + 验证证据
│
├── ★ 依赖与数据 ────────────────────────────────────────────
├── vendor/                      3 个前端依赖的锁定副本（离线构建用）
└── outputs/
    └── 铜期货源数据_20260915.xlsx   数据契约样例（make_test.py 也用它做往返测试）
```

### 未包含的内容（原工作区里有，但属于产物而非源码）

| 文件 | 为什么没带 |
|---|---|
| `build/*_test.html`、`*_flow_*.html`、`*_shot_*.html` | 测试台生成物，跑对应 `make_*` 脚本会重新产出 |
| `build/*.png`、`outputs/*.png` | 截图验收证据 |
| `live2.html`、`outputs/index_rollback_*.html` | 上线前的回滚快照（209520 字节，通知功能上线前的版本）。**回滚清单见 `docs/DEPLOY.md` §5** |
| `build/out_export.html`、`roundtrip.html` | 测试产物 |
| `.wbapp_SzEJc2waV6zqr78qhIU3M1.genie` | 宿主机的应用绑定文件（只有 `appId` / `name` / `localDir` / `appType` 四个字段），属于环境不属于代码。部署参数已写在 `docs/DEPLOY.md` |
| `build/sdk.js` | 早期为排查网络问题下载的 SDK 本地副本，无任何代码引用。**已作为锁定副本改名为 `vendor/index.global.js`**（实测与当前 CDN 版本字节完全一致） |

> 上表是给接手方看的：**这些不是被打包漏了**，是刻意的「源码 / 产物」切分。

---

## 3. 运行时架构

### 3.1 构建链（`build/make_app.py`）

就一件事：把 7 个文件按顺序拼进一个 HTML 模板。

```
index.html = TPL(
    theme.css + app.css +
    <script>render.js</script> + <script>parser.js</script> +
    <script>exporter.js</script> + <script>copper_data.json</script> +
    <script>app.js</script>
)
```

三个必须知道的细节：

1. **`copper_data.json` 内嵌时要转义 `<` → `\u003c`**（`make_app.py` 已处理）。JSON 里只要出现字面量 `</script>`，HTML 解析器会当场结束脚本块。
2. **拼接不是替换 `</body>`**。`exporter.js` 的模板字符串里就含字面量 `</body>`，用字符串 replace 注入会插进 JS 源码里把脚本搞坏。所有测试台脚本因此都用「追加到文件末尾」的方式注入。
3. **构建同时写入根目录 `index.html` 与 `dist/index.html`**。两份内容必须字节一致；`verify.py` 会检查。

### 3.2 模块职责

| 文件 | 全局导出 | 职责 | 不要在这里做的事 |
|---|---|---|---|
| `theme.css` | — | 设计变量：配色、字体、间距、明暗主题 | 不要写组件样式 |
| `app.css` | — | 组件样式：卡片、表格、弹窗、通知、表单 | 不要硬编码颜色，用 theme.css 的变量 |
| `render.js` | `CuRender` | 纯渲染：把标准数据结构变成 DOM | **不要碰网络与状态**（无副作用是它的价值） |
| `parser.js` | `CuParser` | 纯转换：Excel workbook → 标准数据结构 | 不要碰 DOM |
| `exporter.js` | `CuExport` | 纯输出：数据结构 → 单文件 HTML / PNG 长图 | 不要碰网络 |
| `app.js` | `window.CuAuth` | 唯一有状态、唯一碰网络的一层 | 不要往里塞渲染细节 |

`app.js` 是一个 **IIFE，内部用闭包共享 `S`（状态对象）**，通过 `$()` = `getElementById` 拿 DOM。没有模块系统，没有 import/export。分段注释清楚地标出了 8 个区块，改哪个功能直接跳到对应段：

| 行号附近 | 区块 |
|---|---|
| 98 | 认证界面（登录/注册 + 验证码 60 秒冷却 + 无密码账号引导） |
| 410 | 权限校验（`refreshIdentity` / `loadGrant` / `evalGrant` / `renderGate`） |
| 517 | 会话 |
| 548 | 进入应用（`boot`） |
| 611 | Excel 解析 → 渲染数据（调 `CuParser`） |
| 695 | 历史数据（上传记录列表） |
| 836 | 运营台（客户审批 / 数据管理） |
| 919 | 成果导出（调 `CuExport`） |
| 1035 | 消息通知（★ 见 3.4） |
| 1424 | 绑定事件（所有 `addEventListener` 集中在这里） |
| 1564 | 启动（`start()` → `bind()` → `boot()`） |

### 3.3 启动流程

`start()` 有**两道 CDN 健康检查**，失败时把整个 body 换成一句中文提示（而不是白屏）：

```
SDK 加载失败：无法访问 CDN。请检查网络后刷新页面。
Excel 解析库加载失败：无法访问 CDN。请检查网络后刷新页面。
```

通过后：`bind()`（绑事件）→ `boot()`：

```
boot()
 ├─ refreshIdentity()        拿 user.id / email
 ├─ loadGrant()              查 access_grants；首次登录自动插一条 pending 申请
 ├─ evalGrant(grant)         判定：active / pending / suspended / expired / none
 ├─ 不通过 → show('viewGate') 红色门禁页（标题 + 中文下一步 + "重新检查"按钮）
 └─ 通过   → show('viewApp')
             ├─ loadNotifs()         拉通知列表
             ├─ loadDatasets()       拉历史上传
             └─ switchTab('dash')    → 触发通知自动弹出（见 3.4）
```

### 3.4 通知模块（最近新增，逻辑最绕，重点看）

三个子功能：**铃铛浮窗**、**运营台发布**、**进首页自动弹出**。

#### 设计要点：一个通知有两种"已读"状态，必须分开记

| 状态 | 含义 | localStorage 键 | 影响 |
|---|---|---|---|
| **seen**（看过） | 用户打开过通知列表/详情 | `cu_notif_seen_at.<userId>` | 决定**红点**是否亮 |
| **popped**（弹过） | 这条已作为浮窗自动弹给用户 | `cu_notif_popped.<userId>`（存 id 列表） | 决定**是否还会自动弹** |

两个键都**带用户 ID 后缀**（`lsKey(base) = base + '.' + (S.userId || 'anon')`）——同一台浏览器换账号登录时，读过/弹过不能串号。

> 为什么必须分开：如果只记一个"已读到时间戳"，那么"用户点开列表看了一眼但没点开详情"就会把自动弹出也一起消费掉；反之如果只记弹过，红点又会永远不灭。这两个语义在设计上是正交的。

#### 自动弹出的触发点（`switchTab`）

用户要求的三种场景（刚登录进主页 / 从别的页切回主页 / 主页刷新）统一收敛成一条规则：**进入 `dash` 且之前不在 `dash`**。

```js
function switchTab(name) {
  var was = curTab;
  curTab = name;
  ...
  if (name === 'dash') {
    if (was !== 'dash') {                 // 从别的 tab 切回 → 武装
      autoPop.armed = true;
      loadNotifs().then(scheduleAutoPopup);
    }
  } else {
    autoPop.armed = true;                 // 离开首页时，重新武装（下次回来还会弹）
    clearTimeout(autoPop.timer);
  }
}
```

- 刷新页面 → `boot()` 末尾 `switchTab('dash')`，`was=''` ≠ `'dash'` → 触发。
- 刚登录 → 同一条路径。
- `scheduleAutoPopup()` 延迟 450ms，避开首屏渲染抖动。
- **一次只弹最新的一条**，多条新的不连弹 N 个窗（那是骚扰）。底部按钮告诉用户还剩几条：`知道了（还有 N 条新通知）`。
- 弹出的是列表里的**最新一条**，弹过即写 `popped`。

#### 运营台发布

- 只对 `operators` 表里登记过的用户可见（`S.isOperator`）。
- `published=false` 存草稿：草稿在列表里对普通用户不可见（RLS 兜底），也不参与自动弹出（`pendingPopups()` 里过滤）。
- `saveNotif()` 的 insert 字段集**恒为** `{ title, body, level, published, updated_at }`——
  **不含 `created_by`**，交给列默认值 `auth.uid()`。这是踩过坑之后的强约束，见 `db/DB_SCHEMA.sql` 的变更历史。

#### 已修的一个隐蔽 bug（Codex 别改回去）

点「查看全部新通知」(`#nMore`) 时，面板刚打开就立刻被关掉。根因：点击事件冒泡到 `document` 上的"点空白处关闭"处理器，而那个处理器只把面板本身算作"内部"，没把新打开的 `#nModal` 算进去。
修复 = 按钮上 `e.stopPropagation()` **且** document 处理器把 `#nModal` 纳入"内部"判断。**两处都要**，只做一处会残留边界情况。

---

## 4. 云服务接入约定

### 4.1 凭据（可安全下发给前端）

```js
var PUBLIC_CONFIG = {
  endpoint: 'https://data-dashboard-85191.app.workbuddy.host',
  publishableKey: 'wbpk_SzEJc2waV6zqr78qhIU3M1_EsOOC55rzH5Grlz0kErY9VMacOE30GRa'
};
var cloud = WorkBuddyCloud.createWorkBuddyCloud({
  endpoint: PUBLIC_CONFIG.endpoint,
  publishableKey: PUBLIC_CONFIG.publishableKey
});
```

- `applicationId` = `wbapp_SzEJc2waV6zqr78qhIU3M1`
- SDK：`https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@0.1.1-dev.111acaf.202609102031/lib/index.global.js`（固定版本）
- 三件套：`cloud.auth`（登录/注册/会话）、`cloud.database`（PostgREST 风格查询构造器）、`cloud.storage`（文件上传）

### 4.2 REST 直连（调试用）

```
POST {endpoint}/.cloud/database/rest/<table>
Header: x-wb-webapp-access-key: <publishableKey>
        Content-Type: application/json
```

⚠️ **请求头必须是 `x-wb-webapp-access-key`，不是 `apikey`**。用错头会返回 `invalid_client`，看起来像鉴权配置坏了，其实只是头名不对。

⚠️ 本项目自己的 `server.py` 对 `/.cloud/*` 一律返回 404（不处理，交回网关），避免用 HTML 兜底页把登录接口遮蔽掉。

### 4.3 数据库

完整结构见 **`db/DB_SCHEMA.sql`**（表结构 / 11 条 RLS 策略 / 表级授权 / 自检 SQL / 变更历史）。四张表：

| 表 | 作用 | id 生成方式 |
|---|---|---|
| `access_grants` | 订阅授权：状态、套餐、到期时间 | `GENERATED ALWAYS AS IDENTITY` |
| `datasets` | 用户上传的 Excel 元信息（文件本体在 storage） | `GENERATED ALWAYS AS IDENTITY` |
| `notifications` | 站内通知（草稿/发布） | `bigserial`（历史遗留不一致，功能等价，别动） |
| `operators` | 运营方白名单 | 主键是 `owner_id`（无 id 列） |

安全模型是 **read-own + operator-override** 两层：

1. **表级授权**（第一道门）：`anon` 全表零权限；`authenticated` 拿最小集（`operators` 只读、`access_grants` 无 DELETE）。
2. **RLS 策略**（第二道门）：普通用户只能碰 `owner_id = auth.uid()` 的行；`operators` 里登记过的用户额外拿到 `access_grants` / `notifications` 的旁路。

**两道门缺一不可**：只建策略不 GRANT → 报 42501，表现得很像"策略失效"；只 GRANT 不建策略 → 任何登录用户都能读写全表。

三个已被特意堵死的提权路径，改动时不要打开：

- `grants_insert_self_pending` 的 `WITH CHECK` 强制 `status='pending' AND plan<>'operator' AND expires_at IS NULL`——否则用户能自己给自己发永久 operator。
- `operators` 表**没有** INSERT/UPDATE/DELETE 策略，且 `authenticated` 只有 SELECT——运营方身份只能从后台写入。
- `authenticated` / `anon` 手上**没有** `TRUNCATE` 和 `REFERENCES`——这两项能绕过 RLS（TRUNCATE 直接清空）。

### 4.4 身份标识（最容易踩的坑）

> **平台下发的 `user.id` 是 19 位数字字符串**（例：`2099891421614968832`），**不是 uuid**。
> 凡是承接 `auth.uid()` 的列，类型必须是 `text`。

线上真实事故：`notifications.created_by` 被建成了 `uuid`（当时是从策略写法 `owner_id = auth.uid()` 反推列类型，想当然了），运营方点发布立刻报

```
保存失败：invalid input syntax for type uuid: "2099891421614968832"
```

**规则**：新建任何承接身份的列之前，先查同类列的类型，**不要从策略写法反推**：

```sql
SELECT table_name, column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND column_name IN ('owner_id','created_by');
```

---

## 5. Excel 数据契约（客户上传侧）

这是**对外接口**，改它等于破坏已有客户的模板。契约由 `build/parser.js` 的 `SHEETS` 常量与 `build/make_excel.py` 共同定义，两侧必须严格一致；`build/make_test.py` 做往返一致性验证。

### 5.1 规则

- **共 22 个 sheet**（1 个「说明」+ 21 个数据 sheet）。sheet 名、表头行、字段名**不得改动**；数值可改；行数可增减。
- **必填 4 张**：`META` / `SUMMARY` / `KLINE` / `CONTRACTS`。其余缺失时对应模块显示为空，不报错。
- **KLINE 最多 400 行**，必须**按日期从旧到新**排列。日期接受 `YYYY-MM-DD` 或 `MM-DD`。
- 全部 sheet 缺失时抛：`未识别到任何数据表。…`
- `KLINE` 无有效行时抛：`KLINE 表没有可用数据行（需要「日期/开盘/最高/最低/收盘/成交量/持仓量」表头）。`
- 解析器**容忍表头位置漂移**：优先按中文表头名取列，取不到则回退到列序号（`r[ks[4]]` 等），所以客户挪动列顺序不会立刻炸，但**别依赖这个容错**。
- 上传大小上限 **8 MB**（`app.js` 的 `MAX_UPLOAD`）。
- 通知正文上限 4000 字。

### 5.2 三种 sheet 类型

**A. 宽表型**（`类型`/`周期` + 多列指标，首列是分组键）

| Sheet | 表头 |
|---|---|
| `TECH` | 周期、周期价格、指标、数值、方向、综合偏向、标签 |
| `RANK` | 类型、排名、会员、数值、变化 |
| `OPT_STRATEGY` | 策略、项目、内容 |

**B. KV 型**（两列：`字段` / `值`）

| Sheet | 字段 |
|---|---|
| `META` | product、产品名称、交易所、价格单位、主力合约、连续合约、数据日期、生成时间、数据来源、项目、免责声明 |
| `SUMMARY` | 最新收盘、前收盘、涨跌、涨跌幅%、MA5、MA20、ATR14、偏离MA5、偏离MA5%、60日最高、60日最低、本周最高、本周最低、距高点%、成交量、持仓量、持仓变化 |
| `RANK_META` | 前20成交量、前20成交量变化、前20多头、前20多头变化、前20空头、前20空头变化、净多净空差、信号 |
| `WAREHOUSE` | 最新仓单、变化、交易所、日期、解读 |
| `OPTIONS_META` | 标的合约、数据日期、ATM行权价、Call价格、Put价格、CallDelta、标的期货价、MaxPain、HV20、HV60、PCR(OI)、PCR(Vol)、总CallOI、总PutOI、PCR信号、波动率解读 |
| `EXTERNAL` | 品种、代码、最新价、日期、1日涨跌%、5日涨跌%、MA5、MA20、计价单位 |
| `SENTIMENT` | 快照时间、48h条数、24h条数、高影响力事件、当前信号、动量方向、边际变化、中长期、宏观占比说明 |
| `COST` | 计算价格、合约乘数、最小变动价位、开仓手续费、平仓手续费、平今手续费、开平合计、交易所开仓、交易所平仓、交易所开平合计、公司单边费率%、交易所费率%、公司平今费率%、保证金率%、1手保证金、保证金模型 |

**C. 数据表型**（固定表头）

| Sheet | 表头 |
|---|---|
| `KLINE` ★ | 日期、开盘、最高、最低、收盘、成交量、持仓量 |
| `CONTRACTS` ★ | 合约、收盘价、结算价、成交量、持仓量、是否主力 |
| `ROLL` | 组合、价差、年化% |
| `INVENTORY` | 指标、数值、单位、截止日期、备注 |
| `OPTION_CHAIN` | 行权价、Call结算、Call量、Call持仓、CallDelta、Put结算、Put量、Put持仓、PutDelta、是否ATM |
| `RATIOS` | 比价、当前值、10年分位、信号、方向 |
| `TREND` | 序号、铜银比、金银比 |
| `SENTIMENT_WINDOWS` | 窗口、打分、判定、条数 |
| `SENTIMENT_EVENTS` | 评分、标签、时间、内容 |
| `SEASON` | 月份、平均收益率%、胜率% |

`SUMMARY` 缺失时由 `KLINE` 自动推导（收盘序列算 MA / 高低点 / 涨跌）。`META.主力合约` 缺失时，取 `CONTRACTS` 里成交量最大的一行。

---

## 6. 自检与测试

### 6.1 门禁（★ 改完代码第一件该跑的事）

```bash
python verify.py            # 构建 + 全部 35 项检查，退出码 0 = 可以部署
python verify.py --quick    # 跳过依赖相关项（离线环境用）
```

它按顺序做 7 组检查：环境 → 依赖（SHA-256）→ 重建 → 产物 → 静态自检 → **契约检查** → 部署目录同步。

「契约检查」是它存在的理由 —— 抓的是那些**本地看不出、线上才暴露**的改动：

- 往 `.insert({...})` 里加回 `created_by` / `owner_id`（曾导致线上 `invalid input syntax for type uuid`）
- 动 `parser.js` 的 `SHEETS` 列表（已交付客户的 Excel 模板会静默失效）
- 改通知的 localStorage 键名（老用户的已读/已弹记录全丢）
- 改上传上限 / 冷却时间 / 正文上限
- 动 `dist/server.py`（影响坏链接兜底与 `/.cloud` 不被遮蔽）
- 改云服务 `endpoint` / `publishableKey`（等于连错环境）
- 构建产物没有同步到 `dist/index.html`（门禁会阻止部署）

> **已做负向测试**：故意注入 4 处破坏（insert 加回身份列、SHEETS 改名、改键名、改 `server.py`），
> 门禁全部拦下并返回退出码 1，其中还包括由第一处派生的 `dist` 不同步。
> 一个永远不会报错的检查等于没有检查，所以这一步必须验。
>
> ⚠️ **别为了让 verify 变绿去改 `contract.json`**。那不是修问题，是把告警关掉。
> 需要真的变更契约时走 `docs/HANDOFF.md` §5 的流程。

### 6.2 静态自检（单独跑，秒级）

```bash
python build/check_hazard.py                 # 未转义的 </script>
python build/check_wiring.py                 # DOM id 一致性
python build/probe_scripts.py ../index.html  # <script> 块完整性
```

> `probe_scripts.py` 会把相对路径解析到 `build/` 下，所以从仓库根调用时要写 `../index.html`；它需要一个 `node` 来跑 `node --check`，按 **`$NODE_BIN` 环境变量 → 本机托管版 Node → `PATH` 里的 `node`** 顺序查找（已改为可移植，换机器不用改代码）。
> 当前基线：6 个源文件 hazard=0、116 个 DOM id 引用 0 缺失、9 个 script 块 0 断裂。

**为什么需要 `check_hazard.py`**：所有源码都被内联进一个 HTML。JS 字符串里只要出现字面量 `</script>`（比如导出模板里写了结束标签），HTML 解析器会在那里结束脚本块，后面的代码全变成页面文本。这类事故**没有任何报错，只是功能静默消失**，所以必须静态扫描。

### 6.3 端到端测试：假 SDK 法（★ 这是本项目的核心测试手法）

真登录必须走线上域名，本地/无头环境跑不了。于是测试台的做法是：

> 拿**真实的 `index.html`**，把 CDN 的 `<script src>` 换成**同形状的假 SDK**（在 `app.js` 之前注入，所以 `app.js` 拿到的是假 cloud），末尾追加驱动脚本。
> **`app.js` 一行不改** —— 测的是真实代码路径，不是"另写一份逻辑自己证明自己"。

假 SDK 的要点：

- 导出与真 SDK **同名同形状**：`WorkBuddyCloud.createWorkBuddyCloud()` 返回 `{auth, database, storage}`。
- `database.from(t)` 返回一个 **thenable 查询构造器**（支持 `.select().eq().limit()` 链式与 `await`），这样 `app.js` 里的 `await ...select('*').eq('owner_id', id).limit(1)` 能原样跑通。
- 假后端**照抄线上 RLS 语义**实现一遍（含 operator 旁路、草稿对普通用户不可见、`pending` 申请的限制）——否则测试全绿但线上 403。
- 假后端会打印 `insert keys=`，作为**回归哨兵**：字段集一旦被改回包含身份列，立刻能看出来。

```bash
# 跑通知 + 冷却测试（生成 HTML → 无头 Chrome 执行 → 打印断言结果）
python build/make_notiftest.py
# 产物：build/notif_flow_op.html（运营方，34 断言）
#       build/notif_flow_user.html（普通用户，35 断言）
#       build/notif_autopop.html（自动弹出，22 断言）
```

其余测试台同理：`make_authtest.py` / `make_authflow.py` / `make_authtest.py` / `make_exporttest.py` / `make_exportui.py` / `make_test.py`。

### 6.4 无头 Chrome 截图（验收证据）

```bash
"C:/Program Files/Google/Chrome/Application/chrome.exe" \
  --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
  --no-proxy-server --window-size=1280,860 --virtual-time-budget=18000 \
  --screenshot="C:\绝对\ASCII\路径.png" "<url>"
```

两个必踩的坑（都已验证）：

1. **必须加 `--no-proxy-server`**。本机若装了系统代理，无头 Chrome 会走代理访问线上域名然后报 `ERR_CONNECTION_CLOSED`——而同一时刻 `curl` 是正常的，极容易误判成"站点挂了"。
2. **`--screenshot=` 必须是绝对路径，且文件名用 ASCII**。Chrome 进程的工作目录不是 shell 的 cwd，相对路径会报 `0x3 找不到路径`；中文文件名会乱码。

---

## 7. 部署

> 📌 本节是速览。**完整版在 `docs/DEPLOY.md`**（含 GitHub 自动部署的结论、发布前同意规则、
> 失败对照表、回滚清单）。部署前请以那份为准。

用的是 WorkBuddy 的「发布为应用」（`workbuddy_sites_deploy`）。参数：

| 参数 | 值 |
|---|---|
| `applicationId` / `appId` | `wbapp_SzEJc2waV6zqr78qhIU3M1` |
| `localDir` | `<repo>/dist` |
| `language` | `"python"` |
| `startCmd` | `"python server.py"` |
| `domainPrefix` | `"data-dashboard"` |
| 线上地址 | `https://data-dashboard-85191.app.workbuddy.host` |

⚠️ **`startCmd` 必须显式给 `python server.py`**。只声明 `language:"python"` 时，探测逻辑默认去找 `main.py`，于是报 `can't open file '/workspace/main.py'` + `service did not become reachable on port 3000`。**不要为了迁就它把 `server.py` 改名**。

⚠️ 首次发布经常出现一次瞬时失败（`fetch failed` 或 `预留域名未绑定`），**同一套参数重试一次即可成功**。

### 部署步骤

```bash
python verify.py                          # ① 重建、同步并完成全部门禁
# ② 调 workbuddy_sites_deploy 发布
# ③ 上线验收（见下）
```

### 上线验收清单（发布后必做）

```bash
curl -s -o /tmp/_live.html https://data-dashboard-85191.app.workbuddy.host/
cmp /tmp/_live.html dist/index.html && echo "字节一致"       # ① 产物确实上去了
grep -c "cu_notif_popped" /tmp/_live.html                     # ② 新功能标记在

curl -s -o /dev/null -w "%{http_code}\n" https://.../some/bad/path   # ③ 兜底路由 200
curl -s -o /dev/null -w "%{http_code}\n" https://.../.cloud/database/rest/notifications  # ④ 401
```

⚠️ **不要用 `curl | grep -c` 判断**。内容较大时 curl 会 `exit 23 Failed writing body` 被截断，grep 拿到不完整输入 → 返回错误的 0 → 得出"改动没上线"的错误结论（本项目真实踩过）。一律 **先 `curl -o` 落盘，再 `cmp` / `grep 文件`**。

### 回滚

发布前把当前线上产物另存一份（本项目的历史做法是存到 `outputs/index_rollback_<说明>_<日期>.html`），出问题直接把旧文件覆盖回 `dist/index.html` 重新发布。通知功能上线前的版本是 209520 字节。

---

## 8. 给接手者的注意清单 / 已知技术债

### 8.1 改代码前必须知道

1. **改完必须重新 `make_app.py`**。编辑 `build/*.js` / `*.css` 不会影响 `index.html`——那是构建产物。忘了这一步会陷入"改了没生效"的困惑。
2. **不要在源码里写裸的 `</script>`**，写成 `<\/script>`。改完跑 `check_hazard.py`。
3. **不要用 replace 方式往 `index.html` 注入脚本**，追加到末尾。（`exporter.js` 模板里有字面量 `</body>`。）
4. **`app.js` 是单 IIFE 闭包**，没有模块系统。加功能请放到对应的分段区块里，不要引入 ESM（会立刻打破单文件构建）。
5. **SDK 已固定版本**；升级必须同步更新 `deps.lock.json`、`vendor/` 并验收登录链路。
6. **`dist/index.html` 与根 `index.html` 由构建脚本同时生成**，不要手工编辑。
7. **数据库改动一律通过 `db_exec_sql`（mode=migrate）单条语句执行**，不要绕过去。

### 8.2 值得做的改进（按价值排序）

> 注：本次交接已经顺手做掉了几项（见 8.4）。下表是**还没做**的。

| 优先级 | 改进 | 收益 |
|---|---|---|
| 中 | 把 `app.js` 按 8 个区块拆成独立文件，仍由 `make_app.py` 拼接（保持零构建工具链） | 单文件 79 KB 已经偏大，拆分提升可维护性而不改变交付形态 |
| 中 | 把 `node --check` 提升为强依赖（`verify.py` 里 node 缺失目前只 WARN） | 语法错误目前只能靠 `probe_scripts.py` 间接发现 |
| 中 | 给 `dist/` 加一个发布前的体积/内容白名单校验 | `dist/` 一旦混入 `.env` 或依赖清单会导致发布被拒（见 `docs/DEPLOY.md` §1 硬规则 3） |
| 低 | 通知的 `id` 从 `bigserial` 统一为 `GENERATED ALWAYS AS IDENTITY` | 结构一致性；**但需要迁移数据，收益低于风险，可以不做** |
| 低 | `notifications` 分页 / 软删除 | 通知量上来后列表会变长 |

### 8.3 变更历史

| 日期 | 变更 |
|---|---|
| 2026-09-15 | 项目起步：数据看板渲染、Excel 解析、导出引擎 |
| 2026-09-16 | 订阅化改造：认证、权限门禁、运营台、历史数据、RLS 收紧、anon 零权限 |
| 2026-09-16 | 通知模块上线（铃铛浮窗 + 运营台发布 + 进首页自动弹出）+ 验证码 60 秒冷却 |
| 2026-09-16 | 修复 `notifications.created_by` 类型错误（`uuid` → `text`），详见 `db/DB_SCHEMA.sql` |
| 2026-09-17 | 源码交接包：`vendor/` 依赖锁定、`docs/` 四份文档、`migrations/`、`.env.example`、`requirements.txt`、一键脚本 |
| 2026-09-17 | 新增 `verify.py` 回传门禁 + `contract.json` 契约基线（35 项检查，已通过负向测试） |
| 2026-09-17 | `build/probe_scripts.py` 的 Node 路径改为可移植解析（`$NODE_BIN` → 本机路径 → `PATH`） |

### 8.4 本次交接（2026-09-17）新增的东西

给 Codex 侧的改动工作用，与业务功能无关：

| 新增 | 作用 |
|---|---|
| `verify.py` + `contract.json` | **回传门禁**。把"本地看不出、线上才暴露"的契约破坏变成机器可拦的错误 |
| `docs/HANDOFF.md` | 回传闭环流程：谁改哪里、怎么回传、FAIL 了怎么处理、契约变更的正式流程 |
| `docs/API.md` | API 地址与调用面（含"本项目没有自建后端"这个容易误解的点） |
| `docs/BUILD.md` | 构建/启动/测试/排错 |
| `docs/DEPLOY.md` | 部署参数、验收清单、回滚、**GitHub 自动部署不支持的结论** |
| `migrations/` | 数据库从"一个文档"升级为"可执行的初始迁移 + 增量迁移机制" |
| `.env.example` | 集中说明可配项（并澄清本项目没有服务端密钥） |
| `requirements.txt` / `deps.lock.json` / `vendor/` | 依赖清单 + 版本锁定 + SHA-256 校验 + 离线副本 |
| `build.sh` / `build.bat` / `start.sh` / `start.bat` | 一键构建与启动 |
| `.gitignore` | 已配好，可以直接 `git init` 交给版本管理 |
| 2026-09-16 | 导出源码包；`probe_scripts.py` 的 Node 路径改为可移植解析（`$NODE_BIN` → 托管版 → `PATH`） |

---

## 9. 数据流一览（便于快速定位）

```
客户上传 Excel
      │  (app.js 611 段，≤8MB 校验)
      ▼
  SheetJS 解析 workbook
      │
      ▼
  CuParser.build(wb, fileName)          → 标准数据结构（内含 KLINE/SUMMARY/CONTRACTS 容错）
      │
      ├─→ CuRender.*   渲染成看板 DOM      （render.js，纯函数）
      │
      ├─→ CuExport.buildHtml(data)        单文件 HTML（客户可独立分享）
      └─→ CuExport.renderPoster(data)     PNG 长图（Canvas 绘制，供 IM 分享）

同时：文件本体 → cloud.storage，元信息 → datasets 表（供"历史数据"列表回看）
```

---

## 10. 相关文档

| 文档 | 什么时候看 |
|---|---|
| **`docs/HANDOFF.md`** | ★ 改完代码准备交回来时。回传流程、能改/不能改的边界、`verify.py` FAIL 怎么处理、契约变更的正式流程 |
| **`docs/DEPLOY.md`** | 要上线时。部署参数、三条硬规则、验收清单、回滚、GitHub 结论 |
| **`docs/BUILD.md`** | 第一次上手、环境报错、想跑端到端测试时 |
| **`docs/API.md`** | 要碰登录/数据库/存储时。含平台账号模型的硬约束与错误码对照 |
| **`db/DB_SCHEMA.sql`** | 要动数据库时。表结构 + 11 条 RLS 策略全文 + 变更历史 |
| **`migrations/README.md`** | 要加迁移时。执行方式（`db_exec_sql` 单条语句）、编号约定、6 条注意事项 |
| **`contract.json`** | 想看"哪些是不能动的对外承诺"时（`verify.py` 校验的原始依据） |
| 原工作区的 skill 文档（不在本包内）：`~/.workbuddy/skills/workbuddy-cloud-subscription-app/SKILL.md` | 记录了「用云服务做订阅制 Web 应用」这套方法的完整踩坑笔记（建表/RLS/GRANT 三件套顺序、`x-wb-webapp-access-key` 头名、假 SDK 测试法、发布参数、源码交接流程等）。如果 Codex 侧需要，可以一并提供 |
