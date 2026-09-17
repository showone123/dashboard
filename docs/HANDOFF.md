# 回传闭环：Codex 改完的代码怎么稳定回到 WorkBuddy 部署

> 这份文档回答一个具体问题：**在 Codex 里改了代码，怎么保证它安全、可验证地回到能部署的状态。**
> 核心不是"能不能拷贝文件"，而是**怎么自动发现"改坏了但看不出来"**。

---

## 1. 一句话流程

```
Codex 改源码  →  Git 提交/PR  →  python verify.py  →  绿了就「覆盖上线」
                                        │
                                        └─ 红了 → 按提示修 → 重跑（不要直接部署）
```

**唯一纪律：`verify.py` 必须绿。** 它在没有类型系统、没有 linter、没有 CI 的单文件项目里，
是唯一能拦住"静默破坏对外契约"的关卡。

---

## 2. 分工边界：谁改哪里

### ✅ Codex 可以自由改

| 文件 | 内容 |
|---|---|
| `build/app.js` | 应用主逻辑（认证、门禁、上传、历史、运营台、通知） |
| `build/app.css` | 组件样式 |
| `build/theme.css` | 设计变量（配色、字体、间距） |
| `build/render.js` | 看板渲染 |
| `build/exporter.js` | 导出引擎（单文件 HTML / PNG 长图） |
| `build/copper_data.py` + `build/copper_data.json` | 示例数据 |
| `docs/*` | 文档 |
| `migrations/00N_*.sql`（新增） | 数据库增量变更 |

### ⛔ 除非有明确理由，**不要改**

| 文件 | 为什么 |
|---|---|
| `dist/server.py` | 决定坏链接兜底与 `/.cloud` 不被遮蔽两个线上行为。`verify.py` 用 sha256 强校验 |
| `migrations/001_init.sql` | 已应用的初始迁移。改了会让"老环境"与"新环境"分叉。要改结构就**新增** `00N_*.sql` |
| `build/parser.js` 的 `SHEETS` 列表 | **对客户的接口**。改动 = 已交付客户的 Excel 模板批量失效 |
| `db/DB_SCHEMA.sql` / `migrations/001_init.sql` 的策略清单 | 安全模型本身。改动需要同时评估提权风险 |
| `contract.json` | 它不是"期望值"而是**事实基线**。为了让 verify 变绿而改它 = 掩耳盗铃 |
| `dist/index.html` | 生成物。手改会在下次构建时被覆盖，白做 |

### ⚠️ 改之前先想清楚的三处（改了会让 verify FAIL，需要走正式变更流程）

`contract.json` 里 `frozen_contracts` 记录的就是这些：

- `excel_sheets` / `excel_required_sheets` / `kline_max_rows` / `kline_header`
- `db_tables` / `db_policies` / `db_identity_columns_are_text`
- `forbidden_insert_columns`（`created_by` / `owner_id`）
- `max_upload_bytes` / `notif_body_max_chars` / `send_cooldown_ms` / `ls_keys`
- 云服务凭据（`endpoint` / `publishableKey`）

---

## 3. 回传三步

### ① Codex 交付源码树

通过 Git 提交或 PR 交付完整改动，避免 ZIP 和工作目录产生版本漂移。

**交付时请附带**：
- 改了哪些文件（对照 `contract.json` 的 `advisory_baseline_hashes` 能一眼看出）；
- 有没有动数据库（若动了，必须附新的 `migrations/00N_*.sql`）；
- 有没有动对外契约（若动了，需要说明原因和影响面）；
- `python verify.py` 在他那边的输出。

### ② 本地覆盖 + 跑门禁

把源码放回仓库对应位置（`build/` 下的文件放回 `build/`，根目录的放回根目录），然后：

```bash
python verify.py
```

它会重新构建，所以不需要你手动先跑构建。

### ③ 绿了再部署

`verify.py` 已同时生成根目录和 `dist/index.html`。通过后直接在 WorkBuddy 里执行「覆盖上线」。

部署后的验收清单见 `docs/DEPLOY.md` §4。

---

## 4. `verify.py` 红了怎么办

失败分两类，处理方式完全不同。

### A 类「工程问题」——直接修就行

症状举例：构建失败、`check_hazard` 有危险字符、DOM id 对不上、`dist/` 没同步、`vendor/` 哈希不符。

这些都是"代码本身有毛病"，按脚本给出的具体位置修，然后重跑 `verify.py`。
**不要部署。**

### B 类「契约问题」——先判断是有意还是无意

脚本会明确写 `契约被改动`。这类要停下来想：

| 情况 | 处理 |
|---|---|
| **无意的**（改功能时顺手改了 sheet 列表 / 键名 / 限额） | 改回代码符合契约。这是绝大多数情况 |
| **有意的**（业务上确实要改） | 走下面的 §5 正式流程 |

⚠️ **绝对不要**为了让脚本变绿而直接改 `contract.json`。它记录的是"现在的事实"，
不是"我希望的" —— 改了它，等于把告警关掉，然后线上才暴露问题。

---

## 5. 需要变更契约时的正式流程

四件事**必须同时做**（少做一件就是埋雷）：

