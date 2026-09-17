# 构建与启动说明

## 1. 环境要求

| 组件 | 版本 | 必需 | 用途 |
|---|---|---|---|
| Python | >= 3.8（实测 3.13.12） | ✅ | 全部构建与自检脚本 |
| node | 任意近期版本 | ⭕ | 只被 `build/probe_scripts.py` 用来跑 `node --check`。缺失时该项自检自动跳过 |
| Chrome / Edge | 任意近期版本 | ⭕ | 端到端测试台与截图（无头模式）。不跑测试就不需要 |
| Node.js 工程链（npm / webpack / vite） | — | ❌ **不需要** | 本项目没有 npm 依赖树、没有 `package.json`、没有 `node_modules` |

Python 包（只有构建工具需要，运行时不需要）：

```bash
pip install -r requirements.txt      # 实际只装了 openpyxl（生成 Excel 模板用）
```

`build/probe_scripts.py` 按 **`$NODE_BIN` 环境变量 → 常见安装位置 → `PATH` 里的 `node`** 顺序查找。
换机器不用改代码；想指定就 `set NODE_BIN=D:\nodejs\node.exe`。

---

## 2. 构建

```bash
python build/make_app.py
```

输出：`<repo>/index.html` 与 `<repo>/dist/index.html`

```
saved: <repo>/index.html  (218586 字符 / 244153 字节)
```

> **`218586` 是字符数不是字节数**。文件里有大量中文，UTF-8 落盘后是 244153 字节。
> 别把这个数字当成"文件被截断了"。

### 它到底做了什么

把 6 个源文件和 1 个数据文件按顺序拼进一个 HTML 模板：

```
index.html = TPL(
    theme.css  +  app.css
  + <script>render.js</script>
  + <script>parser.js</script>
  + <script>exporter.js</script>
  + <script type="application/json" id="cuSeed">copper_data.json</script>
  + <script>app.js</script>
)
```

三个必须知道的细节：

1. **`copper_data.json` 内嵌时要把 `<` 转义成 `\u003c`**（`make_app.py` 已处理）。
   JSON 里只要出现字面量 `</script>`，HTML 解析器会当场结束脚本块。
2. **注入脚本不能靠 `replace('</body>')`** —— `exporter.js` 的模板字符串里就有字面量 `</body>`，
   replace 会把内容插进 JS 源码里把脚本搞坏。所有测试台脚本因此都用「追加到文件末尾」的方式。
3. **同时写根目录和 `dist/`**。这样本地预览与部署目录来自同一次构建；`verify.py` 会比较两份文件。

### 改了源码没生效？

99% 是忘了重新构建。编辑 `build/*.js` / `build/*.css` **不会**影响已经生成的 `index.html`。

```bash
python verify.py        # 它会重新构建，并告诉你 dist/ 是否已同步
```

---

## 3. 本地启动

```bash
python dist/server.py
# → http://localhost:3000
```

`dist/server.py` 只用标准库，行为有两处是刻意的：

- **未命中的路径全部兜底成 `index.html`**。因为分享出去的链接经常被 IM / 富文本吞掉或多带一个字符，
  落到默认静态服务器上会直接暴露一页 Python 原生报错（`Error code: 404 / Nothing matches the given URI`），
  对客户非常难看。
- **`/.cloud/*` 一律返回 404，不处理**。这个命名空间属于云服务网关（Auth / Database / Storage），
  如果用兜底页去响应它，会把登录接口遮蔽成 HTML。

端口：读 `PORT` 环境变量，默认 3000。服务器固定绑 `0.0.0.0`（发布沙箱的要求）。

```bash
PORT=8080 python dist/server.py
```

### ⚠️ 本地调试会写线上库

前端 `endpoint` 写死在 `app.js` 的 `PUBLIC_CONFIG` 里，指的就是**线上云服务**。
本地起的页面做的增删改会真的落进线上数据库。要做隔离就另开一个云服务应用并改这两个值 ——
注意 `verify.py` 会校验它们没被改动（改了 = 连错环境）。

另外**不要在 `file://` 下测登录**：云服务会做 Origin 校验，本地文件的 Origin 过不了。

---

## 4. 自检

### 一键门禁（推荐，改完代码就跑）

```bash
python verify.py
```

它串起：环境检查 → 依赖校验 → 重建 → 产物检查 → 3 个静态自检 → **契约检查** → dist 同步检查。
退出码 0 = 可以部署，1 = 不要部署。详见 `docs/HANDOFF.md`。

### 三个静态自检（单独跑）

```bash
python build/check_hazard.py                 # 内联 JS/CSS 里的 </script> </style> 是否未转义
python build/check_wiring.py                 # HTML 的 id 与 app.js 的 getElementById 是否对得上
python build/probe_scripts.py ../index.html  # 每个 <script> 块是否语法完整
```

> `probe_scripts.py` 把相对路径解析到 `build/` 下，所以从仓库根调用要写 `../index.html`。

**为什么必须有 `check_hazard.py`**：所有源码都内联进一个 HTML。JS 字符串里只要出现字面量
`</script>`，HTML 解析器会在那里结束脚本块，后面的代码全变成页面文本 ——
**没有任何报错，只是功能静默消失**。这类事故只能靠静态扫描发现。

