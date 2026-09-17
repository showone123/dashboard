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

（无）
