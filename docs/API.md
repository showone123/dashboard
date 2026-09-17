# 前后端 API 地址说明

## 0. 先纠正一个预期：本项目**没有自己的后端**

这不是"前端 + 自建后端"的架构，而是**纯前端直连云服务**：

```
浏览器 (index.html)
   │  直接用 SDK 发 HTTPS 请求
   ▼
WorkBuddy 云服务网关  https://data-dashboard-85191.app.workbuddy.host
   ├── /.cloud/auth          登录注册 / 会话 / 验证码 / 改密
   ├── /.cloud/database/rest  PostgreSQL（带 RLS）
   ├── /.cloud/storage        对象存储（Excel 文件本体）
   └── /.cloud/llm            （平台能力，本项目未使用）
```

**`dist/server.py` 不是后端**。它只做一件事：静态文件服务 + 未命中路径兜底成 `index.html`。
它不处理任何业务逻辑、不连数据库、不持有任何数据。所以：

- 想加"服务端逻辑"（比如代调 AI、跑定时任务、汇总全站统计）→ **当前架构下没有地方放**，
  需要先确认平台是否允许，或者改成别的托管方式。
- 想加"业务数据接口"→ 正确做法是**加表 + 加 RLS 策略**（见 `migrations/`），
  前端用 SDK 直连，而不是在 `server.py` 里写路由。

> ⚠️ 平台限制：发布沙箱**只暴露一个 HTTP 端口，沙箱里没有数据库/缓存/消息队列**。
> 本项目的数据库是**公开托管的云数据库**（走公网 HTTPS），所以能跑；
> 但如果你在 `server.py` 里引入 `psycopg2` 之类的驱动去直连数据库，
> 发布会被直接拒绝（预检查扫描依赖清单和 `.env*` 里的连接串）。

---

## 1. 端点总表

| 命名空间 | 完整前缀 | 用途 |
|---|---|---|
| Auth | `https://data-dashboard-85191.app.workbuddy.host/.cloud/auth` | 账号、会话、验证码 |
| Database | `https://data-dashboard-85191.app.workbuddy.host/.cloud/database/rest` | PostgREST 风格的表操作 |
| Storage | `https://data-dashboard-85191.app.workbuddy.host/.cloud/storage` | 文件上传/下载/删除 |
| LLM | `https://data-dashboard-85191.app.workbuddy.host/.cloud/llm` | 平台 LLM 能力（本项目未使用） |

这些前缀在 SDK 内部是写死的常量，前端只需提供 `endpoint` 根地址：

```js
var j = "/.cloud";
var k = { auth: `${j}/auth`, database: `${j}/database/rest`, storage: `${j}/storage`, llm: `${j}/llm` };
```

**所以换环境时只需要改一个 `endpoint`**，不用改任何路径。

---

## 2. 请求头（最容易踩的一条）

| 头 | 值 | 说明 |
|---|---|---|
| `x-wb-webapp-access-key` | `wbpk_SzEJc2waV6zqr78qhIU3M1_EsOOC55rzH5Grlz0kErY9VMacOE30GRa` | **必须用这个名字**。写成 `apikey`（Supabase 的习惯）会返回 `invalid_client` —— 症状看起来像鉴权配置坏了，其实只是头名不对 |
| `Authorization` | `Bearer <access_token>` | 登录后由 SDK 自动带上，不用手写 |
| `Content-Type` | `application/json` | POST/PATCH 时必须有 |
| `Prefer` | `return=representation` | 需要返回写入后的行时用（SDK 的 `.select()` 会带上） |
| `x-upsert` | `true` | 冲突时覆盖（SDK 的 upsert 用） |

---

## 3. Auth 端点

SDK 里定义的路径（前缀 `/.cloud/auth`）：

| 路径 | 用途 | SDK 方法 |
|---|---|---|
| `/v1/signup` | 注册 | `cloud.auth.signUp()` |
| `/v1/signin` | 密码登录 | `cloud.auth.signInWithPassword()` |
| `/v1/signin/with/provider` | 第三方登录 | `cloud.auth.signInWithProvider()` |
| `/v1/token` | 刷新/换取 token | 内部 |
| `/v1/login-wechat` | 微信登录 | — |
| `/v1/verification` | 发送验证码（邮箱 OTP） | `cloud.auth.sendOtp()` |
| `/v1/verification/verify` | 校验验证码 | `cloud.auth.verifyOtp()` |
| `/v1/reset` | 用重置码设置新密码 | `updateUser({nonce, password})` 内部走它 |
| `/v1/user/me` | 当前用户 | `cloud.auth.getUser()` |
| `/v1/user/password` | 改密码 | — |
| `/v1/user/signout` | 登出 | `cloud.auth.signOut()` |
| `/v1/user/sudo` | 提权会话 | — |

