# 配方：建表与迁移

## 适用场景

新建业务表、给已有表加列或加索引。表结构只来自迁移：不用 TypeORM 的 `synchronize`，不手工改库。新表默认是**租户表**（带 `tenant_id`，ORM 自动按会话租户过滤），并且软删除（`deleted_at` + 生成列 `alive`）。

## 步骤

1. **建迁移文件。** 放在 `apps/server/src/db/migrations/`，文件名 `<14 位时间戳>-<短横线名称>.ts`，时间戳用**此刻的真实时间，精确到秒**（如 `date +%Y%m%d%H%M%S` 的输出），不要用整点整分，以免与模板以后发布的迁移撞车。类名是驼峰名称加同一时间戳，`name` 与类名相同：

   ```ts
   import type { MigrationInterface, QueryRunner } from 'typeorm'

   /** 客户：按租户隔离，软删除，编码在租户内唯一。 */
   export class CrmCustomer20261021143512 implements MigrationInterface {
     name = 'CrmCustomer20261021143512'

     async up(q: QueryRunner): Promise<void> {
       await q.query(`CREATE TABLE crm_customer (
         id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '客户 ID',
         code varchar(32) NOT NULL COMMENT '客户编码',
         name varchar(100) NOT NULL COMMENT '客户名称',
         dept_id bigint unsigned NULL COMMENT '所属部门 ID（数据权限）',
         tenant_id bigint unsigned NOT NULL COMMENT '租户 ID',
         created_by bigint unsigned NULL COMMENT '创建人 ID',
         created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
         updated_by bigint unsigned NULL COMMENT '更新人 ID',
         updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
         deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
         alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
         PRIMARY KEY (id),
         UNIQUE KEY uk_crm_customer_code (tenant_id, code, alive),
         KEY idx_crm_customer_dept (dept_id)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='客户'`)
     }

     async down(q: QueryRunner): Promise<void> {
       await q.query('DROP TABLE crm_customer')
     }
   }
   ```

   要点：
   - `tenant_id bigint unsigned NOT NULL`；每个唯一键以 `tenant_id` 开头、以 `alive` 结尾；没有唯一键的表加 `KEY idx_<表名>_tenant (tenant_id)`。
   - 审计列 `created_by/created_at/updated_by/updated_at` 与 `deleted_at` 对应实体基类 `BaseEntity`（`apps/server/src/core/db/base.entity.ts`）。
   - `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`，表和**每一列**都写 `COMMENT`（列注释是生成器的默认中文标签，写清楚）。
   - `id` 与 `*_by` 列用 `bigint unsigned`，`*_at` 列用 `datetime(3)`。
   - `down()` 必须完整撤销 `up()`：`db-migrations` 测试把全部迁移逐个回退到空库，再逐个重新执行并比对表结构。
   - 不建数据库外键。引用关系用 `referencedBy()` 登记（生成配置的 `options.referencedBy`，或像 `apps/server/src/modules/project.module.ts` 里 `demo_book.dept_id` → `iam_dept` 那样手写），删除被引用的行时返回 409。
   - 模板自带的表是先建表、后由 `apps/server/src/db/migrations/20261007100000-tenant.ts` 统一补上 `tenant_id` 并把唯一键改成 `(tenant_id, …, alive)` 的，没有一步建成的现成迁移可抄，新表照上面的例子一次写全。不要照抄 `apps/server/src/db/migrations/20261020153817-mcp.ts`：其中 `cfg_mcp_tool` 是平台表，`iam_access_token` 的唯一键是登记为全局唯一的例外，都不以 `tenant_id` 开头。

2. **只有例外才登记。** 全部租户共用、由平台统一维护的表，写进 `apps/server/src/db/project-tables.ts` 的 `PROJECT_PLATFORM_TABLES`（ORM 不给平台表加租户条件，所有租户读写同一批行）。租户表上必须跨租户唯一的键写进同一文件的 `PROJECT_GLOBAL_UNIQUE`，并写明释放方式：`none`（值本身全局唯一）、`row-delete`（删行才释放）、`takeover`（写入方跨租户接管）。不要改 `apps/server/src/core/db/tenant-tables.ts`，那是模板自己的登记。
3. **实体。** 生成器会产出实体；手写时继承 `BaseEntity`，`tenant_id` 用 `@TenantColumn()`（`apps/server/src/core/db/tenant-filter.ts`）映射，`alive` 不映射。参照 `apps/server/src/modules/demo/book/book.entity.ts`。
4. **执行迁移。** `pnpm db:migrate`。改已有表时另写一个新迁移，不改已经发布或执行过的迁移。

## 完成检查

```sh
pnpm db:migrate
pnpm --filter @qiwu/server test db-migrations
pnpm ai:map
pnpm verify
```

`db-migrations` 测试按规则检查全部表（非平台表必须有必填的 `tenant_id`，唯一键以它开头，除非登记为全局键；引擎、字符集、注释、列类型与 `down()` 的完整回退）；`pnpm verify` 里的架构检查拒绝重复或格式不对的迁移时间戳。

## 常见错误

- 用整点时间戳或复制别的迁移的时间戳：与模板迁移重复，执行顺序错乱。改成当前时间（文件名与类名一起改）。
- 修改或改名已经执行过的迁移：已安装的库按类名记录迁移，不会再执行。
- 唯一键写成 `(code)` 或 `(tenant_id, code)`：前者让不同租户互相占用，后者让软删除的行继续占用。写成 `(tenant_id, code, alive)`。
- 在实体里映射 `alive`，或把 `tenant_id` 设成可空。
- 没有 `deleted_at` 的表：生成器拒绝导入（422 `C3010`）。
- 租户表上用 ORM 的 `upsert` / `orUpdate` / `clear()`，或租户表的 `@ManyToMany`：不支持，先按键读再插入或更新，关联表用 `apps/server/src/core/db/links.ts` 或映射成实体。详见[多租户：编写租户感知的项目代码](../../multi-tenancy.md#编写租户感知的项目代码)。

更多约定：[代码生成：建表、软删除与引用约定](../../codegen.md#建表软删除与引用约定new-tables)、[从模板创建新项目：项目自己的表、迁移与模板升级](../../new-project.md#7-项目自己的表迁移与模板升级)。
