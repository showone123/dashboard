-- =============================================================================
--  铜数据看板 · 订阅版  ——  云数据库结构（PostgreSQL）
--  应用 applicationId : wbapp_SzEJc2waV6zqr78qhIU3M1
--  说明：本文件是「线上库当前真实结构」的等价重建脚本 + 参考文档。
--        逐字段、逐策略、逐授权与线上一致（已用 information_schema / pg_catalog 核对）。
--        执行方式：WorkBuddy Cloud Service 的 db_exec_sql（mode=migrate，单次一条语句）。
--
--  ⚠️ 三条必读前提（踩过的坑，见文末「变更历史」）
--  1. 平台 user.id 是 19 位数字字符串（例：2099891421614968832），**不是 uuid**。
--     凡是承接 auth.uid() 的列，类型必须是 text，否则插入时报
--     invalid input syntax for type uuid: "2099891421614968832"。
--  2. 建表（GRANT 到 authenticated/anon）与 RLS（CREATE POLICY）是两道独立的门。
--     只建策略不 GRANT → 会得到形似「策略失效」的 42501 权限错误。
--  3. 权限只授到需要的动作。**不要**把 TRUNCATE / REFERENCES 授给 authenticated 或 anon —
--     这两项能绕过 RLS（TRUNCATE 直接清空，REFERENCES 可外键侧信道）。
--     本库当前已收紧：authenticated 只有 INSERT/SELECT/UPDATE/DELETE，anon 全表零权限。
-- =============================================================================


-- =============================================================================
--  1. 表结构
-- =============================================================================

-- 1.1 访问授权表：谁可以用、什么套餐、什么时候到期。
--     每用户一行（owner_id 唯一）。status='pending' 表示已申请待运营方审批。
CREATE TABLE public.access_grants (
    id          bigint GENERATED ALWAYS AS IDENTITY,
    owner_id    text        NOT NULL DEFAULT auth.uid(),
    status      text        NOT NULL DEFAULT 'pending',   -- pending | active | suspended | expired（取值与 app.js evalGrant() 一一对应）
    plan        text        NOT NULL DEFAULT 'trial',     -- trial | basic | pro | operator
    expires_at  timestamptz,                              -- NULL = 不过期
    note        text,
    email       text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz,                             -- 最后活跃心跳（迁移 002）；NULL = 从未上报
    CONSTRAINT access_grants_pkey      PRIMARY KEY (id),
    CONSTRAINT access_grants_owner_key UNIQUE (owner_id)
);

-- 1.2 数据集表：用户上传的 Excel 元信息（文件本体在云存储，这里只存指针）。
CREATE TABLE public.datasets (
    id           bigint GENERATED ALWAYS AS IDENTITY,
    owner_id     text        NOT NULL DEFAULT auth.uid(),
    name         text        NOT NULL,
    storage_path text        NOT NULL,   -- 云存储里的对象路径
    size_bytes   bigint,
    mime_type    text,
    data_date    text,                   -- 数据日期（业务字段，文本，如 '2026-09-15'）
    sheet_count  integer,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT datasets_pkey PRIMARY KEY (id)
);

-- 1.3 通知表：运营方发布、全体用户可见的站内通知。
--     ⚠️ 与上面两张表不同：id 用的是 bigserial（nextval），不是 GENERATED ALWAYS AS IDENTITY。
--        这是历史遗留的不一致（建表时先有 notifications），功能上等价，勿盲目"统一"——
--        改 id 生成方式需要连带迁移数据，风险大于收益。
CREATE TABLE public.notifications (
    id          bigserial,
    title       text        NOT NULL,
    body        text        NOT NULL,
    level       text        NOT NULL DEFAULT 'info',   -- info | warn | success
    published   boolean     NOT NULL DEFAULT true,     -- false = 草稿，仅运营方可见
    created_by  text        DEFAULT auth.uid(),        -- ⚠️ text，不是 uuid（见文末变更历史）
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT notifications_pkey PRIMARY KEY (id)
);

-- 1.4 运营方白名单：在这个表里出现 owner_id 的用户，才被前台判定为运营方。
--     注意：表的写权限**没有**授给 authenticated，运营方身份只能由后台/管理员写入。
CREATE TABLE public.operators (
    owner_id   text        NOT NULL DEFAULT auth.uid(),
    label      text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT operators_pkey PRIMARY KEY (owner_id)
);