### 3.1 平台的账号模型（写认证逻辑前必须知道）

**平台只支持「邮箱验证码 + 设置密码」，不支持纯邮箱+密码注册。**
用邮箱验证码注册出来的账号**没有密码**，此时用密码登录会报 `PASSWORD_NOT_SET`（`error_code = 4029`）。
给这类账号设密码**只有一条合法路径**：邮件重置码
（`resetPasswordForEmail` → `updateUser({nonce, password})` → `POST /v1/reset`）。
`resetPasswordForOld`（需要旧密码）对无密码账号无效。

前端必须做五件事（`app.js` 的 98–410 段已实现，改动时照着来）：

1. 顶部「登录 / 注册」分段控件驱动同一套表单，不要两套 DOM（会互相覆盖状态）。
2. 验证码按钮 60 秒冷却，**状态放模块级变量**（`sendCool`），不要挂在 DOM 上
   （DOM 属性在重渲染后会丢）。
3. 冷却期内点击也要有中文提示 —— 只靠 `disabled` 的话点击事件根本不触发，
   用户看到的是"点了没反应"。函数入口处也要有一道闸。
4. 判断错误用 **`code` 而不是 `message`** —— `message` 有时是后端英文原文
   （如 `user password not set`）。
5. `PASSWORD_NOT_SET` 时把用户引导到"重设密码"流程，不要只甩一句英文报错。

### 3.2 SDK 递回来的 error 结构（字段容易读错）

实测 SDK 会把后端原始 body **重新包一层**：

```js
{
  kind: 'invalid-request',
  message: 'user password not set',          // ← 英文原文，别直接给用户看
  status: 400,
  code: 'password_not_set',                  // ← 小写，可用
  cause: { code: 'PASSWORD_NOT_SET', error: 'password_not_set', error_code: 4029, ... }
}
```

所以读取顺序应该是：`error.code` → `error.error` → `error.cause.code` → `error.cause.error`
→ `error.error_code` → `error.cause.error_code`，全部 `toUpperCase()` 后比对。见 `app.js` 的 `errCode()`。

---

## 4. Database（PostgREST 风格）

前缀 `/.cloud/database/rest`。

| 操作 | HTTP | 路径示例 |
|---|---|---|
| 查询 | GET | `/.cloud/database/rest/access_grants?owner_id=eq.<uid>&limit=1` |
| 插入 | POST | `/.cloud/database/rest/notifications` |
| 更新 | PATCH | `/.cloud/database/rest/notifications?id=eq.123` |
| 删除 | DELETE | `/.cloud/database/rest/datasets?id=eq.123` |

SDK 的查询构造器（`cloud.database.from(t)`，thenable，可 `await`）：

```js
var r = await cloud.database.from('access_grants')
                    .select('*').eq('owner_id', S.userId).limit(1);
if (r.error) throw r.error;
r.data            // 行数组
```

### 4.1 本项目实际用到的调用（前端调用面清单）

`grep -o 'cloud\.\(auth\|database\|storage\)\.[A-Za-z]*' build/app.js | sort -u` 的结果：

```
cloud.auth.getSession              cloud.database.from
cloud.auth.getUser                 cloud.storage.download
cloud.auth.onAuthStateChange       cloud.storage.remove
cloud.auth.resetPasswordForEmail    cloud.storage.upload
cloud.auth.sendOtp                 cloud.storage.userPath
cloud.auth.signInWithOtp
cloud.auth.signInWithPassword
cloud.auth.signOut
cloud.auth.verifyOtp
```

### 4.2 各表的写入字段集（**这是权限边界的一部分**）

| 表 | 操作 | 字段集 | 备注 |
|---|---|---|---|
| `access_grants` | INSERT | `status, plan, email, note` | **不含 `owner_id`** —— 交给列默认值 `auth.uid()`。RLS 的 `WITH CHECK` 强制 `status='pending' AND plan<>'operator' AND expires_at IS NULL` |
| `datasets` | INSERT | `name, storage_path, size_bytes, mime_type, data_date, sheet_count` | **不含 `owner_id`** |
| `notifications` | INSERT | `title, body, level, published, updated_at` | **不含 `created_by`** —— 曾经传了它，而列是 uuid 类型，导致线上 `22P02 invalid input syntax for type uuid` |

