# 配方：权限与菜单

## 适用场景

- 给模块加一个新动作（如“升级为 VIP”）：新权限点、按钮、操作日志动词。
- 新页面要出现在侧栏的某个分组下，或新建项目自己的菜单分组。
- 让某个角色、某个租户用上新页面。

生成器生成的模块已带标准权限点（browse/view/create/modify/remove/export/import）、菜单种子与操作日志，只在手写动作时才需要本配方。

## 步骤

1. **权限点写进共享包。** 权限码格式 `<domain>.<resource>.<verb>`（如 `crm.customer.upgrade`），不用 `a:b:c`。追加到模块 schema 文件的 `xxxPerms` 常量，参照 `packages/shared/src/demo/book.schema.ts` 的 `bookPerms`：

   ```ts
   export const customerPerms = {
     browse: 'crm.customer.browse',
     // …生成的其余权限点
     upgrade: 'crm.customer.upgrade',
   } as const
   ```

2. **接口加守卫与日志。** 控制器方法加 `@RequirePerm(customerPerms.upgrade)`（`apps/server/src/core/auth/decorators.ts`；要求同时持有多个权限用 `@RequirePerm.all(a, b)`）。每个非 GET 方法必须有 `@ActionLog({ domain: 'crm.customer', verb: '…' })` 或 `@SkipActionLog()`（`apps/server/src/core/audit/action-log.ts`），新增类接口再加 `@Idempotent()`（`apps/server/src/core/guard/idempotent.ts`）。
3. **新动词登记。** `@ActionLog` 的 `verb` 先用平台已有的（`create`、`modify`、`remove`、`import`、`export` 等）；确实需要新动词时登记到 `apps/server/src/db/seeds/project/action-verbs.seed.ts` 的 `PROJECT_ACTION_VERBS`，格式 `['upgrade', '升级为 VIP', 'Upgrade to VIP', 'success']`（短横线小写，最多 32 字符），不要改平台的 `VERBS`。
4. **菜单动作行。** 在模块种子（如 `apps/server/src/modules/demo/book/book.seed.ts`）的 `ACTIONS` 里加一行 `[customerPerms.upgrade, 'menu.action.upgrade']`。种子按 `route_name` 找页面、按 `perms` 写动作行，重复运行不会产生重复行。动作名是词条键：标准动作的键已在平台的 `menu.json`；新动作的键写进模块自己的桌面词条片段 `apps/web/src/locales/{zh-CN,en-US}/<domain>.<business>.json`（如 `{"menu":{"action":{"upgrade":"升级为 VIP"}}}`），见[多语言词条](i18n.md)。
5. **前端按钮。** `v-perm="customerPerms.upgrade"` 控制按钮显示（参照 `apps/web/src/views/demo/book/index.vue`）。前端隐藏不等于授权，服务端第 2 步的守卫必须有。
6. **菜单分组**（新分组时）。先在后台“菜单管理”建 `kind=group` 的目录，再把同样的数据写进 `apps/server/src/db/seeds/project/menu-groups.seed.ts` 的 `PROJECT_MENU_GROUPS`（父先子后，`parent` 写内置分组路由名如 `biz`，或列表里更早的分组，或 `null`），新库种子才会重建它。路由名只能是小写字母、数字和连字符，保存后不能改。
7. **种子登记。** 新模块的种子函数加进 `apps/server/src/db/seeds/index.ts` 的 `SEEDS.project`，排在 `seedProjectMenuGroups`、`seedProjectActionVerbs` 之后。先 `pnpm --filter @qiwu/shared build`（`pnpm db:seed` 先 `nest build`，读的是 shared 的构建产物，不构建就看不到第 1 步的新权限点），再运行 `pnpm db:seed`。
8. **授权。** 在后台“角色管理”给角色勾选页面与动作（操作者需要 `iam.role.grant`；root 隐含全部权限）。启用多租户时，在“租户套餐”勾选新页面，其他租户才能用；租户用户的权限 = 角色授权 ∩ 套餐。
9. **平台专属页面**（仅当表是平台表）。页面路由名加进 `packages/shared/src/common/tenancy.ts` 的 `PLATFORM_ONLY_ROUTES`，控制器每个带权限点的路由加 `@PlatformOnly()`（`apps/server/src/core/auth/platform-only.ts`）。`tenancy.ts` 属于模板，没有项目自己的登记处，升级时可能冲突，见[升级模板版本](../../upgrade.md#3-常见冲突与处理)。

## 完成检查

```sh
pnpm --filter @qiwu/shared build
pnpm db:seed
pnpm --filter @qiwu/server test <domain>-<business>-extra.e2e
pnpm ai:map
pnpm verify
```

测试里至少覆盖：有权限 200/201，没有该权限点 403（见[接口测试](api-test.md)）。`pnpm verify` 的架构检查会拒绝缺少 `@ActionLog`/`@SkipActionLog` 的写接口和未登记的动词。

## 常见错误

- 权限码写成 `crm:customer:upgrade`：原创性检查拒绝，改成点分格式。
- 只加了按钮的 `v-perm`，接口没有 `@RequirePerm`：任何登录用户都能调用。
- 权限点没进菜单种子的动作行：角色管理里勾不到它，只有 root 能用。
- 新动词写进平台的 `VERBS`，或重复了平台已有的动词：架构检查报错，改用平台动词或登记到 `PROJECT_ACTION_VERBS`。
- 菜单分组只在后台建了，没写进 `PROJECT_MENU_GROUPS`：新库种子找不到父分组而失败。
- 授权后其他租户仍看不到页面：页面不在该租户的套餐里。

细节：[代码生成：项目模块的开发流程](../../codegen.md#项目模块的开发流程)、[设计说明：权限与授权](../../design-notes.md#permissions)、[多租户：租户套餐](../../multi-tenancy.md#租户套餐)。
