# 部署与重新部署

## 0. 先回答「GitHub 自动部署」——**不支持**

| 想做的事 | 是否支持 | 说明 |
|---|---|---|
| GitHub 仓库 push 后自动部署到线上链接 | ❌ **不支持** | WorkBuddy 的发布能力只由会话内的 `workbuddy_sites_deploy` 工具驱动：它把**本地目录**打包上传到分配的沙箱，安装依赖、起服务、绑定保留域名。没有 webhook、没有 GitHub App、没有 CI/CD 钩子，也没有任何可配置的"部署来源" |
| Webhook / 定时重建 / 流水线 | ❌ 不支持 | 同上，沙箱生命周期由平台管理 |
| 手动触发重新部署（覆盖现有链接） | ✅ 支持 | 就是在 WorkBuddy 里说一句「覆盖上线」。**这是唯一的部署入口** |
| 用 GitHub 做版本管理 / 代码中转 | ✅ 可以 | 见下面 §5。GitHub 可以承担"代码传递与 review"，但**部署那一步必须在 WorkBuddy 里执行** |

### 为什么不能绕开 WorkBuddy 部署

三个东西是绑死在这个应用上的，换地方部署就断：

1. **保留域名**：`data-dashboard-85191.app.workbuddy.host` 由平台分配并绑定到 `applicationId`。
   新建应用会拿到**不同域名**。
2. **云服务 Origin 白名单**：云登录会做 **Origin 精确匹配**。换了域名，登录立刻失效（不是配置问题，是服务端强校验）。
3. **沙箱**：跑 `server.py` 的容器由平台创建与管理。

所以正确的分工是：**Codex 负责改代码，WorkBuddy 负责验证与部署。** 中间的桥梁就是 `verify.py`。

---

## 1. 部署参数（照抄，别猜）

| 参数 | 值 |
|---|---|
| `applicationId` / `appId` | `wbapp_SzEJc2waV6zqr78qhIU3M1` |
| `localDir` / `directory` | `<repo>/dist` |
| `language` | `python` |
| `startCmd` | `python server.py` |
| `domainPrefix` | `data-dashboard` |
| 线上地址 | `https://data-dashboard-85191.app.workbuddy.host` |

### 三条硬规则

1. **`startCmd` 必须显式给 `python server.py`**。
   只声明 `language: "python"` 时，探测逻辑会去找 `main.py`，于是报
   `can't open file '/workspace/main.py'` + `service did not become reachable on port 3000`。
   **不要为了迁就它把 `server.py` 改名。**

2. **必须复用 `appId`，不要 `createNewApp`**。
   这个应用是通过云服务开通的，复用它才能保留域名与云服务 Origin。新建应用 = 换域名 = 登录全废。

3. **上传的是 `dist/`，不是仓库根**。
   `dist/` 里应该只有两样东西：`server.py` 和 `index.html`。
   ⚠️ **不要把 `requirements.txt` / `.env.example` / `db/` / `migrations/` 复制进 `dist/`**：
   发布前有一道预检查，扫描依赖清单与 `.env*`，一旦出现数据库驱动包名
   （`pg` / `psycopg2` / `mysql2` / `mongoose` / `ioredis` …）或指向 localhost 的连接串，
   项目会被判定为「依赖沙箱不提供的外部服务」而**整包被拒**。
   本项目走公网 HTTPS 调云服务，本来就不需要那些东西 —— 保持 `dist/` 干净最安全。

### 为什么 `server.py` 一个字都不该改

它决定两个线上行为（`verify.py` 用 sha256 强校验，改了会 FAIL）：

- **坏链接兜底**：分享链接经常被 IM / 富文本吞字或多带字符，兜底成 `index.html` 后客户看不到原生 404 页。
- **不遮蔽 `/.cloud/*`**：这个命名空间属于云服务网关。如果兜底逻辑把它也接管成 HTML，
  登录接口就废了。

确实需要改的话：改代码 + 改 `contract.json` 里的 `server_py_sha256` 与字节数 + 在本文档记录原因，三件一起做。

