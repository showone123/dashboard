# 迁移执行记录

> 规则：每执行一条语句后在本表追加一行。`执行方式` 列写 `db_exec_sql(migrate)` / `db_exec_sql(write)` / `db_exec_sql(read)`。
> 这份记录的目的是：新环境重建时能对照着确认「哪些已经跑过」，以及出问题时能定位「哪一步改了它」。

## 已应用

| # | 迁移 | 内容 | 执行日 | 执行方式 | 结果 |
|---|---|---|---|---|---|
| 001 | `001_init.sql` | 4 张表 + 11 条 RLS 策略 + 表级授权 + 开启 RLS | 2026-09-15 ~ 09-16 | db_exec_sql(migrate) | ✅ 全部成功 |
| — | （过程内变更） | `notifications.created_by` 由 `uuid` 改为 `text` + 补 `DEFAULT auth.uid()` | 2026-09-16 | db_exec_sql(migrate) | ✅ 修复线上 22P02 报错 |
| — | （过程内变更） | 撤掉 `authenticated` 的 `TRUNCATE` / `REFERENCES`；确认 `anon` 全表零权限 | 2026-09-16 | db_exec_sql(migrate) | ✅ 三层验证通过 |

> 说明：上面两条「过程内变更」发生在 `001_init.sql` 定稿之前，已经被吸收进 `001_init.sql`
> 与 `db/DB_SCHEMA.sql` 的最终状态里。新环境执行 `001` 就会直接得到正确结果，**不需要**再单独跑这两步。
> 保留记录是为了 someday 排查老环境时能对上账。

## 验证证据（2026-09-16 实测）

| 检查 | 期望 | 实测 |
|---|---|---|
| `role_table_grants` 里 grantee='anon' 的行数 | 0 | 0 ✅ |
| 4 张表的 `relrowsecurity` | 全 true | 全 true ✅ |
| `pg_policies` 策略数 | 11 | 11 ✅ |
| 匿名 GET `/notifications` | 401 | 401 ✅ |
| 匿名 POST `/notifications`（字段合法，排除 400 干扰） | 401 | 401 ✅ |
| 匿名 GET `/operators` | 401 | 401 ✅ |
| 匿名 GET `/access_grants` | 401 | 401 ✅ |

## 待应用

| # | 迁移 | 内容 | 状态 |
|---|---|---|---|
| 002 | `002_activity.sql` | `access_grants` 加 `last_seen_at` + **REVOKE 表级 UPDATE** + **两条列级 GRANT**（心跳列 / 运营台改状态列）+ `grants_update_own_heartbeat` 策略 + 部分索引 | ⏸️ **尚未执行**（2026-09-21 本地完成 + 已过门禁，等用户批准后再上生产） |

执行顺序（**6 条语句，一条一次调用** `db_exec_sql(mode=migrate)`）：

| 序 | 语句 | 作用 |
|---|---|---|
| 1 | `ALTER TABLE ... ADD COLUMN IF NOT EXISTS last_seen_at timestamptz` | 加心跳字段 |
| 2 | `REVOKE UPDATE ON public.access_grants FROM authenticated` | 撤掉全列 UPDATE |
| 3 | `GRANT UPDATE (last_seen_at) ON public.access_grants TO authenticated` | 心跳只写这一列 |
| 4 | `GRANT UPDATE (status, plan, expires_at, updated_at, note) ... TO authenticated` | ★ 运营台改状态用的列 |
| 5 | `DROP POLICY IF EXISTS grants_update_own_heartbeat` + `CREATE POLICY ...` | 本人写自己那行 |
| 6 | `CREATE INDEX IF NOT EXISTS access_grants_last_seen_idx ...` | 在线人数排序 |

> ⚠️ **002 不能只挑着跑**：
> - 只加列不加 GRANT ⇒ 心跳全静默失败（前端 catch 吞掉，看不出错）。
> - 只 GRANT 不 REVOKE ⇒ **普通用户可自助开通**（`authenticated` 原本有全列 UPDATE，
>   加了自己的行政策就等于把 status 交给用户）。
> - **只授 `last_seen_at` 不授第 4 条的运营列 ⇒ 运营台「开通 / 暂停」按钮先报 42501**。
>   运营台走的是**同一个 `authenticated` 角色**（前端只是普通 `update(patch)`，
>   没有 service_role 通道）。行级隔离靠策略，列级隔离靠 GRANT —— 两层各管一件事。
> - 第 4 条**绝不能含** `owner_id` / `id` / `created_at`（那是提权面）。

执行后按 `verify.py §6.5` 的聚合口径复核：策略总数应为 **12**。
**回滚**：`GRANT UPDATE ON public.access_grants TO authenticated;`（恢复表级全列）
+ `DROP POLICY IF EXISTS grants_update_own_heartbeat ...`；`last_seen_at` 列可留（可空，不影响旧代码）。