当前基线（本包交付时）：6 个源文件 hazard=0、116 个 DOM id 引用 0 缺失、9 个 script 块 0 断裂。

---

## 5. 端到端测试（假 SDK 法）

真登录必须走线上域名，本地/无头环境跑不了。所以测试台的做法是：

> 拿**真实的 `index.html`**，把 CDN 的 `<script src>` 换成**同形状的假 SDK**
> （在 `app.js` 之前注入，所以 `app.js` 拿到的是假 cloud），末尾追加驱动脚本。
> **`app.js` 一行不改** —— 测的是真实代码路径，不是"另写一份逻辑自己证明自己"。

假 SDK 的要点：

- 导出与真 SDK **同名同形状**：`WorkBuddyCloud.createWorkBuddyCloud()` 返回 `{auth, database, storage}`。
- `database.from(t)` 返回 **thenable 查询构造器**（支持 `.select().eq().limit()` 链式与 `await`）。
- 假后端**照抄线上 RLS 语义**（含 operator 旁路、草稿对普通用户不可见、`pending` 申请限制）——
  否则测试全绿但线上 403。
- 假后端打印 `insert keys=`，作为**回归哨兵**：字段集一旦被改回包含身份列，立刻能看出来。

```bash
python build/make_notiftest.py     # → notif_flow_op.html(34断言) / notif_flow_user.html(35) / notif_autopop.html(22)
python build/make_authtest.py      # → auth_test.html
python build/make_authflow.py      # → auth_flow.html
python build/make_exporttest.py    # → export_test.html
python build/make_test.py          # Excel → CuParser 往返（需要 outputs/铜期货源数据_20260915.xlsx）
```

这些脚本只**生成** HTML，执行交给无头 Chrome：

```bash
"C:/Program Files/Google/Chrome/Application/chrome.exe" \
  --headless=new --disable-gpu --no-sandbox --no-proxy-server \
  --virtual-time-budget=18000 --dump-dom "file:///<绝对路径>/notif_flow_user.html"
```

### 无头 Chrome 的两个固定坑

1. **必须加 `--no-proxy-server`**。本机若装了系统代理，无头 Chrome 会走代理访问线上域名
   然后报 `ERR_CONNECTION_CLOSED`，而同一时刻 `curl` 是正常的 —— 极容易误判成"站点挂了"。
2. **`--screenshot=` 必须是绝对路径，且文件名用 ASCII**。Chrome 进程的工作目录不是 shell 的 cwd，
   相对路径会报 `0x3 找不到路径`；中文文件名会乱码。先落 ASCII 再改名。

---

## 6. 离线构建（可选）

默认构建用 CDN，产出是**单文件** `index.html`（可以双击直接打开，也是线上部署的形态）。

如果环境无外网、或想锁定依赖版本：

```bash
python vendor_deps.py --check    # 校验 vendor/ 与 deps.lock.json 的 SHA-256
python vendor_deps.py --fetch    # 从固定 CDN 地址重新下载并校验
python vendor_deps.py --apply    # 生成 index.html.vendor.html，把 CDN 地址换成本地 vendor/ 路径
```

> ⚠️ `--apply` 产出的是**离线开发专用**文件：它不再是单文件（需要 `vendor/` 在旁边），
> **不要拿它去发布线上**。想恢复：重新跑 `python build/make_app.py`。

### SDK 升级

云服务 SDK 当前固定为：

```
https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@0.1.1-dev.111acaf.202609102031/lib/index.global.js
```

升级时应同步更新 `build/make_app.py`、`deps.lock.json` 与 `vendor/index.global.js`，然后验证登录链路，因为 SDK 换版本可能改变
`error` 对象的形状（见 `docs/API.md` §3.2）。

---

## 7. 排错速查

| 症状 | 原因 | 处理 |
|---|---|---|
| 改了 JS/CSS 但页面没变 | 忘了重新构建 | `python build/make_app.py` |
| 部署上去是旧版本 | 发布的目录不是本次构建结果 | 重跑 `python verify.py` 后发布 `dist/` |
| 页面白屏，控制台无报错 | 疑似 `</script>` 提前闭合 | `python build/check_hazard.py` |
| 页面报 "SDK 加载失败：无法访问 CDN" | 访问不到 jsdelivr | 这是 `app.js` 的健康检查给的提示。用 `vendor_deps.py --apply` 走离线模式 |
| 某个按钮点了没反应 | DOM id 改了而 JS 没跟着改 | `python build/check_wiring.py` |
| 无头 Chrome 访问线上域名 `ERR_CONNECTION_CLOSED`，但 curl 正常 | 走了系统代理 | 加 `--no-proxy-server` |
| `python verify.py` 报「契约被改动」 | 你改了对外承诺（sheet 列表 / 策略 / 限额外 / 键名） | 看 `docs/HANDOFF.md` §4：要么改回，要么走正式变更流程 |
| `pip install -r requirements.txt` 报错 | 只需要 openpyxl，也可手动 `pip install openpyxl` | — |
| `probe_scripts.py` 报 `No such file` | 相对路径解析到了 `build/` | 从仓库根调用写 `../index.html`，或 `cd build` 后调用 |
