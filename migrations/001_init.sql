-- =============================================================================
--  migration 001_init —— 铜数据看板 · 订阅版 初始结构
--  applicationId : wbapp_SzEJc2waV6zqr78qhIU3M1
--  生成基准日   : 2026-09-16（含 notifications.created_by 的 text 修正）
--
--  ⚠️ 执行方式：WorkBuddy 云服务的 db_exec_sql，**一条语句一次调用**
--     （该工具不支持多语句）。所以本文件是按「按顺序逐条复制执行」的形态写的，
--     不要把整份文件粘进一次调用里。
--     参数：mode = migrate（绕过 RLS 的管理员角色）
--
--  ⚠️ 这是**已应用**的初始迁移，不要再执行它。
--     新环境要重建，按顺序执行 001 → 002 → … 即可。
--     要改结构，请在 migrations/ 下新增 00N_xxx.sql，
--     **不要改本文件** —— 否则老环境与新环境会分叉（见 migrations/README.md）。
--
--  ⚠️ 可读版结构文档在 db/DB_SCHEMA.sql（同一套结构的带注释快照）。
--     两份文件的表/策略清单被 verify.py 强校验必须一致，改一处必须同步另一处。
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1/7  access_grants —— 订阅授权
--      owner_id 承接 auth.uid()：平台 user.id 是 19 位数字字符串，**必须是 text**
-- ---------------------------------------------------------------------------
CREATE TABLE public.access_grants (
    id          bigint GENERATED ALWAYS AS IDENTITY,
    owner_id    text        NOT NULL DEFAULT auth.uid(),
    status      text        NOT NULL DEFAULT 'pending',
    plan        text        NOT NULL DEFAULT 'trial',
    expires_at  timestamptz,
    note        text,
    email       text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT access_grants_pkey      PRIMARY KEY (id),
    CONSTRAINT access_grants_owner_key UNIQUE (owner_id)
);

-- ---------------------------------------------------------------------------
-- 2/7  datasets —— 用户上传的 Excel 元信息（文件本体在云存储）
-- ---------------------------------------------------------------------------
CREATE TABLE public.datasets (
    id           bigint GENERATED ALWAYS AS IDENTITY,
    owner_id     text        NOT NULL DEFAULT auth.uid(),
    name         text        NOT NULL,
    storage_path text        NOT NULL,
    size_bytes   bigint,
    mime_type    text,
    data_date    text,
    sheet_count  integer,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT datasets_pkey PRIMARY KEY (id)
);

-- ---------------------------------------------------------------------------
-- 3/7  notifications —— 站内通知
--      注意 id 用 bigserial（历史遗留），与上面两张表的 IDENTITY 不一致，功能等价
--      created_by 是 text（曾经误建为 uuid，导致线上 22P02 错误，见 db/DB_SCHEMA.sql）
-- ---------------------------------------------------------------------------
CREATE TABLE public.notifications (
    id          bigserial,
    title       text        NOT NULL,
    body        text        NOT NULL,
    level       text        NOT NULL DEFAULT 'info',
    published   boolean     NOT NULL DEFAULT true,
    created_by  text        DEFAULT auth.uid(),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT notifications_pkey PRIMARY KEY (id)
);

-- ---------------------------------------------------------------------------
-- 4/7  operators —— 运营方白名单（表级无写权限，只能从后台写入）
-- ---------------------------------------------------------------------------
CREATE TABLE public.operators (
    owner_id   text        NOT NULL DEFAULT auth.uid(),
    label      text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT operators_pkey PRIMARY KEY (owner_id)
);


-- ---------------------------------------------------------------------------
-- 5/7  表级授权（第 1 道门）。anon 一律零权限。
--      GRANT 与 POLICY 缺一不可：只建策略不 GRANT 会得到形似策略失效的 42501。
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE         ON public.access_grants TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.datasets      TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notifications  TO authenticated;
GRANT SELECT                          ON public.operators     TO authenticated;