-- 1.5 GitHub 项目收藏表（迁移 003）：运营方独占的选题库。
--     ⚠️ 与 1.1~1.3 不同：id 是**前端生成的 text**（uid()，形如 'pm1x2y3z4'），
--        不是 bigint IDENTITY。原因见迁移 003 的设计要点 3：
--        Excel 批量导入要幂等，沿用前端 id 才能"重导同一份表 = 覆盖"而不是"再插一批"。
--     ⚠️ owner_id 必须 text（platform user.id 是 19 位数字字符串，不是 uuid）。
--     ⚠️ stars 必须是 integer：存 text 会让 "9000" < "10000"。
CREATE TABLE public.projects (
    id          text        NOT NULL,
    owner_id    text        NOT NULL DEFAULT auth.uid(),
    added_at    text        NOT NULL,                    -- 入库日期 'YYYY-MM-DD'（业务字段，非审计时间）
    name        text        NOT NULL,                    -- owner/repo
    url         text        NOT NULL DEFAULT '',
    category    text        NOT NULL DEFAULT '其他',
    summary     text        NOT NULL DEFAULT '',
    openness    text        NOT NULL DEFAULT '源码可见',
    stars       integer     NOT NULL DEFAULT 0,
    note        text        NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT projects_pkey     PRIMARY KEY (id),
    CONSTRAINT projects_stars_ck CHECK (stars >= 0)
);


-- =============================================================================
--  2. 表级授权（第 1 道门）
--     anon 一律零权限：未登录用户连表都摸不到，返回 401 / DATABASE_42501。
-- =============================================================================
GRANT SELECT, INSERT                  ON public.access_grants  TO authenticated;   -- 无 DELETE（授权记录只能由运营方处置）
-- ⚠️ access_grants 的 UPDATE **不在表级授予**，改为列级（迁移 002）。
--    原因：加了 grants_update_own_heartbeat 后，表级 UPDATE 会让客户能改自己的
--    status / expires_at / plan ⇒ 自助提权。列级授权是硬门槛：
--    PostgreSQL 要求 UPDATE 语句涉及的每一列都有权限，缺一列即 42501。
--    ⚠️ 但也**不能只授 last_seen_at**：运营台的「开通 / 暂停」按钮走的是同一个
--    authenticated 角色（前端只是普通 update(patch)，没有 service_role 通道），
--    只授一列会先把自己的运营台打挂。所以运营改状态用的列必须一并授出。
--    行级隔离靠策略（见 4.1 的 grants_update_own_heartbeat / grants_operator_update），
--    列级隔离靠这两条 GRANT —— 两层各管一件事，都不能省。
GRANT UPDATE (last_seen_at)           ON public.access_grants  TO authenticated;   -- 心跳（本人写自己那行）
GRANT UPDATE (status, plan, expires_at, updated_at, note)
                                      ON public.access_grants  TO authenticated;   -- 运营台改状态；⚠️ 绝不含 owner_id / id / created_at
GRANT SELECT, INSERT, UPDATE, DELETE ON public.datasets       TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notifications   TO authenticated;   -- 实际写入受 RLS 限制为运营方
GRANT SELECT                          ON public.operators      TO authenticated;   -- 只读，用于判断自己是不是运营方
-- projects（迁移 003）：四个 DML 动作都授，但行级被 projects_operator_all 收死成"仅运营方"。
-- ⚠️ 这张表**没有序列**要授 —— id 由前端生成（text），不是 IDENTITY / serial。
GRANT SELECT, INSERT, UPDATE, DELETE ON public.projects       TO authenticated;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.projects       FROM authenticated, anon;  -- 新表要自己再收一次，见下方说明
REVOKE ALL                            ON public.projects      FROM anon;

GRANT USAGE, SELECT ON SEQUENCE public.notifications_id_seq TO authenticated;     -- bigserial 需要显式序列权限
GRANT USAGE, SELECT ON SEQUENCE public.access_grants_id_seq TO authenticated;     -- IDENTITY 列同样需要
GRANT USAGE, SELECT ON SEQUENCE public.datasets_id_seq      TO authenticated;

-- 收紧：不要把能绕过 RLS 的权限留在 authenticated / anon 手上
-- ⚠️ 下面这句 `ON ALL TABLES` 只覆盖**执行那一刻已存在**的表。
--    迁移 003 新建的 public.projects 不在其中，所以它自己又单独 REVOKE 了一次
--    （见上面第 2 节的第三行）。新增表时别忘了这一步。
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES    IN SCHEMA public FROM authenticated, anon;
REVOKE ALL                            ON ALL SEQUENCES IN SCHEMA public FROM anon;


