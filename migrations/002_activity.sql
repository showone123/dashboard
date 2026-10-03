-- =============================================================================
--  migration 002_activity —— 用户活跃心跳（在线状态 + 账户分析看板）
--  applicationId : wbapp_SzEJc2waV6zqr78qhIU3M1
--  生成基准日   : 2026-09-21
--
--  需求：运营台账号列表要显示「在线 / 离线」，并做注册量 / 活跃数折线看板。
--
--  ⚠️ 执行方式：db_exec_sql，**一条语句一次调用**（不支持多语句）。
--     参数：mode = migrate。按下面的顺序逐条执行。
--
--  ⚠️ 本迁移改动 db/DB_SCHEMA.sql 的表/策略清单 → 必须同步更新那份快照，
--     否则 verify.py 会 FAIL（两份清单强校验一致）。
--
--  设计要点（别删，这是安全底线）：
--    1. 心跳只能写「自己那一行、且只有 last_seen_at 这一列」。
--    2. access_grants 原有的表级授权是 **UPDATE 全列** ⇒ 一旦放开
--       「用户改自己行」的策略，客户就能自己把 status 改成 active、
--       把 expires_at 改到 2099 —— 订阅制产品的致命提权。
--    3. 所以必须先 REVOKE 全列 UPDATE，再按列 GRANT。
--       PostgreSQL 的 UPDATE 授权：只要持有**任意一列**的 UPDATE，
--       就要求对该语句**涉及到的每一列**都有权限，否则报 42501。
--       ⇒ 列级 GRANT 是硬门槛，不是建议。
--    4. ★ 关键陷阱：运营台的「开通 / 暂停」按钮走的是**同一个 authenticated
--       角色**（前端只是普通 update(patch)，没有 service_role 通道）。
--       只 GRANT last_seen_at 一列 ⇒ 运营台自己的按钮先报 42501。
--       所以必须把运营改状态要用的列一并授给同一角色。
--       行级隔离靠策略（下面 4/5），列级隔离靠 GRANT —— 两层各管一件事。
--    5. 顺序不能乱：DROP 旧策略 → REVOKE → GRANT(列) → CREATE POLICY。
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1/5  加字段：最后活跃时间
--      可空：存量行没有心跳，一律为 NULL（前端显示「从未活跃」）
-- ---------------------------------------------------------------------------
ALTER TABLE public.access_grants ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2/5  收口：撤掉全列 UPDATE
--      ⚠️ 与下一条必须成对执行；只 REVOKE 不 GRANT 会让心跳与运营台双双 42501
-- ---------------------------------------------------------------------------
REVOKE UPDATE ON public.access_grants FROM authenticated;

-- ---------------------------------------------------------------------------
-- 3/5  按列重新授权（缺任何一列，用到它的那条 UPDATE 就整条失败）
--      3a. 心跳：只许写 last_seen_at
-- ---------------------------------------------------------------------------
GRANT UPDATE (last_seen_at) ON public.access_grants TO authenticated;

-- ---------------------------------------------------------------------------
--      3b. 运营台改状态：运营台用的是同一个 authenticated 角色，
--          这里补上它 update(patch) 会碰到的列。
--          ⚠️ 别把 owner_id / id / created_at 加进来 —— 那是提权面。
-- ---------------------------------------------------------------------------
GRANT UPDATE (status, plan, expires_at, updated_at, note) ON public.access_grants TO authenticated;

-- ---------------------------------------------------------------------------
-- 4/5  策略：本人写自己的心跳
--      USING / WITH CHECK 都限定 owner_id = auth.uid()（缺一个就能改别人那行）
--      ⚠️ PostgreSQL 的策略语句没有 IF NOT EXISTS 写法，先 DROP 保证幂等
--      （verify.py 提取清单时会先剥掉 -- 注释，所以注释里写什么都无害）
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS grants_update_own_heartbeat ON public.access_grants;

CREATE POLICY grants_update_own_heartbeat ON public.access_grants
    FOR UPDATE TO authenticated
    USING      (owner_id = auth.uid())
    WITH CHECK (owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 5/5  索引：运营台按 last_seen_at 排序 / 数在线人数
--      仅给非空行建索引 —— 存量与从未活跃的用户进不了索引，省空间也更快
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS access_grants_last_seen_idx
    ON public.access_grants (last_seen_at DESC) WHERE last_seen_at IS NOT NULL;