> **规则：客户端 insert 字段集里绝不能出现身份列。** 身份一律由列默认值 `auth.uid()` 生成。
> `verify.py` 会静态扫描所有 `.insert({...})` 强制这一条（见 `contract.json` 的 `forbidden_insert_columns`）。

### 4.3 错误码对照

| 错误 | 含义 | 怎么修 |
|---|---|---|
| `401` + `invalid_client` | `x-wb-webapp-access-key` 头名写错或 key 不对 | 检查头名，不是 `apikey` |
| `401` + `DATABASE_42501` `permission denied for table X` | RLS 策略或表级 GRANT 缺一（anon 本来就该 401） | 见 `migrations/README.md` 的三件套顺序 |
| `22P02` + `invalid input syntax for type uuid: "2099…"` | 列类型建成 uuid，但身份是 19 位数字字符串 | 改成 `text`，见 `db/DB_SCHEMA.sql` 变更历史 |
| `PASSWORD_NOT_SET` / `4029` | 账号没设过密码 | 走邮件重置码流程 |
| `23505` | 唯一约束冲突 | `loadGrant()` 里对它是容忍的（并发自助申请） |

---

## 5. Storage

前缀 `/.cloud/storage`。路径由 `cloud.storage.userPath(userId, relative)` 生成 ——
**带用户目录前缀**，不同用户的文件天然隔离。

```js
var path = cloud.storage.userPath(S.userId, 'datasets/' + Date.now() + '_' + safe);
await cloud.storage.upload(path, file, { contentType: file.type, upsert: true });
await cloud.storage.download(d.storage_path);   // → Blob
await cloud.storage.remove([d.storage_path]);
```

`datasets.storage_path` 存的就是这个 path。上传大小上限 **8 MB**（`app.js` 的 `MAX_UPLOAD`，
改动会被 `verify.py` 拦下）。

---

## 6. 直连调试（curl）

```bash
EP=https://data-dashboard-85191.app.workbuddy.host
KEY=wbpk_SzEJc2waV6zqr78qhIU3M1_EsOOC55rzH5Grlz0kErY9VMacOE30GRa

# 匿名读已发布通知 → 期望 401（RLS 挡住未登录）
curl -i "$EP/.cloud/database/rest/notifications?select=*" -H "x-wb-webapp-access-key: $KEY"

# 匿名写 → 期望 401（注意字段必须合法，否则可能返回 400，别把 400 当成 401 的证据）
curl -i -X POST "$EP/.cloud/database/rest/notifications" \
     -H "x-wb-webapp-access-key: $KEY" -H "Content-Type: application/json" \
     -d '{"title":"x","body":"y"}'

# 确认兜底路由生效 → 期望 200（且内容是 index.html，不是 Python 404 页）
curl -s -o /dev/null -w "%{http_code}\n" "$EP/some/bad/path"

# 确认 /.cloud 没被 server.py 遮蔽 → 期望 404（且不是 HTML）
curl -i "$EP/.cloud/nothing-here"
```

⚠️ **不要用 `curl | grep -c` 判断结果**。内容较大时 curl 会 `exit 23 Failed writing body`
截断输出，grep 拿到不完整输入 → 返回错误的 0 → 得出"改动没上线"的相反结论。
一律 **先 `curl -o 文件` 落盘，再 `cmp` / `grep 文件`**。

---

## 7. 本地开发怎么指后端

前端是直连云服务的，本地打开 `index.html` 就能连**线上数据库**（`endpoint` 写死在
`app.js` 的 `PUBLIC_CONFIG` 里）。这带来一个必须注意的后果：

> ⚠️ 本地调试时的增删改，**会真的写进线上库**。

要做隔离，就得另开一个云服务应用，并把 `PUBLIC_CONFIG.endpoint` / `publishableKey`
指向它 —— 这也是 `verify.py` 要校验这两个值没被改动的原因（改了就是连错环境）。

另外两件本地开发相关的事：

- **不要在 `file://` 下测登录**。浏览器对本地文件的 Origin 处理与线上不同，
  云服务的 Origin 校验会失败。要本地测就起 `dist/server.py`（`http://localhost:3000`），
  或者用测试台的假 SDK（见 `docs/BUILD.md`）。
- **无头 Chrome 要加 `--no-proxy-server`**。本机若装了系统代理，无头 Chrome 会走代理访问
  线上域名然后报 `ERR_CONNECTION_CLOSED`，而同一时刻 `curl` 是正常的 —— 极易误判成"站点挂了"。
