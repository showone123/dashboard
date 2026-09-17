# 用 GitHub 做两平台协同：Codex ↔ WorkBuddy

> 本文件回答一个问题：**源码放在 GitHub 上之后，WorkBuddy 侧怎么读回来，才能保证两个平台协同开发、部署不出错。**
> 配套工具：仓库根目录的 `github_sync.py`（794 行，只用 Python 标准库，无第三方依赖）。

---

## 0. 先分清两件不同的事（很容易混）

| 事情 | 是否支持 | 说明 |
|---|---|---|
| **GitHub 自动部署** —— push 到 GitHub 后 WorkBuddy 自动上线 | ❌ **不支持** | WorkBuddy 云服务没有 Git 集成，也不提供 CI 钩子。见 `DEPLOY.md` §0 |
| **GitHub 作为代码交换媒介** —— Codex push、WorkBuddy 读回来手动部署 | ✅ **支持** | 就是本文件。部署仍然由 WorkBuddy 侧**显式执行**，不在 push 时自动发生 |

**结论**：GitHub 可以当"中转站"，但不能当"发布按钮"。部署动作始终是 WorkBuddy 侧的一次显式操作 —— 这其实更安全，因为中间有 `verify.py` 这道门禁。

---

## 1. 本机网络实测：GitHub 可达性是**间歇性**的

这是本方案最反直觉、也最容易误判的一点。实测（`python github_sync.py --probe`，每个目标连测 3 轮）：

| 通道 | 一次实测 | 另一次实测 | 稳定性 |
|---|---|---|---|
| `github.com:443`（git over HTTPS） | 1/3 抖动 | 0/3 不可达 | ❌ **不推荐** |
| **`api.github.com:443`（REST API）** | **3/3 稳定** | **3/3 稳定** | ✅ 最稳 |
| `codeload.github.com:443`（整库 zip） | 3/3 稳定 | 3/3 稳定 | ✅ 稳 |
| `raw.githubusercontent.com:443`（单文件） | 3/3 稳定 | 3/3 稳定 | ✅ 稳 |
| `github.com:22`（git over SSH） | 6/6 通 | 0/3 不可达 | ⚠️ 抖动 |
| `ssh.github.com:443`（SSH over 443） | 6/6 通 | 0/3 不可达 | ⚠️ 抖动 |

### 三条必须记住的推论

1. **单次探测结果不可信。** 同一个域名在几分钟内能从 0/6 变成 6/6。所以 `--probe` 默认连测 3 轮，并会在 `0 < 成功率 < 100%` 时明确标注"抖动"。
2. **一次失败 ≠ 配置错了。** 任何 git/API 操作都必须带重试。`github_sync.py` 内置指数退避重试（4 次，间隔 2/4/8 秒），`http()` 只对"没连上"（code 0）重试，服务器明确回答的 401/404 不重试。
3. **HTTPS 克隆（`git clone https://github.com/...`）是本机最差的一条路**，不要用。优先 API，其次 SSH-over-443。

---

## 2. 三条读取通道与优先级

| 优先级 | 通道 | 怎么用 | 适合 |
|---|---|---|---|
| **① 最省事** | **WorkBuddy GitHub 连接器** | 在 WorkBuddy 里装连接器并 OAuth 授权，之后用自然语言说"读仓库/拉改动"即可。**本机不需要配任何密钥或 token**，也不受本机网络抖动影响（走 WorkBuddy 服务端） | 日常只读、看 diff、要 PR |
| **② 最稳（脚本默认）** | **GitHub REST API + Token** | `python github_sync.py --pull --api`。读：`zipball` 整库 / `contents` 单文件；写：Git Data API 生成**真实 commit** | 需要脚本化、批量、可重复 |
| ③ 功能最全 | **git over SSH（ssh.github.com:443）** | 需在本机配 SSH 密钥。分支/历史/合并都正常 | 要动分支、要 merge、要看历史 |

> 注：本机当前**没有 SSH 密钥**，也没配 `GITHUB_TOKEN`。所以开箱即用的是**通道 ①（连接器）**。

### 一次性配置