---

## 2. 部署前检查（必做）

```bash
python verify.py
```

**退出码 0 才继续。** 它会顺带完成构建，并检查 `dist/index.html` 是否与 `index.html` 一致 ——
不一致会 FAIL（那意味着部署上去的不是刚构建的版本，而且不会报错，最容易踩）。

手动版：

```bash
python verify.py
cmp index.html dist/index.html      # 必须无输出
```

### 关于「发布需要用户当轮同意」

部署是**对外发布**：它会覆盖别人可能正在看的页面。所以平台要求**用户在本轮消息里明确要求发布**
（说了「上线 / 部署 / 覆盖上线 / publish」之类），工具才会执行；否则会返回
`sites_deploy_needs_confirmation` 并要求先问一句。

这条是**刻意的保护，不是障碍**：不要为了绕过它去翻 `userAskedToPublish` 这个开关 ——
那个字段记录的是"用户要求过"，不是"重试开关"。

同理：本地改完一个 bug **不等于**用户要发布。改完先让用户看本地预览，再问一句要不要同步线上。

---

## 3. 部署步骤

```
①  python verify.py                     # 全绿并同步部署产物
②  在 WorkBuddy 里说「覆盖上线」          # → 调用 workbuddy_sites_deploy
       directory = <repo>/dist
       appId     = wbapp_SzEJc2waV6zqr78qhIU3M1
       language  = python
       startCmd  = python server.py
④  跑下面的「部署后验收清单」
```

### 常见瞬时失败：原样重试一次即可

首次发布经常出现一次失败，报 `fetch failed` 或「预留域名未绑定到本次发布环境」。
**用完全相同的参数重试一次通常就成功**。不要因为一次失败就去改参数、改 `language`、
改 `startCmd` —— 那会把一个瞬时问题变成真问题。

---

## 4. 部署后验收清单（逐条做，别只看"发布成功"）

```bash
EP=https://data-dashboard-85191.app.workbuddy.host

# ① 产物真的上去了 —— 逐字节比对，这是最强证据
curl -s -o /tmp/_live.html "$EP/"
cmp /tmp/_live.html dist/index.html && echo "字节一致 ✅"

# ② 本次改动的新标记在线上确实存在（把 <标记> 换成你这次改动引入的字符串）
grep -c "<本次改动的标记>" /tmp/_live.html

# ③ 兜底路由：任意坏路径应返回 200 且内容是应用本体
curl -s -o /dev/null -w "fallback=%{http_code}\n" "$EP/some/bad/path"

# ④ /.cloud 未被遮蔽：应 404，且不是 HTML
curl -s -o /dev/null -w "cloud=%{http_code}\n" "$EP/.cloud/nothing-here"

# ⑤ 匿名权限仍被 RLS 挡住：应 401
curl -s -o /dev/null -w "anon_notif=%{http_code}\n" \
     "$EP/.cloud/database/rest/notifications?select=*" \
     -H "x-wb-webapp-access-key: wbpk_SzEJc2waV6zqr78qhIU3M1_EsOOC55rzH5Grlz0kErY9VMacOE30GRa"

# ⑥ 截图确认页面真的渲染出来了（login 页出现即说明 SDK 加载成功）
"C:/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --disable-gpu \
  --no-sandbox --hide-scrollbars --no-proxy-server --window-size=1280,860 \
  --virtual-time-budget=18000 --screenshot="C:\abs\ascii\live_check.png" "$EP/"
```

### ⚠️ 验收时最容易犯的错：用 `curl | grep -c` 判断

内容较大时 curl 会以 `exit 23 (Failed writing body)` 提前中断，grep 拿到的是**截断内容**，
于是返回一个**假的 0**，让你以为"改动没上线"而反复重部署。
更糟的是容易把**注释里**出现的字样当成代码命中，把结论读反。

> 正解：**先 `curl -o` 落盘一次，再 `cmp` / `grep 文件`。**

---