-- =============================================================================
--  3. 开启行级安全（第 2 道门）
-- =============================================================================
ALTER TABLE public.access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.datasets      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operators     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects      ENABLE ROW LEVEL SECURITY;


-- =============================================================================
--  4. RLS 策略（共 13 条）
--     模型：read-own + operator-override。
--       · 普通用户只能看/改 owner_id = auth.uid() 的行；
--       · operators 里登记过的用户额外获得「看全部 / 改全部」的旁路。
--       · projects 是**纯 operator-only**（没有 read-own 这一半）——
--         它不是「用户自己的数据 + 运营方能看」，而是「运营方独占」。
-- =============================================================================

-- ---- 4.1 access_grants（4 条）----
-- 自己看自己的授权
CREATE POLICY grants_read_own ON public.access_grants
    FOR SELECT TO authenticated
    USING (owner_id = auth.uid());

-- 新用户自助申请：只允许写"自己的 + pending + 非 operator 套餐 + 不过期"的行。
-- 这条 WITH CHECK 是防提权的关键 —— 否则用户可以自己给自己发一个永久 operator。
CREATE POLICY grants_insert_self_pending ON public.access_grants
    FOR INSERT TO authenticated
    WITH CHECK (
        owner_id = auth.uid()
        AND status = 'pending'
        AND plan <> 'operator'
        AND expires_at IS NULL
    );

-- 运营方读全部
CREATE POLICY grants_operator_read ON public.access_grants
    FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM public.operators o WHERE o.owner_id = auth.uid()));

-- 本人上报活跃心跳（迁移 002）：只动自己那一行。
-- ⚠️ 这条策略只解决"行"的边界，"列"的边界由上面的列级 GRANT 兜住 —— 两者缺一不可：
--    只给策略不收紧列 ⇒ 客户能改自己的 status/expires_at 提权；
--    只给列不建策略 ⇒ 行级 UPDATE 无策略 = 改不动任何行（42501 的另一个来源）。
--    USING 与 WITH CHECK 都限 owner_id：少写 WITH CHECK 就能把行"改嫁"给别人。
CREATE POLICY grants_update_own_heartbeat ON public.access_grants
    FOR UPDATE TO authenticated
    USING      (owner_id = auth.uid())
    WITH CHECK (owner_id = auth.uid());

-- 运营方改全部（审批通过/续期/禁用都走这条）
CREATE POLICY grants_operator_update ON public.access_grants
    FOR UPDATE TO authenticated
    USING      (EXISTS (SELECT 1 FROM public.operators o WHERE o.owner_id = auth.uid()))
    WITH CHECK (true);

-- ---- 4.2 datasets（4 条）----
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

-- ---- 4.3 notifications（2 条）----
-- 读：已发布的全体可见；草稿（published=false）只有运营方能看到。
CREATE POLICY notifications_read ON public.notifications
    FOR SELECT TO authenticated
    USING (
        published = true
        OR EXISTS (SELECT 1 FROM public.operators o WHERE o.owner_id = auth.uid())
    );

-- 写：只有运营方（增删改一体）。
CREATE POLICY notifications_operator_write ON public.notifications
    FOR ALL TO authenticated
    USING      (EXISTS (SELECT 1 FROM public.operators o WHERE o.owner_id = auth.uid()))
    WITH CHECK (EXISTS (SELECT 1 FROM public.operators o WHERE o.owner_id = auth.uid()));

-- ---- 4.4 operators（1 条）----
-- 只能查自己那一行 —— 前端据此判断"我是不是运营方"。
-- 没有 INSERT/UPDATE/DELETE 策略：提权路径从数据库层就断掉了。
CREATE POLICY operators_read_own ON public.operators
    FOR SELECT TO authenticated USING (owner_id = auth.uid());

-- ---- 4.5 projects（1 条）----
-- 运营方独占：读/增/改/删四个动作合成一条 FOR ALL，条件同一句 EXISTS。
-- ⚠️ 为什么不拆成四条（read/insert/update/delete）：
--    本表的权限模型是"全有或全无"，拆开只是把同一句 EXISTS 抄四遍，
--    反而多出"漏配一条 → 某动作 42501"的风险。语义上确实是一条规则。
-- ⚠️ USING 与 WITH CHECK **都要写**：
--    USING 管 SELECT/UPDATE/DELETE 能看到与能动哪些行；
--    WITH CHECK 管 INSERT/UPDATE 允许写进什么。
--    只写 USING ⇒ 非运营方能往表里灌数据；只写 WITH CHECK ⇒ 写得进但读不出。
-- ⚠️ 子查询里的 operators 自身也走 RLS（operators_read_own 只让每用户看到自己那行），
--    恰好就是这里要的语义：运营方 → 查到 1 行 → true；非运营方 → 空集 → false。
CREATE POLICY projects_operator_all ON public.projects
    FOR ALL TO authenticated
    USING      (EXISTS (SELECT 1 FROM public.operators o WHERE o.owner_id = auth.uid()))
    WITH CHECK (EXISTS (SELECT 1 FROM public.operators o WHERE o.owner_id = auth.uid()));