```bash
# 看完整指引（含三条通道的具体步骤）
python github_sync.py --setup-guide

# 告诉他仓库地址（写进 github.json，不含任何密钥，可提交到版本库）
python github_sync.py --init <owner>/<repo> --ref main

# 体检：看当下哪条通道通
python github_sync.py --probe
```

若走 API 通道，把 token 写进 `.env`（`.env` 已被 `.gitignore` 忽略，不会进版本库）：

```bash
echo 'GITHUB_TOKEN=github_pat_xxxxxxxx' >> .env
```

权限只需要 **Contents: Read and write**。

---

## 3. 日常协作流程（读取方向：Codex → WorkBuddy）

设计原则：**每一步都可中断，且默认不改动本地工作区。** 唯一的破坏性动作是 `--apply`，它会先备份。

```bash
# ① 拉取远端 → 只写进 _incoming/，本地工作区一个字节都不动
python github_sync.py --pull

# ② 看差异：谁新增了、谁改了、谁被删了
python github_sync.py --diff

# ③ 对可疑文件看具体改了什么（unified diff）
python github_sync.py --show build/parser.js

# ④ 确认无误再落地（会先把被覆盖的原文件备份到 _backup/<时间戳>/）
python github_sync.py --apply

# ⑤ 必须：跑门禁。绿了才谈部署
python verify.py

# ⑥ 部署（WorkBuddy 侧显式执行，见 docs/DEPLOY.md）
```

`--diff` 会自动**标出敏感文件**，因为它们改错了代价最大：

| 文件 | 为什么敏感 |
|---|---|
| `build/parser.js` | Excel sheet 契约 —— 改了会让**已交付客户**的模板静默失效 |
| `build/app.js` | insert 字段集 / localStorage 键名 / 名额限制 |
| `dist/server.py` | 坏链接兜底与 `/.cloud` 是否被遮蔽 |
| `db/` `migrations/` | 需要 WorkBuddy 侧**同步执行**迁移，不能只改文件 |
| `contract.json` | 契约基线本身。**别为了让 verify 变绿去改它**（那是关告警，不是修问题） |

---

## 4. 回写方向（WorkBuddy → GitHub，需要时）

```bash
python github_sync.py --push -m "改了什么、验证结果、是否触及 contract.json"
```

`--push` 的顺序是刻意的：**先跑 `verify.py`，绿了才提交**。门禁不过直接拒绝推送 —— 不会把没验证的代码推给 Codex。

推送会自动选通道：有 SSH 密钥走 git，否则回退到 Git Data API。两者都不通时，脚本会明确告诉你改配密钥或用连接器。

---

## 5. 两平台分工（与 `AGENTS.md` 一致）

| 职责 | Codex | WorkBuddy |
|---|---|---|
| 源码开发、重构、验证 | ✅ | — |
| Git 提交与推送 | ✅ | 按需 |
| **跑 `verify.py` 建立基线** | ✅ 改动前 + 改动后 | ✅ 落地后 |
| **生产发布** | ❌ | ✅ **独占** |
| **云数据库执行迁移** | ❌ | ✅ **独占** |
| **认证 / 存储设置** | ❌ | ✅ **独占** |
| **创建 WorkBuddy 应用 / 改访问范围** | ❌ | ✅ **独占** |

硬边界（`AGENTS.md` 已声明，Codex 侧同样受约束）：

- 不改应用 ID `wbapp_SzEJc2waV6zqr78qhIU3M1`、endpoint、publishable key
- 不引入 npm/bundler、数据库驱动、Redis、消息队列或第二个服务进程
- 不改已应用的 `migrations/001_init.sql`，数据库变更**新增**顺序编号迁移
- 身份列由数据库 `auth.uid()` 生成，客户端 insert **不得**传 `owner_id` / `created_by`
- Excel sheet / 表头 / 上传限额 / 通知限额 / localStorage 键属于**外部契约**
- 不提交真实服务端密钥、会话令牌或客户数据

---

## 6. 安全边界

