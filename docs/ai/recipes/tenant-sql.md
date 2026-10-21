# 配方：手写 SQL 与租户

## 适用场景

用 `tx.query` / `ds.query` 写原始 SQL 读写**租户表**（带 `tenant_id`、不在平台表清单里的表），或后台代码要跨租户扫描、按行切换租户。ORM（实体、Repository、QueryBuilder）会自动加当前租户条件；原始 SQL 不会，必须自己写。

多租户开关关闭时规则同样成立：代码按多租户写，关闭只是所有请求都在默认租户里运行。

## 步骤

1. **能用 ORM 就用 ORM。** 先试 `scopedQb()` 或 QueryBuilder；只有聚合、复杂联表等写不出来时才写原始 SQL。值一律用 `?` 参数，不拼接。
2. **每张租户表各带租户条件。** 当前租户用 `tenantId()`（`apps/server/src/core/context/tenant.ts`）。下例代表调用者读客户列表：`crm_customer` 有 `dept_id`，生成器给它加了 `@DataScoped`，`iam_dept` 也是带数据权限的表，所以同一函数里调用 `dataScopeSqlFor` 并插入 `${scope.sql}`；每张读到的表都写自己的 `deleted_at IS NULL`：

   ```ts
   import { tenantId } from '../../../core/context/tenant.js'
   import { dataScopeSqlFor } from '../../../core/data-scope/data-scope.js'
   import { Customer } from './customer.entity.js'

   const scope = dataScopeSqlFor(Customer, 'c')
   const rows = await this.txHost.tx.query(
     // arch-allow: sql-concat the data scope: identifiers from code, values in params; tenant: c.tenant_id = ?, d.tenant_id = ?
     `SELECT c.id, c.name, d.name AS deptName
        FROM crm_customer c
        LEFT JOIN iam_dept d ON d.id = c.dept_id AND d.tenant_id = ? AND d.deleted_at IS NULL
       WHERE c.tenant_id = ? AND c.deleted_at IS NULL AND (c.name LIKE ? OR c.code = ?) AND ${scope.sql}`,
     [tenantId(), tenantId(), `%${kw}%`, kw, ...scope.params],
   )
   ```

   - 主表条件写在 WHERE，join 进来的表各写各的（写在它的 ON 里）；子查询里的表在子查询里写。
   - 原条件里有顶层 `OR` 时先整体加括号，再 `AND` 租户条件。
   - `INSERT` 租户表要写 `tenant_id` 列。
   - 原始 SQL 不排除软删除行，每张表（含 join 的）自己写 `deleted_at IS NULL`。读带数据权限的表按[数据权限](data-scope.md)插入范围条件，`scope.params` 放在 `${scope.sql}` 对应的参数位置。
   - 查询代表调用者读数据时，不要为了让检查通过而写 `qw:no-data-scope`：那会让调用者读到范围外的行。这个标记只留给本来就不该加范围的系统查询。

3. **跨租户只走两个入口。** 后台任务要处理所有租户时，用 `allTenants(fn)` 扫描、对每一行用 `withTenant(行的租户, fn)` 处理；每处调用都在调用上或紧上一行写 `qw:cross-tenant <理由>`：

   ```ts
   // qw:cross-tenant overdue rows of every tenant are scanned; each is handled in its own tenant
   return allTenants(() => this.scanAll())
   ```

   扫描查询本身只取可用租户（已启用、未到期；开关关闭时只有默认租户）的行，不要取出来再跳过。完整写法参照 `apps/server/src/modules/workflow/runtime/wf-remind.ts`。确需跨租户的单条语句同样在语句上或紧上一行写 `qw:cross-tenant <理由>`。

4. **拼接 SQL 写明怎样留在租户内。** 表名、列名等确实只能拼接（值永远不拼）时，在语句上或紧上一行写 `// arch-allow: sql-concat <理由>`，理由里带 `tenant: <说明>`（如 `tenant: c.tenant_id = ?`），跨租户的写 `qw:cross-tenant <理由>`。
5. **Redis 键。** 一律经 `apps/server/src/core/redis/cache-namespaces.ts` 构造，按自然键（编码、名称、用户名）建键的命名空间声明为 `tenant` 维度。

## 完成检查

```sh
pnpm arch:check
pnpm --filter @qiwu/server test <domain>-<business>.e2e
pnpm verify
```

`pnpm arch:check` 的 `tenant-sql` 检查原始 SQL 里每张租户表的租户条件、`INSERT` 的 `tenant_id`、`withTenant`/`allTenants` 的理由和 `arch-allow: sql-concat` 的 `tenant:` 说明；`no-sql-concat` 检查拼接。测试里至少有一条跨租户 404，见[接口测试](api-test.md)。

## 常见错误

- 只给主表写了 `tenant_id`，join 的表没写：别的租户的行被连进来。
- `WHERE a OR b AND t.tenant_id = ?`：`OR` 让别的租户的行进来，写成 `(a OR b) AND t.tenant_id = ?`。
- 从请求头、参数读租户 id：会话的租户只来自服务端会话，永远用 `tenantId()`。
- 在 `allTenants` 里直接处理单行（写入、`QueueService.add`、构造 `tenant` 维度的 Redis 键，后两者会抛错）：先 `withTenant` 进入那一行的租户。
- 租户表上用 ORM 的 `upsert` / `orUpdate` / `clear()`：不支持，先按键读再更新或插入。
- 在 `@Transactional()` 方法里给队列加任务：见[队列任务与定时任务](job.md)。

细节：[多租户：编写租户感知的项目代码](../../multi-tenancy.md#编写租户感知的项目代码)、[设计说明：多租户](../../design-notes.md#tenancy)。
