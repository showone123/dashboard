# 自动化执行记录：GitHub 热点项目日报

## 2026-10-13 20:30（含收录的正式轮）
- ⚠️ 第 1 次 trending 日榜 **WinError 10060 超时**（周榜 10 条）；**重跑第 2 次即正常** ⇒ 再次印证「trending 超时先重跑一次」这条，别急着判定页面结构变更。
- 第 2 次：trending 日榜 9 条 + 周榜 10 条 → **18 候选**（未触发搜索 API 兜底）。
- 对比 10-12 榜单，**新面孔 4 个**：debpalash/VoiceStudio、xtool-org/xtool、vercel-labs/skills、EpicGames/raddebugger
  （落榜 5 个：DuarteSantos8/openGym、Alishahryar1/free-claude-code、mvschwarz/openrig、microsoft/BitNet、open-webui/open-webui）。
- 18 条全部补中文简介 + 商业价值，无「未写商业价值」告警。分类覆盖 11 条（rea/mattpocock-skills/context-mode/tester-army-e2e/xtool/vercel-labs-skills/cursor-plugins → 开发者工具；design-diagram/hyperframes → 效率工具；gods-eye-view → 数据分析；AnyPS5 → 其他；flutter → 前端 UI）。
- ★ **新面孔 4 个 ≠ 入库 4 行**：VoiceStudio、raddebugger **早前已收录**（库中已有），按 `(url||name).toLowerCase()` 去重跳过 ⇒ 实际新增 **2 行**（xtool-org/xtool、vercel-labs/skills）。
  云表 61 → **63 行**，今日(10-13) 2 行。核验等式：63 = 61 + 2 ✓；今日 2 = 实际 INSERT 2 ✓。
- 门禁 verify.py：通过 59 项 / 0 失败（退出码 0）。
- GitHub 推送成功，**远端 commit sha：d4092db**（API 通道；本地 a1e6a33）。
- 部署：**本轮第 1 次即成功**（未出现 fetch failed）。
- 线上 4 项验收全绿：index.html sha256 一致 `35379c54…` / hot-projects.json content-type `application/json` / JSON 内容一致 18 条且顺序、字段（summary/biz/category）全同 / `/api/futures?category=futures` 200。
- 线上链接：https://data-dashboard-85191.app.workbuddy.host/
- 注：云表 63 行，远低于前端 1000 行读取上限，暂无需加筛选。

## 2026-10-12 20:00（含收录的正式轮）
- trending 日榜 9 条 + 周榜 11 条 → **19 候选**（trending 正常返回，未触发搜索 API 兜底）。
- 对比 10-11 榜单，**新面孔 5 个**：Alishahryar1/free-claude-code、mksglu/context-mode、microsoft/BitNet、open-webui/open-webui、DuarteSantos8/openGym
  （落榜 5 个：Apollo-11、pytorch、asd-ste100-skill、raddebugger、billion-context）。
- 19 条全部补中文简介 + 商业价值，无「未写商业价值」告警；分类覆盖：free-claude-code→效率工具、openGym→效率工具（自动判"运维部署"有误）、context-mode→开发者工具（自动判"运维部署"有误）。
- ★ **新面孔 ≠ 全部入库**：5 个新面孔里 openGym、context-mode **早前已被收录**（库里已有），按 `(url||name).toLowerCase()` 去重口径跳过 ⇒ 本轮实际新增 **3 行**。
  云表 58 → **61 行**，今日(10-12) 3 行。验证：61 = 58 + 3 ✓。
  ⇒ **以后对账口径修正**：核验等式应为「总行数 = 上一轮总行数 + 实际 INSERT 行数」，不是 "+ 新面孔数"；两者不等时先查是否被历史收录过。
- 门禁 verify.py：通过 59 项 / 0 失败（退出码 0）。
- GitHub 推送成功，**远端 commit sha：932434f**（API 通道；本地 f58ba40）。
- 部署：**本轮第 1 次即成功**（未出现 fetch failed）。
- 线上 4 项验收全绿：index.html sha256 一致 `35379c54…` / hot-projects.json content-type `application/json` / JSON 内容一致 19 条且顺序相同 / `/api/futures?category=futures` 200。
- 线上链接：https://data-dashboard-85191.app.workbuddy.host/
- 注：云表 61 行，远低于前端 1000 行读取上限，暂无需加筛选。

## 2026-10-12（非取数轮：修「收录日期停在 10-04」+ 任务改成含收录）
- ⚠️ **发现并修掉一条长期断链**：10-04 改版后「收录进云表」只写在文档里、没进自动任务
  ⇒ 热点榜天天更新，`public.projects` 却冻结在 22 行（10-04 起），代哥来问「收录日期怎么只到十月四号」。