-- =============================================================================
--  5. 上线自检清单（每次改动权限后都应该跑一遍）
-- =============================================================================
--  5.1 确认 anon 在所有业务表上都是 0 权限：
--      SELECT table_name, privilege_type FROM information_schema.role_table_grants
--      WHERE table_schema='public' AND grantee='anon';        -- 期望：0 行
--
--  5.2 确认所有表都开了 RLS：
--      SELECT c.relname, c.relrowsecurity FROM pg_class c
--      JOIN pg_namespace n ON n.oid=c.relnamespace
--      WHERE n.nspname='public' AND c.relkind='r';            -- 期望：rls 全 true
--
--  5.3 列出全部策略核对数量（期望 13 条）：
--      SELECT tablename, policyname, cmd FROM pg_policies WHERE schemaname='public';
--
--  5.4 真实流量验证（比读元数据更可信）—— 拿 publishableKey 匿名请求：
--      curl -i -X POST "<endpoint>/.cloud/database/rest/notifications" \
--           -H "x-wb-webapp-access-key: <publishableKey>" \
--           -H "Content-Type: application/json" \
--           -d '{"title":"x","body":"y"}'
--      期望 401（而非 200/201）。再对 operators / access_grants 各测一次 GET。
--      注意：要确认不是 400（参数错误）冒充 401，所以 POST 时字段必须合法。


-- =============================================================================
--  6. 变更历史
-- =============================================================================
--  2026-09-16  notifications.created_by 类型修正（线上事故）
--      现象：运营方在后台点「发布通知」→ 报错
--            保存失败：invalid input syntax for type uuid: "2099891421614968832"
--      根因：建表时看到策略写的是 owner_id = auth.uid()，就把 created_by 也想当然
--            建成了 uuid；但平台下发的 user.id 是 19 位数字字符串。前端把 S.userId
--            显式放进 insert 字段集里，于是 Postgres 尝试把数字串转 uuid 失败。
--      修复：ALTER TABLE public.notifications
--                ALTER COLUMN created_by TYPE text USING created_by::text;
--            ALTER TABLE public.notifications
--                ALTER COLUMN created_by SET DEFAULT auth.uid();
--      配套（前端）：app.js 的 saveNotif() 的 insert 字段集里**不再包含** created_by，
--            交给列默认值 auth.uid() 生成。现在字段集恒为
--            { title, body, level, published, updated_at }。
--      教训：新建承接身份的列之前，先查 information_schema.columns 看同类列的类型，
--            不要从策略写法反推列类型。测试里也已加回归断言：insert 字段集不得含身份列。
--
--  2026-09-16  RLS 与授权收紧
--      确认 anon 在所有业务表上零权限；撤掉 authenticated 的 TRUNCATE / REFERENCES；
--      新增 notifications 表 + operators 表及其策略。
--
--  2026-10-03  migration 003_projects（GitHub 项目收藏：运营方独占 + 云端存储）
--      需求：「把这个 GitHub 项目上传功能改成管理员独占，且数据保存到服务器而非本地。」
--      改动前：模块数据全在 localStorage（fluxdesk_projects_v1:<userId>），
--              任何登录用户都看得见、都能录；换设备就丢，且是多份互不相干的副本。
--      改动后：public.projects（1.5）+ projects_operator_all（4.5）。
--      三个容易踩的点，已写进迁移文件：
--        (a) 独占靠**策略**不靠前端隐藏 —— 非运营方即使手搓 REST 请求也拿不到行；
--        (b) id 是前端生成的 text，Excel 批量导入才能幂等（重导同一份 = 覆盖）；
--        (c) ★ 新表要**自己** REVOKE 一次 TRUNCATE / REFERENCES / TRIGGER ——
--            001 里那句 `ON ALL TABLES` 只覆盖它执行时已存在的表。
--            实测线上 anon 在 projects 上权限为 0、authenticated 恰好四项 DML。
-- =============================================================================
