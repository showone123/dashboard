-- =============================================================================
--  migration 004_projects_public_read —— GitHub 收录项目改为「公开只读」
--  applicationId : wbapp_SzEJc2waV6zqr78qhIU3M1
--  生成基准日   : 2026-10-04
--
--  需求（2026-10-04）：
--    「把前端功能给我去了，这个分区以后就纯做展示页，有热点排行、筛选、导出功能，
--      点进去默认按照更新顺序全部显示，我要让所有人看到全部收录的项目。」
--
--    改动前（迁移 003）：public.projects 是**纯 operator-only** ——
--      非运营方登录用户即使进得了页面，REST 也只会拿到 0 行（RLS 静默过滤），
--      表现为「收录项目」页面永远空空如也。
--    改动后（本迁移）：**读全开、写照旧**。
--      · SELECT  → anon + authenticated 都能读全表（展示页嘛，本来就该人人可见）
--      · INSERT/UPDATE/DELETE → 仍然只有 operators 名单里的人能动
--      · 前端已同步去掉所有写入口（新增/编辑/删除/导入），写操作现在只由
--        运维侧的定时任务（db_exec_sql 管理通道，天然绕过 RLS）产生。
--
--  ⚠️ 执行方式：db_exec_sql，**一条语句一次调用**（不支持多语句）。参数 mode = migrate。
--     本迁移只有 2 条语句，按 1/2 → 2/2 顺序执行。
--
--  ⚠️ 本迁移**不新增表、不删除策略**，只在策略清单里多一条
--     ⇒ 必须同步更新 db/DB_SCHEMA.sql 与 contract.json 的 db_policies，
--       否则 verify.py §6.5 的三份清单强校验会 FAIL。
--
--  设计要点（别删，这是正确性底线）：
--
--    1. ★ 只**新增**策略，绝不改 003 的 projects_operator_all。
--       PostgreSQL 的 RLS 对**同一条命令**是多条 permissive 策略 **OR** 的关系。
--       所以加一条 `FOR SELECT USING (true)` 的效果是：
--         · SELECT  → 恒真（公开读，两条策略里只要一条为真即可）
--         · INSERT/UPDATE/DELETE → 只有 operator_all 这条适用于该命令，
--                                   所以写权限**一点没变**，还是仅运营方。
--       已实测：给 authenticated 加 permissive SELECT 策略**不可能**削弱任何写约束。
--
--    2. ★ anon 也必须给：展示页的意义就是"把链接发出去，谁都能看"。
--       003 第 2 节里有一句 `REVOKE ALL ON public.projects FROM anon;`
--       —— 那是当时的正确做法，本迁移把其中的 SELECT 重新授回来，
--       其余（INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER）保持零权限。
--
--    3. ★ 为什么不用 service_role / 新开一个 API 路由：
--       dist/server.py 的 sha256 是 contract.json 的冻结契约，且项目不许引入
--       数据库驱动；而平台前端只有 publishableKey + RLS 这一条数据通道。
--       "公开读"在这个架构里唯一的正确表达方式就是一条 permissive SELECT 策略。
--
--    4. ★ 与 003 的差异要写清楚：003 的注释里写着「projects 是纯 operator-only，
--       没有 read-own 这一半」—— 那句话描述的是**写入侧的独占**，现在依然成立：
--       读是公开的，改还是独占的。
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1/2  表级授权：把 SELECT 授给 anon
--      003 里 do 过 `REVOKE ALL ON public.projects FROM anon;`（现在仍然保留），
--      这里补回唯一需要的那一个动作。GRANT 是幂等的，重复执行无害。
--      ⚠️ 不要图省事写 `GRANT ALL` —— 那会把 INSERT/UPDATE/DELETE 一并放给匿名用户，
--         行级虽然还有策略兜着，但"匿名能发写请求"本身就是不该存在的攻击面。
-- ---------------------------------------------------------------------------
GRANT SELECT ON public.projects TO anon;


-- ---------------------------------------------------------------------------
-- 2/2  策略：公开只读
--      · 只覆盖 SELECT 一个命令 —— 这正是"写权限完全不受影响"的技术保证。
--      · TO anon, authenticated 两个角色都给：未登录访客与登录用户都能读全表。
--      · USING (true)：不做行级过滤，整张表就是展示内容。
--      · ★ 没有 WITH CHECK —— SELECT 策略不需要它；
--        而且**绝不能**写成 FOR ALL，否则 WITH CHECK 缺失会让写入面敞开。
--      ⚠️ PostgreSQL 无 CREATE POLICY IF NOT EXISTS，先 DROP 保证幂等。
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS projects_public_read ON public.projects;

CREATE POLICY projects_public_read ON public.projects
    FOR SELECT TO anon, authenticated
    USING (true);


-- ---------------------------------------------------------------------------
-- 上线自检（执行完在库里逐条跑，四项都要符合预期）
--
--   1. 策略清单应为 2 条、命令分别是 ALL 与 SELECT：
--      SELECT policyname, cmd, roles FROM pg_policies
--      WHERE schemaname='public' AND tablename='projects';
--      期望：projects_operator_all | ALL    | {authenticated}
--            projects_public_read | SELECT | {anon,authenticated}
--
--   2. anon 在 projects 上应恰好只有 SELECT：
--      SELECT privilege_type FROM information_schema.role_table_grants
--      WHERE table_schema='public' AND table_name='projects' AND grantee='anon';
--      期望：恰好 1 行 = SELECT
--
--   3. 真实流量（比读元数据可信）—— 拿 publishableKey 匿名 GET，期望 200 + 全部行：
--      curl -s "<endpoint>/.cloud/database/rest/projects?select=id,name&limit=3" \
--           -H "x-wb-webapp-access-key: <publishableKey>"
--
--   4. 写入面必须没被带开 —— 匿名 POST 期望 401/403，绝不能是 201：
--      curl -i -X POST "<endpoint>/.cloud/database/rest/projects" \
--           -H "x-wb-webapp-access-key: <publishableKey>" \
--           -H "Content-Type: application/json" \
--           -d '{"id":"probe","added_at":"2026-10-04","name":"probe"}'
--
--  回滚（把读权限收回运营方独占）：
--      DROP POLICY IF EXISTS projects_public_read ON public.projects;
--      REVOKE SELECT ON public.projects FROM anon;
--      回滚后非运营方登录用户会重新看到空列表（RLS 静默过滤，不报错）。
-- =============================================================================