-- bigserial / IDENTITY 都需要序列权限，否则 insert 报 permission denied for sequence
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- 收紧：这两项能绕过 RLS（TRUNCATE 直接清空、REFERENCES 走外键侧信道）
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES    IN SCHEMA public FROM authenticated, anon;
REVOKE ALL                            ON ALL SEQUENCES IN SCHEMA public FROM anon;


-- ---------------------------------------------------------------------------
-- 6/7  开启行级安全（第 2 道门）
-- ---------------------------------------------------------------------------
ALTER TABLE public.access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.datasets      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operators     ENABLE ROW LEVEL SECURITY;


-- ---------------------------------------------------------------------------
-- 7/7  RLS 策略（11 条）。模型：read-own + operator-override
-- ---------------------------------------------------------------------------

-- access_grants：自己看自己
CREATE POLICY grants_read_own ON public.access_grants
    FOR SELECT TO authenticated
    USING (owner_id = auth.uid());

-- access_grants：自助申请。WITH CHECK 是防提权的关键，不要放开
CREATE POLICY grants_insert_self_pending ON public.access_grants
    FOR INSERT TO authenticated
    WITH CHECK (
        owner_id = auth.uid()
        AND status = 'pending'
        AND plan <> 'operator'
        AND expires_at IS NULL
    );

-- access_grants：运营方读全部
CREATE POLICY grants_operator_read ON public.access_grants
    FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM public.operators o WHERE o.owner_id = auth.uid()));

-- access_grants：运营方改全部（审批 / 续期 / 暂停）
CREATE POLICY grants_operator_update ON public.access_grants
    FOR UPDATE TO authenticated
    USING      (EXISTS (SELECT 1 FROM public.operators o WHERE o.owner_id = auth.uid()))
    WITH CHECK (true);

-- datasets：四个动作都限自己
CREATE POLICY datasets_read_own ON public.datasets
    FOR SELECT TO authenticated USING (owner_id = auth.uid());

CREATE POLICY datasets_insert_own ON public.datasets
    FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());

CREATE POLICY datasets_update_own ON public.datasets
    FOR UPDATE TO authenticated
    USING      (owner_id = auth.uid())
    WITH CHECK (owner_id = auth.uid());

CREATE POLICY datasets_delete_own ON public.datasets
    FOR DELETE TO authenticated USING (owner_id = auth.uid());

-- notifications：已发布全体可读；草稿仅运营方可见
CREATE POLICY notifications_read ON public.notifications
    FOR SELECT TO authenticated
    USING (
        published = true
        OR EXISTS (SELECT 1 FROM public.operators o WHERE o.owner_id = auth.uid())
    );

-- notifications：只有运营方可增删改
CREATE POLICY notifications_operator_write ON public.notifications
    FOR ALL TO authenticated
    USING      (EXISTS (SELECT 1 FROM public.operators o WHERE o.owner_id = auth.uid()))
    WITH CHECK (EXISTS (SELECT 1 FROM public.operators o WHERE o.owner_id = auth.uid()));

-- operators：只能查自己（前端据此判断"我是不是运营方"）。
-- 没有 INSERT/UPDATE/DELETE 策略 —— 提权路径从数据库层就断掉了，不要加。
CREATE POLICY operators_read_own ON public.operators
    FOR SELECT TO authenticated USING (owner_id = auth.uid());


-- ---------------------------------------------------------------------------
-- 执行完毕后自检（各自单独跑一次）
-- ---------------------------------------------------------------------------
-- 期望 0 行：
--   SELECT table_name, privilege_type FROM information_schema.role_table_grants
--   WHERE table_schema='public' AND grantee='anon';
-- 期望 4 行且 rls_on 全为 true：
--   SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
--   WHERE n.nspname='public' AND c.relkind='r';
-- 期望 11 行：
--   SELECT tablename, policyname, cmd FROM pg_policies WHERE schemaname='public';
