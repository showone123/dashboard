# 股票工作台首版

这次选用同花顺公开 API 的 **A 股最新行情快照** 子集：每个登录用户保存最多 10 只完整 `thscode`，查看最新价、涨跌、涨跌幅、成交量、成交额。页面每 30 秒检查更新，也可手动刷新。行情时间来自上游响应；交易所休市时不会产生新行情。首版没有下单、分钟 K、财务分析或投资建议。

浏览器只请求本站 `GET /api/stocks?codes=600519.SH,000001.SZ`，并携带 `X-FluxDesk-Request: 1`；`build/stocks_service.py` 在服务端校验代码、调用同花顺 `GET /api/a-share/prices/snapshot`，只返回页面需要的字段并保留 `null`。服务端按股票代码缓存 30 秒，避免每个浏览器轮询都消耗上游调用。请求失败返回 503，页面保留上次显示的行情。自选列表仅存在当前浏览器的 `fluxdesk_stocks_v1:<用户ID>` 中，不进入客户数据库。

部署前在 **WorkBuddy 应用的服务端环境变量** 设置 `HITHINK_FINANCE_API_KEY`，并确认应用服务器可以出站访问 `https://fuyao.aicubes.cn`。不要把 Key 放进 `.env.example`、`dist/`、前端、Git 或公开日志。发布时必须同步更新整个 `dist/`，其中包含 `server.py` 和 `stocks_service.py`。本次没有数据库迁移，也没有改变现有登录、上传与云服务配置。

服务端路由有意从原来的期货缓存接口扩展出只读的股票行情接口，因此同步更新了 `contract.json` 中的 `server_py_sha256`、`server_py_bytes` 及 `_note_server`。既有 `/.cloud` 排除、SPA 兜底与期货接口保持原样。上线前执行 `python verify.py` 和 `python -m unittest discover -s tests -p test_stocks.py -v`。线上用浏览器登录后打开“股票工作台”，核对行情时间、添加和移除股票、自动更新与服务端未配置 Key 时的错误提示。

当前接口供网页匿名读取，可能消耗账号配额；每次最多 10 只且有 30 秒服务端缓存。如果网站遭到大量不同代码的请求，应在网关增加限流或接入已有会话校验。此限制不影响页面已有的登录门禁。

## 扩展：同花顺公开 REST 全量查询

股票工作台下方的“金融数据查询”覆盖官方文档当前标记为“公开”的 **79 个 GET 接口**：A 股 22、指数与板块 4、标的检索 2、基金 34、期货 13、期权 4。接口目录从同花顺仓库 `docs/api/*/README.md` 的公开行生成，参数表从各接口文档提取，保存为 `build/financial_catalog.json`。标为“端内专用、待上线”的接口不会出现在页面或服务端白名单中。

选择业务域和接口后，页面按官方文档列出参数、必填项与说明，并提供原文链接。结果中的 `data.item` 以结构化表格预览前 100 条；其余结构显示 JSON 预览，完整响应可下载为 JSON。自选股行情维持 30 秒自动刷新，其他接口仅在用户点击“查询数据”时调用，避免历史数据和全市场任务持续消耗配额。

浏览器向本站 `POST /api/finance/query` 发送接口 ID 和参数。`build/financial_service.py` 仅允许目录中列出的固定路径和参数，限制请求体、参数长度、单次结果大小、每客户端调用频率，并对成功结果缓存 30 秒。浏览器无法指定上游 URL，也无法获得 API Key。查询端点与现有刷新路由一样要求 `X-FluxDesk-Request: 1`，不发送跨域许可头；现有 `/.cloud` 排除和 SPA 兜底保持不变。服务端错误不会输出 Key。

这项扩展只覆盖公开 REST 接口。Market Dumps 批量文件、CLI、本地 DuckDB、MCP、Agent Skill 属于其他交付方式；端内专用或尚未开放的接口不能通过当前 Key 调用。站点后端仍需设置 `HITHINK_FINANCE_API_KEY`。使用基金回测等复杂接口时，应按对应文档填写条件 JSON 或枚举；上游权限、限流和数据准备状态以实际返回的 `code`、`message` 为准。
