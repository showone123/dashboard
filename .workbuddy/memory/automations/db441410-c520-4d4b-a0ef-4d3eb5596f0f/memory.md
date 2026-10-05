# 自动化执行记录：GitHub 热点项目日报

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
- 上轮榜单（作为"昨天"对比基准）存于 assets/hot-projects.json（每次正式生成前先读它的 items[].name 作对比）。
- curl 输出文件不要写 `/tmp/`（Git Bash 与 Python 对 /tmp 解析不一致），统一落在工作目录内。
- 「热点榜」永远是 20 条（`--top 20` 写死）；别把"只有 20"当成没上线。
- 2026-10-04 起「收录项目」是**公开只读展示页**，前端无写入口；新收录走 `db_exec_sql` 管理通道（owner_id 必须显式给）。

## 2026-10-03 22:10
- 抓取 trending 日榜 19 条 + 周榜 18 条，去重后 20 个候选；新面孔 7 个；verify 59 项全绿；commit cdb5c64。