- **本任务已升级**：更名 `GitHub 每日新星 → 项目收藏 + 云表收录（20:00）`，
  新增**步骤 5「收录进云表」**（原 5-9 顺延为 6-10），报告结尾要多给「收录结果」一行。
  ⇒ 以后每轮都要写库，别再只更新热点榜。
- **补账 36 行**：从 git 历史快照逐日求差（10-05~10-11），去掉库里已有 4 个；
  云表 22 → **58 行**，日期连续到 10-11；线上匿名读 `/.cloud/database/rest/projects` 实测 200 + 58 行。
- 只改数据**不需要重新部署**（前端直读云表）；dist/index.html sha256 仍 `35379c54…` 未变。
- 门禁 59/0。文档 `docs/HOT_PROJECTS.md` 已补收录口径与断更回填法。
- 备忘：查线上云表的正确姿势 = `https://data-dashboard-85191.app.workbuddy.host/.cloud/database/rest/projects`
  + 头 `x-wb-webapp-access-key`（**不是** `apikey`，也不是 `/rest/v1/...`，后者会被 SPA 兜底成 HTML）。

## 2026-10-11 20:00
- trending 日榜 8 条 + 周榜 12 条，去重后 **19 个候选**（trending 正常返回，未触发搜索 API 兜底）。
- 对比 10-10 榜单，**新面孔 6 个**：bilawalsidhu/gods-eye-view、lyogavin/airllm、chrislgarry/Apollo-11、danyuchn/asd-ste100-skill、flutter/flutter、ranxianglei/billion-context（落榜 7 个：openGym、knowledge-work-plugins、ppt-master、t3code、karpathy-skills、context-mode、huggingface/transformers）。
- 19 条全部补中文简介 + 商业价值，无「未写商业价值」告警；分类覆盖 11 条（rea/mattpocock-skills/e2e/openrig/cursor-plugins/asd-ste100-skill → 开发者工具；diagram-design/hyperframes → 效率工具；AnyPS5 → 其他；pytorch → AI / LLM；Apollo-11 → 学习资源；gods-eye-view → 数据分析；flutter → 前端 UI）。
- 门禁 verify.py：通过 59 项 / 0 失败。
- GitHub 推送成功，**远端 commit sha：fd481fb**（API 通道；本地 9f6ba48）。
- ⚠️ **sites 部署工具前两次报 `Error publishing site: fetch failed`，第三次成功** —— 与 trending 一样属间歇性网络问题，先重试再判定故障（本轮共试 3 次）。
- 部署上线 + 4 项验收全绿（index.html sha256 一致 `35379c54…` / JSON content-type 含 application/json / JSON 内容一致 19 条 / futures API 200）。
- 线上链接：https://data-dashboard-85191.app.workbuddy.host/

## 2026-10-10 20:00
- ⚠️ **首次 trending 抓取 WinError 10060 连接超时**（代理残留 + GitHub 间歇不可达）→ 自动退搜索 API 兜底；**重跑一次即恢复**（日榜 13 + 周榜 13 → 20 候选）。结论：trending 超时/IncompleteRead 先重跑一次，再判定页面结构变更。
- 对比 10-09 榜单，**新面孔 6 个**：tester-army/e2e、hugohe3/ppt-master、multica-ai/andrej-karpathy-skills、mksglu/context-mode、huggingface/transformers、pytorch/pytorch（落榜 6 个：Agent-Reach、agent-skills、open-code-review、lingbot-map、litellm、SwiftUI-Agent-Skill）。
- 20 条全部补中文简介 + 商业价值，无「未写商业价值」告警；分类覆盖 6 条（rea/mattpocock-skills/openrig/cursor-plugins/karpathy-skills/context-mode → 开发者工具；diagram-design/hyperframes/ppt-master → 效率工具；transformers/pytorch → AI / LLM）。
- 门禁 verify.py：通过 59 项 / 0 失败。
- GitHub 推送成功，**远端 commit sha：cc1ad3e**（API 通道；本地 6e88bea）。
- 部署上线 + 4 项验收全绿（index.html sha256 一致 `35379c54…` / JSON content-type=application/json / JSON 内容一致 20 条 / futures API 200）。
- 线上链接：https://data-dashboard-85191.app.workbuddy.host/
- 注：`--out ../_verify/x.json` 在 cwd=wb-checkout 下落到**上级 `2026-09-15-21-15-13/_verify/`**；`hot_biz.json` 同目录，可直接复用旧条目文案。

