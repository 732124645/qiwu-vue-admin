# 配方：数据权限

## 适用场景

表的行要按调用者的角色范围过滤：全部、指定部门、本部门、本部门及下级、仅本人。接口权限（`@RequirePerm`）决定能不能做某个动作，数据权限决定能看到、改到哪些行；两者都在服务端。

范围外的行一律按不存在处理（404），不返回 403，避免泄露行是否存在。

## 步骤

1. **表里要有维度列。** 部门维度一般是 `dept_id`，归属维度一般是 `created_by`（`BaseEntity` 自带）。迁移见[建表与迁移](table-migration.md)。
2. **实体声明。** 在实体上加 `@DataScoped({ dept: 'dept_id', owner: 'created_by' })`（`apps/server/src/core/data-scope/data-scope.ts`，写数据库列名；不适用的维度写 `null`）。生成器在表有 `dept_id` 时自动生成这一行，参照 `apps/server/src/modules/demo/book/book.entity.ts`；生成配置 `options.dataScope: false` 关闭。
3. **读走 `scopedQb`。** 服务继承 `BaseCrudService`（`apps/server/src/core/db/base-crud.service.ts`）：列表、详情、导出、options、选择器都从 `this.scopedQb(alias)` 开始查询。自定义条件用 `andWhere()` 追加，**不要用 `where()`**，它会覆盖已加上的范围条件。
4. **按 id 写先锁。** 修改、删除、批量操作在事务里先 `await this.lockScopedIds(ids)`：任一行不可见，整批 404。锁定后再按主键写。新增或修改范围列（如换部门）时调用 `assertWritableScope()`，写入后的行也必须在调用者范围内。生成的服务已经这样做；手写的写方法照此补齐。
5. **手写 SQL 加范围。** `tx.query` 等原始 SQL 不经过 `scopedQb`，代表调用者读数据（列表、计数、报表）时用 `dataScopeSqlFor(实体, 别名)` 或 `dataScopeSql(...)` 生成条件并插入 `${scope.sql}`，参数按位置放进 `scope.params`；租户条件与软删除条件仍要自己写：

   ```ts
   const scope = dataScopeSqlFor(Book, 'b')
   const rows = await this.txHost.tx.query<{ dept_id: number; n: number }[]>(
     // arch-allow: sql-concat the data scope: identifiers from code, values in params; tenant: b.tenant_id = ?
     `SELECT b.dept_id, COUNT(*) AS n FROM demo_book b
       WHERE b.tenant_id = ? AND b.deleted_at IS NULL AND ${scope.sql}
       GROUP BY b.dept_id`,
     [tenantId(), ...scope.params],
   )
   ```

   `dataScopeSql` 要在写 SQL 的那个函数里直接调用，不要包进辅助方法（检查认不出）。

6. **系统查询标明不加范围。** 不代表调用者读可见行的查询（引用占用检查、种子、定时任务、通知收件人、显示人名的标签等）在 SQL 字面量上或紧上一行写 `qw:no-data-scope <理由>`，理由必填：

   ```ts
   // qw:no-data-scope in-use check: any live user of the depts blocks the delete
   ```

7. **系统任务豁免。** 后台任务确实要越过范围时，在那个服务方法上加 `@SkipDataScope()`，不要加在面向普通用户的接口上。

## 完成检查

```sh
pnpm arch:check
pnpm --filter @qiwu/server test <domain>-<business>.e2e
pnpm verify
```

`pnpm arch:check` 里的 `scoped-access` 检查带 `:id` 或 `ids` 的写接口是否经过 `lockScopedIds`，`data-scope-sql` 检查原始 SQL 是否带范围或标记。测试里用一个 `own_dept` 角色的用户验证：别的部门的行不在列表里，读写它们 404，参照 `apps/server/test/e2e/demo-book.e2e-spec.ts` 的 data scope 分组与 `apps/server/test/e2e/data-scope.e2e-spec.ts`。

## 常见错误

- 在 `scopedQb()` 之后用 `.where()`：范围条件被覆盖，所有行可见。
- 按 id 更新前没 `lockScopedIds`：范围外的行可以被改。
- 列表 SQL 插了 `${scope.sql}`，同一函数里的总数 SQL 没插：检查会报出，每条语句都要插。
- 用 `qw:no-data-scope` 让列表查询“通过检查”：标记的意思是这条查询本来就不该加范围，用错会泄露数据。
- 用前端隐藏代替数据权限。
- 以为数据权限包含租户隔离：租户条件由 ORM 另外加，原始 SQL 要自己写，见[手写 SQL 与租户](tenant-sql.md)。

细节：[数据权限](../../data-scope.md)、[设计说明：数据范围与引用](../../design-notes.md#data-scope)。
