# 数据库迁移

## 三个文件的角色，别搞混

| 文件 | 角色 | 能不能改 |
|---|---|---|
| `db/DB_SCHEMA.sql` | **期望状态快照（带注释，面向人读）**。描述"数据库现在应该长什么样"，含设计意图、防提权说明、变更历史。 | 改结构时必须同步更新 |
| `migrations/001_init.sql` | **可执行的初始迁移**。新环境从零重建时按序执行。 | **不要改**（已应用过；改了会让老环境与新环境分叉） |
| `migrations/00N_*.sql` | 后续增量变更，一条迁移一个新编号。 | 新增 |

`verify.py` 会强校验 `db/DB_SCHEMA.sql` 与 `migrations/001_init.sql` 的**表和策略清单必须完全一致**。
只改一处会直接 FAIL —— 这是故意的，防止"文档写的是一个样、实际跑的是另一个样"。

---

## 怎么执行迁移

数据库只能通过 **WorkBuddy 云服务的 `db_exec_sql`** 操作（没有 psql，没有直连，
工作区里也没有数据库密码 —— 这是平台设计，不是配置缺失）。

```
mode        = migrate      （绕过 RLS 的管理员角色；read 只读、write 数据变更）
applicationId = wbapp_SzEJc2waV6zqr78qhIU3M1
```

### ⚠️ 一次调用只能执行一条语句

`db_exec_sql` **不支持多语句**。所以 `.sql` 文件是给人「按顺序逐条复制」用的，
不要整份粘进一次调用。

需要执行的语句数不多（`001_init.sql` 约 23 条），但**顺序不能乱**：

```
CREATE TABLE  →  GRANT  →  ENABLE ROW LEVEL SECURITY  →  CREATE POLICY
```

顺序错了会得到两个典型症状：

| 症状 | 原因 |
|---|---|
| `42501 permission denied for table xxx`，但策略明明建了 | 漏 GRANT，或 GRANT 在策略创建之后 |
| `permission denied for sequence xxx_id_seq` | 漏 `GRANT USAGE, SELECT ON SEQUENCE`（IDENTITY / bigserial 都需要） |
| 策略建不上、提示关系不存在 | 表还没建 |

### SQL 里有引号或换行容易转义出错时

改用 `sqlBase64` 传同一条语句的 base64 编码（语义完全一样，只是省掉转义麻烦）。

---

## 新增一条迁移

1. 建 `migrations/00N_描述.sql`（编号连续，描述用英文小写+下划线）。
2. 文件头写清：**为什么改**、**影响哪些已有数据**、**回滚怎么做**。
3. 逐条执行，每条执行完在 `_applied.md` 里记一行。
4. **同步更新 `db/DB_SCHEMA.sql`**，让快照回到"期望状态"。
5. 若改动了表名 / 策略名 / 列类型，**同步更新 `contract.json` 的 `frozen_contracts.db_*`**，
   否则 `verify.py` 会 FAIL（这正是它该做的事）。
6. 重跑 `python verify.py`。

### 编号约定

- `001_init` —— 初始结构（已应用）
- `002_` 起 —— 增量
- 破坏性变更（删列、改类型、改策略语义）建议单独一条迁移，不要和新增混在一起，
  方便出问题时单独回滚。

---

## 已知的注意事项（改结构前先读）

1. **承接 `auth.uid()` 的列必须是 `text`**。平台 user.id 是 19 位数字字符串（例 `2099891421614968832`），
   不是 uuid。曾经把 `notifications.created_by` 建成 uuid，运营方一点发布就报
   `invalid input syntax for type uuid`（22P02）。新建此类列之前先查同类列：
   ```sql
   SELECT table_name, column_name, data_type, column_default
   FROM information_schema.columns
   WHERE table_schema='public' AND column_name IN ('owner_id','created_by');
   ```
2. **不要给 `authenticated` / `anon` 授 `TRUNCATE`、`REFERENCES`、`TRIGGER`** —— 这三项能绕过 RLS。
3. **不要给 `operators` 表加写策略**。运营方身份只能从后台写入，这是提权路径的封堵点。
4. **不要放开 `grants_insert_self_pending` 的 `WITH CHECK`** —— 放开后任何用户都能给自己发
   永久 operator 套餐。
5. **不要动 `notifications.id` 的 `bigserial`**。虽然与另外两张表的 `GENERATED ALWAYS AS IDENTITY`
   不一致，但改成 IDENTITY 需要迁移主键并可能撞上正在使用的 id，风险大于收益。
6. **策略的 `cmd` 用的是 `FOR ALL`**（`notifications_operator_write`），
   它会同时覆盖 SELECT/INSERT/UPDATE/DELETE。加新策略时注意别和它语义重叠成歧义。

---

## 当前状态

见 `_applied.md`。