## 2026-10-09 20:00
- trending 日榜 11 条 + 周榜 11 条，去重后 **20 个候选**（trending 正常返回，未触发搜索 API 兜底）。
- 对比 10-08 榜单，**新面孔 6 个**：addyosmani/agent-skills、pingdotgg/t3code、alibaba/open-code-review、Robbyant/lingbot-map、BerriAI/litellm、twostraws/SwiftUI-Agent-Skill（落榜 2 个：pablostanley/yoinks、liquidslr/system-design-notes）。
- 20 条全部补中文简介 + 商业价值，无「未写商业价值」告警；自动分类纠正 10 条（morluto/rea、cathrynlavery/diagram-design → 开发者工具/效率工具；open-code-review、litellm → 开发者工具/AI·LLM 等镜像调整）。`_verify/hot_biz.json` 沿用旧条目文案 + 新增 6 条。
- 门禁 verify.py：通过 59 项 / 0 失败。
- GitHub 推送成功，**远端 commit sha：91d8c2a**（API 通道；本地 3d151c5）。
- 部署上线 + 4 项验收全绿（index.html sha256 一致 `35379c54…` / JSON content-type=application/json / JSON 内容一致 20 条 / futures API 200）。
- 线上链接：https://data-dashboard-85191.app.workbuddy.host/

## 2026-10-08 20:00
- trending 日榜 9 条 + 周榜 11 条，去重后 **16 个候选**（trending 正常返回，未触发搜索 API 兜底；本轮条目偏少属源站波动，非异常）。
- 对比 10-07 榜单，**新面孔 4 个**：storytold/artcraft、anthropics/knowledge-work-plugins、liquidslr/system-design-notes、earthtojake/text-to-cad。
- 16 条全部补中文简介 + 商业价值，无「未写商业价值」告警；自动分类纠正 7 条。
- 门禁 verify.py：通过 59 项 / 0 失败。
- GitHub 推送成功，**远端 commit sha：7d49ccf**（API 通道；本地 ac30a30）。
- 部署上线 + 4 项验收全绿（index.html sha256 一致 `35379c54…` / JSON content-type=application/json / JSON 内容一致 16 条 / futures API 200）。
- 线上链接：https://data-dashboard-85191.app.workbuddy.host/
- 注：`_verify/hot_biz.json` 会跨轮残留，其中不在当日候选里的条目会被忽略，可直接复用旧条目文案。

## 2026-10-07 20:00
- trending 日榜 13 条 + 周榜 11 条（本轮无网络抖动），去重后 20 个候选，**未触发搜索 API 兜底**。
- 对比 10-06 榜单，**新面孔 6 个**：cloudflare/security-audit-skill、addyosmani/agent-skills、trycua/cua、cursor/plugins、tile-ai/tilelang、EpicGames/raddebugger。
- 20 条全部补中文简介 + 商业价值，无「未写商业价值」告警；自动分类纠正 12 条。
- 门禁 verify.py：通过 59 项 / 0 失败。
- GitHub 推送成功，**远端 commit sha：bf21c07**（API 通道；本地 4fbb4d7）。
- 部署上线 + 4 项验收全绿（index.html sha256 一致 `35379c54…` / JSON content-type=application/json / JSON 内容一致 20 条 / futures API 200）。
- 线上链接：https://data-dashboard-85191.app.workbuddy.host/

## 2026-10-06 20:00
- trending 日榜 12 条 + 周榜 12 条（周榜首次 IncompleteRead 502，重跑即正常 → 遇此错先重跑一次，别急着判定页面结构变更）；去重后 20 个候选。
- 对比 10-05 榜单，**新面孔 9 个**：morluto/rea、mattpocock/skills、NVIDIA/OpenShell、VectifyAI/PageIndex、byoungd/up、deepseek-ai/DeepGEMM、ayghri/i-have-adhd、HunxByts/GhostTrack、cathrynlavery/diagram-design。
- 20 条全部补中文简介 + 商业价值，无「未写商业价值」告警；自动分类纠正 11 条。
- 门禁 verify.py：通过 59 项 / 0 失败。
- GitHub 推送成功，**远端 commit sha：e13242b**（API 通道；本地 938af5d）。
- 部署上线 + 4 项验收全绿（index.html sha256 一致 `35379c54…` / JSON content-type=application/json / JSON 内容一致 20 条 / futures API 200）。
- 线上链接：https://data-dashboard-85191.app.workbuddy.host/

