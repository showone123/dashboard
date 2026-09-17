# 铜数据看板：Codex 协作规则

本仓库部署在 WorkBuddy，Codex 负责本地源码开发、验证与 Git 交付。生产发布、云数据库执行、认证设置和存储设置由 WorkBuddy 负责。

## 开始工作前

- 先阅读 `README.md`、`docs/HANDOFF.md` 和 `contract.json`。
- 先运行 `python verify.py` 建立基线；失败时先解释并修复基线，不要继续叠加功能改动。
- 只编辑源码与文档。`index.html` 和 `dist/index.html` 由 `build/make_app.py` 同时生成，不要手工编辑。

## 必须保持的部署契约

- 保留应用 ID `wbapp_SzEJc2waV6zqr78qhIU3M1`、线上 endpoint 和 publishable key，除非用户明确要求迁移环境。
- 保持 `dist/server.py` 读取 `PORT`、监听 `0.0.0.0`、排除 `/.cloud` 并保留 SPA 兜底路由。
- 不引入 npm/bundler、数据库驱动、Redis、消息队列或第二个服务进程，除非用户明确批准架构迁移。
- 不修改已应用的 `migrations/001_init.sql`。数据库变更新增顺序编号迁移，同时更新 `db/DB_SCHEMA.sql` 和 `migrations/_applied.md`。
- 身份列由数据库的 `auth.uid()` 默认值生成；客户端 insert 不得传 `owner_id` 或 `created_by`。
- Excel sheet、表头、上传限额、通知限额和 localStorage 键属于外部契约。修改时必须同步更新 `contract.json`、模板、文档及迁移说明，并明确说明兼容性影响。
- 不把真实服务端密钥、会话令牌或客户数据提交到 Git。当前 publishable key 是公开客户端配置，不代表其他凭据也可公开。

## 文件职责

- UI 与交互：`build/app.css`、`build/theme.css`、`build/app.js`
- 解析：`build/parser.js`，不要在其中加入网络或 DOM 副作用
- 渲染：`build/render.js`，保持纯渲染职责
- 导出：`build/exporter.js`
- 示例数据：`build/copper_data.py`、`build/copper_data.json`
- 部署文件：`dist/`，仅由构建生成并由 WorkBuddy 发布

## 交付要求

- 完成修改后运行 `python verify.py`，退出码必须为 0。
- 涉及认证、数据库、RLS、文件存储或部署配置时，在交付说明中单列风险和 WorkBuddy 侧需要执行的步骤。
- 提交说明要包含修改内容、验证结果，以及是否触及 `contract.json` 或数据库迁移。
- 不直接执行生产数据库迁移，不创建新的 WorkBuddy 应用，也不改变生产访问范围。