## 5. 回滚

**部署前**：把当前线上产物另存一份，命名带说明与日期。

```bash
curl -s -o "outputs/发布归档_<说明>_<YYYYMMDD>.html" "$EP/"
```

**回滚**：

```bash
cp "outputs/发布归档_<说明>_<YYYYMMDD>.html" dist/index.html
# 然后在 WorkBuddy 里说「覆盖上线」
```

已归档的历史版本：

| 文件 | 大小 | 说明 |
|---|---|---|
| `outputs/发布归档_通知功能+uuid修复_20260916.html` | 244153 | 通知功能 + `created_by` 类型修复 |
| `outputs/index_rollback_通知功能上线前_20260916.html` | 209520 | 通知功能上线前的稳定点 |

> macOS/Linux 与 Windows 的 `cp` 都能用；本仓库的命令示例按 Git Bash 写。

---

## 6. 想用 GitHub 管代码？（可以，但部署仍在 WorkBuddy）

GitHub 在这个项目里的**合理定位是代码中转与评审**，不是部署来源：

```
Codex / 你                  GitHub                     本机                      WorkBuddy
   │                          │                          │                          │
   ├─ 改 build/*.js ─────────>│ push                     │                          │
   │                          ├─ PR / review             │                          │
   │                          │                          │                          │
   │                          │<── github_sync.py ───────┤                          │
   │                          │    --pull（走 API）       ├─ python verify.py ───────┤
   │                          │                          └─ 「覆盖上线」──────────>│ 部署 dist/
```

> ⚠️ **不要用 `git clone https://github.com/...`** 来取代码。本机实测这条通道最不稳定
> （两轮探测分别为 1/3 和 0/3）。用 `python github_sync.py --pull`（默认走 `api.github.com`，
> 实测 3/3 稳定），或直接装 WorkBuddy 的 GitHub 连接器。
> 完整实测数据、三条通道对比、非破坏性读取流程与已知坑见 **`docs/GITHUB_SYNC.md`**。

**唯一要守住的纪律**：`python verify.py` 必须是绿的。它替代了 CI ——
在这个没有类型系统、没有 linter 的单文件项目里，它是唯一能自动拦住「静默破坏对外契约」的关卡。
（它同时也会检查 `github_sync.py` 这条中转通道本身是否完好，见其第 8 节。）

如果确实想要"推代码就自动部署"，在平台支持之前只能自己搭：
比如在本地跑一个 watcher，检测到 `--pull` 有新提交就自动 `verify.py` + 触发部署。
但**部署动作本身仍然必须发生在 WorkBuddy 会话里**（因为沙箱与域名绑在 `appId` 上），
所以自动化程度有限，收益不大。**优先做的是把 `verify.py` 跑顺，而不是搭流水线。**

---

## 7. 失败对照表

| 报错 | 原因 | 处理 |
|---|---|---|
| `can't open file '/workspace/main.py'` + `service did not become reachable on port 3000` | 没给 `startCmd` | 显式传 `startCmd = "python server.py"` |
| `fetch failed` / 「预留域名未绑定到本次发布环境」 | 瞬时故障 | **原样重试一次**，不要改参数 |
| `sites_deploy_needs_confirmation` | 用户本轮没明确要求发布 | 问一句，等用户答；不要翻 `userAskedToPublish` |
| `sites_deploy_unsupported` | 项目被判为依赖沙箱不提供的外部服务 | 检查 `dist/` 里有没有多出依赖清单或 `.env`；本项目的正常形态不该触发 |
| `sites_deploy_needs_app_selection` | 目录对应多个应用 | 列出候选问用户，带上选定的 `appId` 重试 |
| 部署成功但页面是旧的 | 发布的目录不是本次构建结果 | 重跑 `python verify.py` 后发布 `dist/`；第 7 项会提前发现 |
| 部署成功但登录失败 | 域名变了（误用了 `createNewApp`） | 必须复用 `appId`；换域名会破坏云服务 Origin 精确匹配 |