- **非破坏性默认**：`--pull` 只写 `_incoming/`；`--diff` / `--show` 完全只读；`--apply` 是唯一写操作，且需交互确认（输入 `y`）+ 自动备份到 `_backup/<时间戳>/`。
- **`_incoming/` `_backup/` `_gitclone_tmp/` 已进 `.gitignore`**，不会被误提交。
- **API 推送不直接 `os.walk` 工作区** —— 它用 `git ls-files -co --exclude-standard` 让 Git 成为文件选择的唯一来源，并显式剔除 `.env`。否则可能绕过 `.gitignore` 把 `.env` 和本地备份上传上去。
- **`github.json` 不含密钥**（只有 repo 名和分支名），所以可以提交；`GITHUB_TOKEN` 只走环境变量或被忽略的 `.env`。

---

## 7. 已知坑与排错

### 坑 1：`fatal: detected dubious ownership in repository`

**本机实测踩到过。** 本目录的 `.git` 被 git 判定属主与当前用户不一致，导致 `git status` / `ls-files` / `commit` / `push` **全部失败**。它还会连带打断 API 推送（因为 API 推送依赖 `git ls-files` 挑文件）。

`github_sync.py` 已修：用 `GIT_CONFIG_COUNT` 环境变量注入 `safe.directory`，**只作用于本脚本拉起的子进程**，不写 `~/.gitconfig`，不影响你其他仓库。

如果你在脚本外手动跑 git 遇到这个，可以临时这样：

```bash
git -c safe.directory="$(pwd)" status
```

### 坑 2：仓库刚 `git init`，`git log` 报 `does not have any commits`

不是错误 —— 是仓库还没有首次提交。`--status` 会正常显示为"（尚无提交）"。首次 `--push` 之后就有了。

### 坑 3：`git push` 报 `src refspec master does not match any`

`github.json` 里的 `ref` 和 GitHub 仓库的默认分支名不一致（比如仓库是 `main`，配置写了 `master`）。改配置：

```bash
python github_sync.py --init <owner>/<repo> --ref main
```

### 坑 4：API 报 404

- 私有库没配 `GITHUB_TOKEN`（读私有库必须带 token）
- 仓库名或分支名拼错

### 坑 5：API 报 403，但仓库明明是公开的 —— **不是没权限，是配额用尽**

实测踩到过。匿名访问 GitHub API 时，**配额是按出口 IP 算的 60 次/小时**，用尽后
连读公开库也会返回 403，报文是：

```
{"message":"API rate limit exceeded for 212.107.30.202. ..."}
```

这和"仓库拒绝你"完全是两回事。判断方法就一个 —— **看报文里有没有 `rate limit`**：

- 有 → 配额问题。解决：配 `GITHUB_TOKEN`（额度升到 5000 次/小时），
  或直接用 **WorkBuddy GitHub 连接器**（已鉴权，不占本机配额）。
- 没有 → 再看是不是分支保护挡住了写，或 token 缺 `Contents: Read and write`。

`github_sync.py` 已内置这个判别（`explain_api_error()`），`--status` / `--pull` 会直接
告诉你是哪种情况以及下一步做什么，不会再只给一个裸 `http=403`。

> 顺带一提：这台机器上 `curl` 与 Python 的出口 IP 可能不同，所以"curl 能通、脚本 403"
> 并不矛盾 —— 两条路走的是不同 IP，各有一份独立配额。

### 坑 6：认证类失败

- `401` → token 无效或过期
- 写操作 403 且报文无 `rate limit` → 可能被分支保护挡住，或 token 缺写权限
  （`--status` 会显示分支是否 `protected`）

---

## 8. 一页速查

```bash
python github_sync.py --setup-guide    # 配置指引（三条通道）
python github_sync.py --init o/r --ref main
python github_sync.py --probe          # 通道体检（3 轮，标抖动）
python github_sync.py --status         # 三方状态：本地/远端/部署产物
python github_sync.py --pull           # 拉远端 → _incoming/（不动本地）
python github_sync.py --diff           # 看差异（标敏感文件）
python github_sync.py --show <file>    # 看某文件的具体 diff
python github_sync.py --apply          # 落地（先备份）
python verify.py                       # 门禁：43 项，退出码 0 才部署
python github_sync.py --push -m "msg"  # 回写（会先跑 verify.py）
```