## 2026-10-05 20:00（当日取数那轮）
- 抓取 trending 日榜 12 条 + 周榜 21 条，去重后 20 个候选（trending 正常，未触发搜索 API 兜底）。
- 对比 10-04 榜单，**新面孔 5 个**：boykopovar/AnyPS5、msitarzewski/agency-agents、DuarteSantos8/openGym、caddyserver/caddy、earthtojake/text-to-cad。
- 20 条全部补中文简介 + 商业价值，无「未写商业价值」告警；自动分类纠正 10 条。
- 门禁 verify.py：通过 59 项 / 0 失败。
- GitHub 推送成功，**远端 commit sha：3513f85**（API 通道；本地 commit 8c5bc96）。
- 部署上线 + 4 项验收全绿（index.html sha256 一致 `35379c54…` / JSON content-type=application/json / JSON 内容一致 20 条 / futures API 200）。
- 线上链接：https://data-dashboard-85191.app.workbuddy.host/

## 2026-10-04 23:xx（本轮：延续会话，非取数任务）
- 本轮**没有重新抓 trending**（当日 20:00 那轮已完成），而是把「收录项目」分区改成**纯只读展示页**并按用户要求上线。
- 去掉全部写入口（新增/编辑/删除/Excel 导入/模板/云同步条）；默认视图 = 全量按 `updated_at` 倒序。
- 迁移 **004 `projects_public_read`** 已应用生产（3 条语句）：anon 仅 SELECT、匿名 GET 200、匿名 POST 401、全库策略 14 条。
- 修掉一个**线上真实故障**：`app.js` 从未把 cloud 实例挂到 `window`，导致该模块线上永远"云服务未就绪"/空表。
- 门禁 59/0；新渲染验收 `_verify/run_collection_render.py` 38/0。
- 推送 **aad84e5**（远端 6542451）→ 部署覆盖上线 → 5 项线上复核全绿（字节一致 / 新标记存在 / 旧写入口为 0 / JSON 一致 / futures API 200）。
- ⚠️ 遗留决策：前端已无写入口 ⇒ 新收录只能由运维侧 `db_exec_sql` 写入。**默认不接自动补录**（自动灌会让展示表变流水账），已写进 docs/HOT_PROJECTS.md，等代哥定。

## 2026-10-04 20:00（当日取数那轮）
- 抓取 trending 日榜 16 条 + 周榜 19 条，去重后 20 个候选（trending 正常返回，未触发搜索 API 兜底）。
- 对比上轮（10-03 22:10 榜单）后，**新面孔 9 个**：NVIDIA/OpenShell、thedotmack/claude-mem、mvschwarz/openrig、coreyhaines31/marketingskills、tester-army/e2e、addyosmani/agent-skills、calesthio/OpenMontage、pablostanley/yoinks、michael-denyer/pstack-claude。
- 20 条全部补中文简介 + 商业价值；自动分类纠正 10 条（ponytail/paperclip/openrig/marketingskills/e2e/agent-skills/pstack-claude → 开发者工具；hyperframes/OpenCut/OpenMontage → 效率工具）。
- 门禁 verify.py：通过 59 项 / 0 失败。
- GitHub 推送成功，commit sha：**9cc4181**（API 通道）。
- 部署上线 + 4 项验收全绿（index.html sha256 一致 26d4ffb9… / JSON content-type=application/json / JSON 内容一致 20 条 / futures API 200）。
- 线上链接：https://data-dashboard-85191.app.workbuddy.host/

## 备注
- 本机残留代理，所有命令前需 `export no_proxy='*' NO_PROXY='*'`。
- `git remote remove origin` 在首次之后会报 "No such remote: 'origin'" —— 这是预期，别当失败；
  紧接着 `github_sync.py --push` 会打印 git push 失败并自动切 API 通道，看结尾的「新 commit」即可。
- 上轮榜单（作为"昨天"对比基准）存于 assets/hot-projects.json（每次正式生成前先读它的 items[].name 作对比）。
- curl 输出文件不要写 `/tmp/`（Git Bash 与 Python 对 /tmp 解析不一致），统一落在工作目录内。
- 「热点榜」永远是 20 条（`--top 20` 写死）；别把"只有 20"当成没上线。
- 2026-10-04 起「收录项目」是**公开只读展示页**，前端无写入口；新收录走 `db_exec_sql` 管理通道（owner_id 必须显式给）。

## 2026-10-03 22:10
- 抓取 trending 日榜 19 条 + 周榜 18 条，去重后 20 个候选；新面孔 7 个；verify 59 项全绿；commit cdb5c64。
