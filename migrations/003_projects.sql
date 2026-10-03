-- =============================================================================
--  migration 003_projects —— GitHub 项目收藏改为「运营方独占 + 云端存储」
--  applicationId : wbapp_SzEJc2waV6zqr78qhIU3M1
--  生成基准日   : 2026-10-03
--
--  需求（2026-10-03）：
--    「把这个 GitHub 项目上传功能改成管理员独占，且数据保存到服务器而非本地。」
--    改动前：模块数据全在 localStorage（fluxdesk_projects_v1:<userId>），
--            任何登录用户都能看见并录入 —— 换设备/换浏览器就丢，且是多份互不相干的副本。
--    改动后：数据落 public.projects；只有 operators 名单里的人能读写；
--            前台导航项对非运营方隐藏。
--
--  ⚠️ 执行方式：db_exec_sql，**一条语句一次调用**（不支持多语句）。
--     参数：mode = migrate。按下面的顺序 1/6 → 6/6 逐条执行。
--
--  ⚠️ 本迁移改动 db/DB_SCHEMA.sql 的表/策略清单 → 必须同步更新那份快照
--     与 contract.json 的 db_tables / db_policies，否则 verify.py 会 FAIL
--     （三份清单强校验一致）。
--
--  设计要点（别删，这是安全与正确性底线）：
--
--    1. ★ 独占靠**策略**，不靠前端隐藏。
--       前端只是把导航项藏起来（体验），真正的门在 RLS：
--       四条动作（读/增/改/删）全部要求 auth.uid() 出现在 operators 里。
--       非运营方即使手工构造 REST 请求，也只会拿到 0 行 / 被拒。
--
--    2. ★ 用一条 FOR ALL 策略，不拆成四条。
--       理由：本表的权限模型是"全有或全无"（要么是运营方、能碰全部动作，
--       要么不是、一个动作都不许），拆开只是把同一个 EXISTS 抄四遍，
--       反而增加"漏配一条 → 某个动作 42501"的风险。
--       与既有 notifications_operator_write 的写法保持一致。
--
--    3. ★ id 用**前端生成的 text**，不用 bigint IDENTITY。
--       模块的 Excel 导入/导出、热点卡片「收进我的库」都用前端 uid()（p<base36>）
--       作为行标识。沿用同一个 id 让"重复导入同一份 Excel"可以走 upsert 幂等覆盖，
--       而不是每导一次多一批重复行。id 作为主键**全局唯一**（uid() 带时间戳 + 5 位随机），
--       所以将来即使有多个运营方也不会互相撞号。
--       ⚠️ 不要再加 UNIQUE (owner_id, id) —— 主键已蕴含它，纯冗余索引（初版加过，已 DROP）。
--
--    4. ★ owner_id 是 text 且 DEFAULT auth.uid()。
--       平台 user.id 是 19 位数字字符串（例：2099891421614968832），不是 uuid。
--       客户端 insert 的字段集里**绝不能出现 owner_id** —— 交给列默认值。
--       （verify.py 有专门的哨兵扫描；本迁移配套把扫描范围扩展到 projects.js。）
--
--    5. ★ stars 用 integer，不用 text。
--       筛选/排序要按数值比较；存 text 会让 "9000" < "10000"。
--       前端已在 toStars() 里做过清洗，这里再加 CHECK 兜底防负数。
--
--    6. added_at 是**业务字段**（入库日期）而非审计时间，所以用 text 'YYYY-MM-DD'，
--       与 Excel 模板那一列逐字一致，避免时区把 10-03 变成 10-02。
--       created_at / updated_at 才是审计时间，用 timestamptz。
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1/6  建表
--      字段顺序与 build/projects.js 的 COLS、Excel 模板 8 列一一对应，
--      改这里必须同时改那两处（check_projects.js 会挡）。
-- ---------------------------------------------------------------------------
CREATE TABLE public.projects (
    id          text        NOT NULL,                    -- 前端 uid()，如 'pm1x2y3z4'
    owner_id    text        NOT NULL DEFAULT auth.uid(), -- 19 位数字字符串，绝不能是 uuid
    added_at    text        NOT NULL,                    -- 入库日期 'YYYY-MM-DD'（业务字段）
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


-- ---------------------------------------------------------------------------
-- 2/6  表级授权（第 1 道门）
--      只授 authenticated 的四个 DML 动作；anon 一律不授。
--      没有序列要授 —— id 由前端生成，表里没有 IDENTITY / serial。
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.projects TO authenticated;

-- 收紧：不要把能绕过 RLS 的权限留在这张新表上。
-- ⚠️ 001 里的 `REVOKE ... ON ALL TABLES` 只覆盖**当时已存在**的表，
--    新表必须自己再收一次，否则默认集会带上 TRUNCATE / REFERENCES。
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.projects FROM authenticated, anon;
REVOKE ALL ON public.projects FROM anon;


-- ---------------------------------------------------------------------------
-- 3/6  开启行级安全（第 2 道门）
-- ---------------------------------------------------------------------------
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;


-- ---------------------------------------------------------------------------
-- 4/6  策略：运营方独占（唯一一条）
--      · USING     管 SELECT / UPDATE / DELETE 可见哪些行
--      · WITH CHECK 管 INSERT / UPDATE 允许写入什么
--      两个都要写 EXISTS —— 只写 USING 的话，非运营方能往表里灌数据；
--      只写 WITH CHECK 的话，读不到任何行但写得进去。
--      ⚠️ PostgreSQL 无 CREATE POLICY IF NOT EXISTS，先 DROP 保证幂等。
--         （verify.py 提取策略清单时会先剥掉 -- 注释，注释里写什么都无害）
--      ⚠️ 子查询里的 public.operators 自身也走 RLS：operators_read_own 让
--         每个用户只能看到自己那一行 —— 恰好就是这里需要的语义
--         （运营方查到自己的行 → true；非运营方查到空集 → false）。
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS projects_operator_all ON public.projects;

CREATE POLICY projects_operator_all ON public.projects
    FOR ALL TO authenticated
    USING      (EXISTS (SELECT 1 FROM public.operators o WHERE o.owner_id = auth.uid()))
    WITH CHECK (EXISTS (SELECT 1 FROM public.operators o WHERE o.owner_id = auth.uid()));


-- ---------------------------------------------------------------------------
-- 5/6  索引：列表按入库日期倒序翻页，且一律先按 owner_id 收窄
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS projects_owner_added_idx
    ON public.projects (owner_id, added_at DESC);


-- ---------------------------------------------------------------------------
-- 6/6  上线自检（执行完在库里跑，两条都应返回预期值）
--
--   6a. 策略只有一条、且是 ALL：
--       SELECT policyname, cmd, roles FROM pg_policies
--       WHERE schemaname='public' AND tablename='projects';
--       期望：projects_operator_all | ALL | {authenticated}
--
--   6b. RLS 已开：
--       SELECT relrowsecurity FROM pg_class WHERE relname='projects';
--       期望：t
--
--   6c. 匿名请求必须被拒（拿 publishableKey 直接打 REST，期望 401 而不是 200）：
--       curl -i "<endpoint>/.cloud/database/rest/projects?select=*" \
--            -H "x-wb-webapp-access-key: <publishableKey>"
-- =============================================================================
