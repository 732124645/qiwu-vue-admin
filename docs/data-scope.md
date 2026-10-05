# 数据权限：范围计算与读写入口

数据权限决定调用者能访问哪些行，接口权限决定能执行哪些动作。`PermGuard` 先检查 `@RequirePerm`，再把本次权限要求写入请求 CLS 的 `checkedPerm`；`BaseCrudService.scopedQb()` 对带 `@DataScoped` 的实体应用规则链。前端隐藏按钮不能替代这两层服务端检查。

## 五种范围

范围来自启用角色的 `dataScope`，由 `deptScopeRule()` 按实体声明的数据库列名计算。`dept` 或 `owner` 为 `null` 表示该维度不适用。

| 范围码          | 判定                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------- |
| `all`           | 当前权限角色组不添加部门或归属过滤                                                        |
| `picked_depts`  | `dept` 在角色的 `deptIds` 并集中，来源为 `iam_role_depts` 的有效关联与未删除部门          |
| `own_dept`      | `dept` 等于调用者的 `deptId`；没有部门时不产生这一项                                      |
| `own_dept_tree` | `dept` 属于未删除的 `iam_dept`，且 `tree_path LIKE :dsPrefix`；前缀是调用者部门路径加 `%` |
| `own_rows`      | `owner` 等于调用者 `userId`，具体含义取决于实体的归属列                                   |

部门路径以 `/` 结束，所以 `/1/2/%` 不匹配 `/1/23/`。已删除的本部门在 `IamUserLookup.load()` 中视为没有部门；下级部门子查询也要求 `deleted_at IS NULL`。角色没有选部门、用户没有部门、实体没有适用的维度等情况，若整个角色组拼不出任何条件，就加 `1=0`，得到空集。

实际实体映射如下：

| 实体                 | 声明                                                                                  | 结果                                                                              |
| -------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `User`（`iam_user`） | `@DataScoped({ dept: 'dept_id', owner: 'id' })`                                       | `own_rows` 只看到自己的用户行，按 `id` 判断                                       |
| `Dept`（`iam_dept`） | `@DataScoped({ dept: 'id', owner: null })`                                            | 部门本身的 `id` 是部门维度，单独的 `own_rows` 不提供可见行                        |
| 生成的普通业务实体   | 有适用的 `dept_id` 时输出声明；存在 `created_by` 时用它作 owner，否则 owner 为 `null` | `own_rows` 通常是自己创建的业务行；以生成后的实体声明为准                         |
| `Role`（`iam_role`） | 没有 `@DataScoped`                                                                    | 角色列表不做数据范围过滤，由 `iam.role.*` 接口权限和 `GrantPolicy` 防越权授予约束 |

生成配置的 `options.dataScope: false` 会关闭生成实体的 `@DataScoped` 声明。

角色成员的已分配、未分配用户列表仍按 `User` 的范围查询。角色不归属于部门，不能根据角色的创建人推断角色列表范围。

## 多角色与多权限的合并

`roleGroups()` 先分组，再由 `deptScopeRule()` 在组内 OR、组间 AND：

- `@RequirePerm(a)`：只用持有 `a` 的角色，角色范围取并集。
- `@RequirePerm(a, b)`（任一式）：`PermGuard` 保留调用者实际持有的列出权限，合并持有其中任意一个权限的角色范围；结果与声明顺序无关。
- `@RequirePerm.all(a, b)`：分别计算持有 `a` 的角色并集、持有 `b` 的角色并集，再取交集。某一组含 `all` 只放宽该组，不能覆盖另一组的限制。
- 没有 `@RequirePerm`：使用调用者全部启用角色。

例如，浏览角色拥有 `all`，修改角色只有 `own_dept`。要求浏览与修改同时成立的接口只允许本部门，不能借浏览角色扩大修改范围。没有权限由 `PermGuard` 返回 403；已通过接口权限但目标行不存在或超出范围时返回 404，避免泄露行是否存在。

## 查询、锁与写入后的范围

`BaseCrudService` 已提供这些入口，项目服务优先复用：