1. **改代码**（`build/parser.js` / `app.js` / …）。
2. **改 `contract.json`** 里对应的值，并在同一处加一句注释说明"为什么改、什么时候改的"。
3. **若涉及数据库**：新增 `migrations/00N_*.sql`（不要改 `001`），同步更新 `db/DB_SCHEMA.sql`，
   执行完后在 `migrations/_applied.md` 记一行。执行方式见 `migrations/README.md`。
4. **通知已交付的客户**：
   - 改了 Excel 契约（sheet 名 / 表头 / 字段名）→ 客户的模板会失效，**必须**给新模板并说明；
   - 改了 `ls_keys` → 老用户的已读/弹过记录会重置（影响可接受，但要知道）；
   - 改了限额（上传大小 / 正文长度）→ 客户可能反馈"以前能传的文件现在报错了"。

最后重跑 `python verify.py`，应当全绿。

---

## 6. 按需求查表：想改 X，改哪个文件

| 想做的改动 | 改哪里 | 注意 |
|---|---|---|
| 改配色 / 字体 / 间距 | `build/theme.css` | 用变量，别在 `app.css` 里硬编码颜色 |
| 改某个组件样式 | `build/app.css` | ⚠️ 不要动 `.code-row .btn{min-width:114px}` 的防抖设计，那在防验证码按钮宽度跳动 |
| 加一个看板区块 | `build/render.js` + `build/parser.js`（若需要新数据） | 渲染层不要碰网络；改 `SHEETS` 前先读 §5 |
| 加一张 Excel 表 | `build/parser.js`（`SHEETS`）+ `build/make_excel.py` + `contract.json` | **属于契约变更，走 §5**。同时要更新 `build/copper_data.py` 生成示例数据 |
| 改登录 / 注册流程 | `build/app.js` 的 98–410 段 | 先读 `docs/API.md` §3.1 的平台账号模型，别做纯邮箱+密码注册 |
| 改权限门禁 | `build/app.js` 的 410–520 段（`evalGrant` / `renderGate`） | 状态取值 `pending/active/suspended/expired` 与 DB 对应，改一边要改另一边 |
| 改通知功能 | `build/app.js` 的 1035–1424 段 | 先读 README §3.4：`seen` 与 `popped` 是两套语义，`#nMore` 的两处修复缺一不可 |
| 加业务数据接口 | **不是改代码，是加表** → `migrations/00N_*.sql` + `contract.json` | `server.py` 不是后端，不要往里写路由 |
| 改部署服务器行为 | `dist/server.py` | 高风险，改完要同步 `contract.json` 的 sha256 |
| 改对外 API 地址 | `build/app.js` 的 `PUBLIC_CONFIG` | **等于换环境**。改了会连到别的云服务实例，`verify.py` 会拦 |

---

## 7. 交接检查单

**Codex 交付时应当能回答"是"：**

- [ ] 我跑过 `python build/make_app.py`，能成功构建
- [ ] 我跑过 `python build/check_hazard.py`，hazard = 0
- [ ] 我跑过 `python build/check_wiring.py`，没有 JS 引用了但 HTML 不存在的 id
- [ ] 我知道自己动了哪些文件（能对照 `contract.json` 的 `advisory_baseline_hashes` 列出来）
- [ ] 我**没有**改 `dist/server.py`、`migrations/001_init.sql`、`contract.json`
- [ ] 如果我改了 Excel 契约 / 数据库 / 限额 / localStorage 键名，我**明确说明**了并给出了迁移文件
- [ ] 我没有引入 npm 依赖树 / 构建工具链（会破坏单文件交付形态）
- [ ] 我没有在源码里写裸的 `</script>`（要写 `<\/script>`）

**WorkBuddy 侧收到后：**

- [ ] 源码放回正确位置（`build/` 下的回 `build/`，根目录的回根目录）
- [ ] `python verify.py` → 退出码 0
- [ ] `index.html` 与 `dist/index.html` 由构建生成且字节一致
- [ ] 说「覆盖上线」
- [ ] 按 `docs/DEPLOY.md` §4 跑验收清单（含逐字节 `cmp`）
- [ ] 归档一份线上产物到 `outputs/发布归档_<说明>_<日期>.html`

---

## 8. 为什么要这么"麻烦"—— 三个真实事故

这套门禁不是为了流程好看，是为了挡住已经发生过的问题：

1. **`invalid input syntax for type uuid: "2099891421614968832"`（线上，2026-09-16）**
   客户端 insert 携带了 `created_by`，而列被误建成 `uuid`，平台 user.id 是 19 位数字字符串。
   运营方一点发布就报错。**`verify.py` 现在会静态扫描所有 `.insert({...})` 拦住它。**

2. **分享链接暴露 Python 原生 404 页**
   `server.py` 的兜底路由是为了修这个。它不是"多余的几行"，是线上体验的一部分，
   所以被 sha256 锁住。**`verify.py` 会检查 `_serve_index` 与 `/.cloud` 排除还在不在。**

3. **部署成功但页面是旧版本**
   历史流程依赖手工复制，容易把旧文件发布出去。现在 `make_app.py` 同时生成两份产物，
   `verify.py` 第 7 项仍会校验字节一致性。

每一次都是"本地看不出问题、线上才暴露"。所以门禁必须在**部署之前**跑，而不是部署之后看日志。
