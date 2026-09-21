# 股票工作台

每个登录用户可保存最多 10 只 A 股。输入六位代码即可自动补齐交易所，页面每 30 秒检查行情；选择股票后自动组合近一年日线、估值快照、上一年度财务指标和近期异动。页面只做资料整理，不提供下单或投资建议。

浏览器只请求本站 `GET /api/stocks?codes=600519.SH,000001.SZ`，并携带 `X-FluxDesk-Request: 1`；`build/stocks_service.py` 在服务端校验代码、调用同花顺 `GET /api/a-share/prices/snapshot`，只返回页面需要的字段并保留 `null`。服务端按股票代码缓存 30 秒，避免每个浏览器轮询都消耗上游调用。请求失败返回 503，页面保留上次显示的行情。自选列表仅存在当前浏览器的 `fluxdesk_stocks_v1:<用户ID>` 中，不进入客户数据库。

密钥优先从服务端环境变量 `HITHINK_FINANCE_API_KEY` 读取。当前 WorkBuddy 发布工具没有环境变量入口，因此部署方需在发布目录写入 `dist/.hithink_key` 作为兜底；文件只放一行密钥，不加变量名或引号。该点文件已被 Git 忽略，静态服务器会把点文件请求回退到首页。不要把 Key 放进源码、测试、`.env.example`、前端、Git 或公开日志。发布时必须同步更新整个 `dist/`，并确认应用服务器可以出站访问 `https://fuyao.aicubes.cn`。本次没有数据库迁移，也没有改变现有登录、上传与云服务配置。

服务端路由有意从原来的期货缓存接口扩展出只读的股票行情接口，因此同步更新了 `contract.json` 中的 `server_py_sha256`、`server_py_bytes` 及 `_note_server`。既有 `/.cloud` 排除、SPA 兜底与期货接口保持原样。上线前执行 `python verify.py` 和 `python -m unittest discover -s tests -p test_stocks.py -v`。线上用浏览器登录后打开“股票工作台”，核对行情时间、添加和移除股票、自动更新与服务端未配置 Key 时的错误提示。

当前接口供网页匿名读取，可能消耗账号配额；每次最多 10 只且有 30 秒服务端缓存。如果网站遭到大量不同代码的请求，应在网关增加限流或接入已有会话校验。此限制不影响页面已有的登录门禁。

## 资料看板与导出

页面不再把 79 个底层接口和原始参数直接暴露给用户。它固定调用行情、历史 K 线、估值、财务指标和个股异动接口，并由 `build/stock_render.js` 把真实响应转换成中文卡片、折线图和表格。`build/financial_catalog.json` 仍作为服务端路径和参数白名单。

用户可下载自选行情 CSV、近一年走势 CSV 和完整股票简报 TXT。下载文件带中文字段名和可读日期，不提供 JSON 下载。切换股票才会读取资料看板，行情快照继续按 30 秒刷新。

浏览器向本站 `POST /api/finance/query` 发送接口 ID 和参数。`build/financial_service.py` 仅允许目录中列出的固定路径和参数，限制请求体、参数长度、单次结果大小、每客户端调用频率，并对成功结果缓存 30 秒。浏览器无法指定上游 URL，也无法获得 API Key。查询端点与现有刷新路由一样要求 `X-FluxDesk-Request: 1`，不发送跨域许可头；现有 `/.cloud` 排除和 SPA 兜底保持不变。服务端错误不会输出 Key。

站点后端仍需设置 `HITHINK_FINANCE_API_KEY`。上游权限、限流和数据准备状态以实际返回的 `code`、`message` 为准。