1. 列表、详情、导出、options 与选择器通过 `scopedQb(alias)` 查询。自定义 `filter()` 用 `andWhere()` 追加条件；`where()` 会覆盖已添加的数据范围。
2. 按 id 修改、删除或批量写入，在当前事务内先 `await lockScopedIds(ids)`。它去重 id，经 `scopedQb()` 执行 `FOR UPDATE`，任一行不可见就整批 404；没有活动事务时直接抛错。锁定后再按主键写入。
3. 新增与编辑范围列时调用 `assertWritableScope()`，用同一规则链判断写入后行的部门和归属。新增的 `createdBy` 来自 CLS 调用者；普通更新按存储的 owner 判断，不能通过 DTO 改写审计归属。越界返回 404 并回滚。
4. 引用完整性另由 `assertReferencesLive()` 检查。已登记的引用指向不存在或软删除的父行时返回 404；新引用在事务内读父行 `FOR SHARE`，未改变的引用不重复锁定。这保证有效引用，不等于自动检查父行的数据权限；业务要求父行也在调用者范围内时，需要额外使用父实体的范围入口。
5. `remove()` 经 `softDeleteRows()`：有有效限制引用则返回 409 `in_use`；级联记录在同一事务中软删除。TypeORM 普通实体查询排除软删除行，原始 SQL 仍须显式处理 `deleted_at IS NULL`。

树服务 `BaseTreeService` 也沿用 `scopedQb` / `lockScopedIds`。部门新增前还没有 id，因此在写入后的事务内重新锁定检查；移动时检查更新后的整棵有效子树，越界则回滚。导入 upsert 只匹配范围内的行，范围外的同键行不能被覆盖。详见[生成器黄金样板](codegen-golden.md)。

## 超管、系统任务与缓存边界

`applyScopes()` 的顺序是：CLS `skipDataScope` 则跳过；没有 principal 则 `1=0`；`Principal.root` 则跳过；其余逐项应用规则。root 来自 `IamUserLookup` 对启用、未删除的内置 root 角色的判定，不是请求体字段，也不能给普通角色填一个 `*` 就获得超管权限。

`@SkipDataScope()` 只包裹需要豁免的服务方法，在嵌套 CLS 中设置标志，方法结束后恢复外层上下文。它用于系统任务，不替代认证、接口权限或业务归属检查；不要给面向普通用户的写方法随意添加。

范围所需的 principal 与 `checkedPerm` 在请求 CLS 中读取；每次构造查询时应用规则，没有跨请求缓存完整查询结果。角色、权限和部门事实随会话缓存，由 Redis 权限版本失效：`PermVersion.current()` 读用户与全局两个计数，`AuthGuard` 在版本变化时重载；`bumpUser` / `bumpUsers` / `bumpUsersOfRole` / `bumpAll` 必须在事务提交后调用，防止其他请求按新版本读到旧数据。不靠进程内永久缓存维持授权。

默认链 `defaultScopeRules()` 是 `[deptScopeRule(), tenantRule]`。`tenantRule` 当前是 no-op，没有租户隔离；完整改造清单见[多租户扩展说明](multi-tenancy.md)，不能仅替换这一条就宣称已经支持多租户。

## 代码核对与人工观察

实现入口：[规则链与装饰器](../apps/server/src/core/data-scope/data-scope.ts)、[CRUD 基类](../apps/server/src/core/db/base-crud.service.ts)、[树基类](../apps/server/src/core/db/base-tree.service.ts)、[引用与软删除](../apps/server/src/core/db/references.ts)、[PermGuard](../apps/server/src/core/auth/perm.guard.ts)、[权限版本](../apps/server/src/core/auth/perm-version.ts)、[AuthGuard](../apps/server/src/core/auth/auth.guard.ts)、[IamUserLookup](../apps/server/src/modules/platform/iam/iam-user-lookup.ts)、[用户实体](../apps/server/src/modules/platform/iam/user/user.entity.ts)、[部门实体](../apps/server/src/modules/platform/iam/dept/dept.entity.ts)、[角色实体](../apps/server/src/modules/platform/iam/role/role.entity.ts)、[生成模型](../apps/server/src/modules/platform/codegen/crud.ts)。

人工验收在隔离的测试项目中，用普通账号分别设置五种范围，观察列表、详情、options、导出，以及越界 id 修改与批量删除的整体 404。再用两个角色检查 all/any 合并，修改角色范围后观察已有会话的下次请求。对应回归源码为 `apps/server/test/e2e/data-scope.e2e-spec.ts` 等。
