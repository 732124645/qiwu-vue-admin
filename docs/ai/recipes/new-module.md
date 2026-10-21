# 配方：新增业务模块（生成器优先）

## 适用场景

新增一张业务表的标准页面：列表（筛选、分页、导出、可选导入）、详情、新增、编辑、删除。单表用 `crud` 模板，带 `parent_id` + `tree_path` 的表用 `tree` 模板，主表加子表用 `master_sub` 模板。生成器输出服务端模块、共享 schema 与权限点、桌面页面、双语词条片段、菜单种子和端到端测试；只在生成物之外补手写业务规则。

不适用：没有表的纯接口、改平台模块（`apps/server/src/modules/platform/`）。

## 步骤

以表 `crm_customer` 为例：领域取表名第一段 `crm`，业务取其余部分 `customer`。没有独立领域的表（如 `course`）落到内置领域 `biz`。命名规则见[代码生成：名称、父菜单与路径](../../codegen.md#名称父菜单与路径)。

需要后台界面的步骤（第 1、4、8 步的菜单管理、代码生成页面、角色授权）由开发者在运行中的应用里操作；AI 工具不自己启动 `pnpm dev`，到这些步骤时请用户操作，或保持默认继续。

1. **建菜单分组**（可选）。在后台“菜单管理”建 `kind=group` 的目录，如 `crm`；保存后路由名只读。没有自己的分组时页面挂在内置的 `biz` 分组下。
2. **建表并迁移。** 按[建表与迁移](table-migration.md)写迁移，然后运行 `pnpm db:migrate`。表必须有 `deleted_at`，否则生成器拒绝导入。
3. **导入。** `pnpm gen import crm_customer`。逐条读输出的 `hint:`（唯一键缺 `alive`、缺 `tenant_id`、唯一键不以 `tenant_id` 开头、找不到父分组），先修表结构再继续。
4. **调整配置。** 在后台“代码生成”页面检查字段标签（中英）、控件、字典（`dictCode`）、查询条件、父菜单、模板类型。保持默认也可以。
5. **生成到工作区。** 先预览：`pnpm gen render crm_customer --out <仓库外目录>`；确认后写入（只写新文件，已有文件内容不同则整批不写并输出差异）：

   ```sh
   NODE_ENV=development CODEGEN_WRITE=true pnpm gen write crm_customer
   ```

   Windows PowerShell 的写法见[代码生成：Windows 命令](../../codegen.md#windows-命令powershell-51)。

6. **按输出的注册提示手工登记**（生成器从不改已有文件）：

   | 登记内容     | 文件                                                                                                             |
   | ------------ | ---------------------------------------------------------------------------------------------------------------- |
   | 服务端模块   | `apps/server/src/modules/project.module.ts`：import 生成的 `CustomerModule` 并加入 `imports`                     |
   | 菜单种子     | `apps/server/src/db/seeds/index.ts`：import `seedCustomer`，追加到 `SEEDS.project`（在两个 project 种子之后）    |
   | 菜单分组链   | `apps/server/src/db/seeds/project/menu-groups.seed.ts` 的 `PROJECT_MENU_GROUPS`：父先子后补齐第 1 步建的分组     |
   | 共享导出     | `packages/shared/src/index.ts`：追加 `export * from './crm/customer.schema.js'`                                  |
   | 平台专属页面 | 仅当表登记为平台表：`packages/shared/src/common/tenancy.ts` 的 `PLATFORM_ONLY_ROUTES` 加入页面路由名（模板文件） |
   | 租户基础数据 | 仅当每个租户都要预置数据：`apps/server/src/db/seeds/project/tenant.seed.ts` 的 `PROJECT_TENANT_SEEDS`            |

   桌面端页面路由和词条文件不用登记：页面从菜单加载，视图与词条按目录自动合并。`tenancy.ts` 属于模板，没有项目自己的登记处，升级时可能冲突，见[升级模板版本](../../upgrade.md#3-常见冲突与处理)。

7. **校对英文。** 生成的英文标签是派生值，校对 `apps/web/src/locales/en-US/<domain>.<business>.json` 与 `packages/shared/src/i18n/en-US/modules/<domain>.<business>.json`（本例为 `crm.customer.json`）。
8. **种子与授权。** 先 `pnpm --filter @qiwu/shared build`（`pnpm db:seed` 与 `pnpm gen` 先 `nest build`，读的是 shared 的构建产物，不构建就找不到新导出的 schema 与权限点），再运行 `pnpm db:seed`，然后在“角色管理”给角色勾选新页面（需要 `iam.role.grant`；root 直接可见）。启用多租户时还要把页面勾进“租户套餐”，否则其他租户看不到。见[权限与菜单](permission-menu.md)。
9. **补手写规则。** 生成物覆盖通用能力；关联显示、服务端写入列、额外校验、更多行操作等按[手写扩展的位置](../../codegen.md#手写扩展的位置)添加。模块特有的测试写进新文件 `apps/server/test/e2e/<domain>-<business>-extra.e2e-spec.ts`，不要改生成的 spec，见[接口测试](api-test.md)。

参照样例：`demo_book` 的生成配置在 `apps/server/src/db/seeds/codegen/demo_book.cg.ts`，生成物见[配方索引的样例表](README.md#通用完成标准)。

## 完成检查

```sh
pnpm --filter @qiwu/shared build
pnpm --filter @qiwu/server test crm-customer.e2e
pnpm ai:map
pnpm verify
```

## 常见错误

- 忘了第 6 步的登记：接口 404（模块没进 `project.module.ts`）、菜单不出现（种子没进 `SEEDS.project`）、前端拿不到 schema（shared 没导出）。
- 种子报 “menu group … is missing”：父分组既不在库里，也不在 `PROJECT_MENU_GROUPS` 里。
- 只在页面里加了按钮权限，没有在角色管理授权，普通账号看不到页面；多租户下还要加进租户套餐。
- 对已有开发库运行 `pnpm db:reset` 代替迁移：会清空数据。新表只用 `pnpm db:migrate`。
- 直接改 `apps/server/src/core/db/tenant-tables.ts` 登记项目的表：项目只改 `apps/server/src/db/project-tables.ts`。
- 在 `.ts` / `.vue` 里写中文字面量：界面文字一律放进词条片段，见[多语言词条](i18n.md)。
