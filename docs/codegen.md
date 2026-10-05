# 代码生成器：开发流程、精度与手写扩展点

生成器按数据库表与配置输出标准 CRUD、树（`template: 'tree'`）或主子表（`template: 'master_sub'`）模块。模板和生成物的详细约定见[黄金样板](codegen-golden.md)。生成器从不编辑已有文件；预览、下载、CLI 渲染与工作区写入复用同一渲染流程。

## 项目模块的开发流程

项目业务直接放在自己的领域目录，领域通常来自表名的第一段。例如 `erp_sale_order` 得到领域 `erp`、业务 `sale-order`，不再套一层 `biz/` 目录。菜单分组由管理员建立，生成配置保存父分组路由名，种子负责在新库重建分组与页面。

1. **建立菜单分组。** 在菜单管理中建立 `kind=group` 的目录，如 `erp` 下的 `erp-sale`。`MENU_GROUP_ROUTE_NAME` 要求小写字母、数字和连字符；表单按路由路径派生初值（`/erp/sale` → `erp-sale`），保存后路由名只读。修改已有效的路由名返回 422 `B1012`；缺失或不合格式的旧路由名允许一次修正。没有独立领域的表可直接挂到内置 `biz` 分组。
2. **建表并迁移。** 在 `apps/server/src/db/migrations/` 写迁移，遵守下文审计、软删除、唯一键和引用约定，然后执行 `pnpm db:migrate`。新项目环境准备见[入门文档](getting-started.md)，不要用重置已有开发库代替迁移。
3. **导入。** 用 `pnpm gen import <table>` 或代码生成页面导入，检查默认配置、提示、字段标签与控件。名称推导规则见下一节。
4. **编辑并生成。** 调整生成配置后预览、下载 zip，或执行 `pnpm gen render <table> --out <dir>` / `pnpm gen write <table>`。生成器不创建业务表；同步表结构只同步配置。
5. **按打印内容手工注册。** CLI 的 render/write 和页面预览提供注册提示：模块、种子、shared 导出、父项目菜单分组链；有移动端生成物时再注册 pages.json 和入口，位置见下表。
6. **执行种子。** `pnpm db:seed` 中 `SEEDS.project` 最后执行，先运行 `seedProjectMenuGroups` 和 `seedProjectActionVerbs`，再运行项目页面种子。
7. **授予页面权限。** 在角色管理中用 `iam.role.grant` 授权。生成页面不会自动授予普通角色，root 可以立即访问。

| 注册内容                                           | 文件与操作                                                                                                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 项目服务模块                                       | `apps/server/src/modules/project.module.ts`：导入模块并加入 `imports`                                                                                   |
| 项目模块种子                                       | `apps/server/src/db/seeds/index.ts`：导入 seed 函数，放到 `SEEDS.project` 的分组和动作种子之后；内置样例走 `SEEDS.demo`                                 |
| 项目父菜单链                                       | `apps/server/src/db/seeds/project/menu-groups.seed.ts` 的 `PROJECT_MENU_GROUPS`：按父先子后补缺少的项目分组，直到内置父分组；缺少英文名称的派生值需校对 |
| 共享 schema 导出                                   | `packages/shared/src/index.ts`：追加生成 schema 的 export                                                                                               |
| 移动页面（开启 `options.withMobile` 且客户端存在） | `mobile/src/pages.json` 的 `pages-biz` 分包追加 index/detail/form（只读无 form）；入口由项目自行添加，如工作台 `SHORTCUTS`                              |

桌面端不需要手动注册页面路由和 locale 文件：页面从菜单加载，视图和词条通过 glob 查找、合并。平台与流程模块仍注册到所在领域模块及对应的 `SEEDS` 项。

生成路由使用已有动作日志动词 `create/modify/remove/import/export`，不要求新建动作词条。项目后续增加新 `@ActionLog` 动词时，在 `apps/server/src/db/seeds/project/action-verbs.seed.ts` 的 `PROJECT_ACTION_VERBS` 登记，例如 `['upgrade', '升级为 VIP', 'Upgrade to VIP', 'success']`（动词码、双语标签、可选 tag 类型），不要改平台 `VERBS`。`pnpm arch:check` 会拒绝未登记或重复平台的项目动词。项目动作种子仅补缺少的 `audit.verb` 项，不覆盖管理员已有编辑。

## 名称、父菜单与路径

默认值由 `rules.ts` 的 `domainOf()`、`initTable()`、`qualifyNames()` 与 shared 的 `cgClassName()` 派生；导入后仍可编辑。

- 内置前缀 `iam_ cfg_ msg_ aud_ fs_ job_ oauth_ im_` 按 `TABLE_PREFIXES` 映射到平台领域，`wf_` 到 workflow，`biz_` / `demo_` 到内置项目领域。`im_` 当前仅是保留映射，不表示已有 IM 表或功能。
- 其他表的第一段为领域，其余为业务：`erp_sale_order` → `erp/sale-order`，`crm_customer` → `crm/customer`。无下划线、首段为保留名或不符合 `^[a-z][a-z0-9]*$` 的表用领域 `biz`，业务取整张表名，如 `course` → `biz/course`。
- `RESERVED_NAMES` 保留代码层、内置领域、API 根、静态路由及 locale 命名空间等。项目配置保存/渲染不能占用这些领域名（`biz/demo` 为例外），否则 422 `C3002`。
- 同名业务跨领域、导出名与 shared 手写模块冲突时，类名加领域前缀，如 `ErpCustomer` / `erpCustomerPerms`；仍冲突则 422 `C3011`，指出另一张表。编辑领域或业务时，仍等于旧派生值的类名与字典码会跟随重新派生。
- 项目父菜单按表名的前导段从长到短匹配分组，排除整张表名：`erp_sale_order` 先找 `erp-sale`，再找 `erp`，否则回落 `biz` 并给 `parent_menu` 提示。生成页可选任意层级的分组；自身或祖先路由名不合法的分组不可选，保存返回 422 `C3008`。
- 页面路由名 `<domain>-<business>` 与已有目录/动作路由名（包含软删除记录）或父链冲突时返回 422 `C3012`，需要修改领域或业务名。
- `meta_` / `test_` / `cg_` 表由 `EXCLUDED_TABLE` 排除。没有 `deleted_at` 的表不可导入或生成，整批导入失败，返回 422 `C3010`；唯一键缺少 `alive` 仅提示，不替数据库补约束。

内置父菜单为：`iam_/cfg_/oauth_/im_` → `system`；`msg_` → `messaging`；`aud_` → `audit`；`fs_` → `storage`；`job_` → `monitor`；`wf_` → `wf-admin`。领域、URL、权限来自表名与生成配置，不能由父菜单决定。

| 生成物               | 项目规则                                                                                   | `erp_sale_order` 示例                                                  |
| -------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| 服务端               | `apps/server/src/modules/<domain>/<business>/`，内含 entity/service/controller/module/seed | `modules/erp/sale-order/`                                              |
| shared               | `packages/shared/src/<domain>/<business>.schema.ts`                                        | `erp/sale-order.schema.ts`                                             |
| 共享字段片段         | `packages/shared/src/i18n/<lang>/modules/<domain>.<business>.json`                         | `modules/erp.sale-order.json`                                          |
| 桌面 API 与页面      | `apps/web/src/api/<domain>/<business>.ts`、`views/<domain>/<business>/`                    | `api/erp/sale-order.ts`、`views/erp/sale-order/index.vue`              |
| 桌面 locale          | `apps/web/src/locales/<lang>/<domain>.<business>.json`                                     | `erp.sale-order.json`                                                  |
| 移动端               | `mobile/src/api/<home>.ts`、`pages-biz/<home>/`、locale 片段                               | `pages-biz/erp/sale-order/`                                            |
| 回归 spec            | `apps/server/test/e2e/<domain>-<business>.e2e-spec.ts`                                     | `erp-sale-order.e2e-spec.ts`                                           |
| URL                  | `/api/<domain>/<businesses>`，kebab-case，末词复数                                         | `/api/erp/sale-orders`                                                 |
| 权限、字段、table-id | 业务段转小驼峰                                                                             | `erp.saleOrder.browse`、`field.erp.saleOrder.orderNo`、`erp.saleOrder` |
| 页面菜单             | 路由名、路径、component                                                                    | `erp-sale-order`、`/erp/sale-orders`、`erp/sale-order/index`           |

平台/流程在 modules、views、api、shared 路径中继续带 `platform/` 或 `workflow/` 层。移动端 `<home>` 同样随模块位置变化。

## 菜单种子的重放

项目页面的 `parent_id`、`icon`、`sort_no` 只在首次插入时写入；管理员移动、换图标、重排后，再跑种子会保留这些修改。页面名称、路径、component 和动作仍按自然键更新；平台页面继续更新全部配置字段。

`menu-groups.seed.ts` 只插入没有同路由名的项目分组。已经存在或被管理员软删除的分组不重建；删除父分组下的新子分组也保存为删除状态并提示。未在父先子后列表中出现、也非内置分组的父节点会报错。

模块种子按父路由名找 `kind=group` 的记录：父分组已删除则跳过该模块页面/动作并提示，其他种子继续；父分组不存在则报错，项目分组错误提示指向 `menu-groups.seed.ts`。需要恢复页面时由管理员重新建立有效分组，不能指望 seed 撤销删除。

例如，在菜单管理建立 `erp` → `erp-sale`，迁移创建含 `order_no`、`customer_name`、`amount decimal(12,2)`、审计列、`deleted_at`、`alive` 和 `UNIQUE(order_no, alive)` 的 `erp_sale_order`。导入后检查标签和字段配置，默认类名未冲突时为 `SaleOrder`，父菜单 `erp-sale`。生成后按提示注册 `SaleOrderModule`、`seedSaleOrder`、shared 导出与分组链，再 seed 和授予 `erp.saleOrder.*`。模板不附带 ERP 业务表。

## Windows 命令（PowerShell 5.1）

条件支持与服务 / 规则准备见[Windows 入门清单](getting-started.md#windows原生-powershell-51)。`pnpm.cmd` 仅随 npm / Corepack 安装提供，避免 `.ps1` 执行策略且不改执行策略；独立 `pnpm.exe`（winget / get.pnpm.io）使用 plain `pnpm`，将下列 `pnpm.cmd` 换成 `pnpm`。 本文命令表是通用参数说明；手敲时按安装方式选择入口，不需要 WSL / Git Bash。

以下以已在自己安装库中迁移好的 `erp_sale_order` 为例。`--out` 用专门的仓库外目录，路径含空格时加引号；每步失败立即停止：

```powershell
pnpm.cmd gen import erp_sale_order
if ($LASTEXITCODE -ne 0) { throw "Import failed" }
pnpm.cmd gen render erp_sale_order --out "C:/qw generated/erp-sale"
if ($LASTEXITCODE -ne 0) { throw "Render failed" }
```

要写入工作区，先按下文确认已导入配置、允许目录与已有文件防护，再在变量原先未设置的开发终端显式开启并在完成后清除（已有值先保存，结束后恢复）：

```powershell
$env:NODE_ENV='development'
$env:CODEGEN_WRITE='true'
try {
  pnpm.cmd gen write erp_sale_order
  if ($LASTEXITCODE -ne 0) { throw "Workspace write failed" }
} finally {
  Remove-Item Env:NODE_ENV
  Remove-Item Env:CODEGEN_WRITE
}
```

G0（生成且零手改的模块，见 [G0 与检查边界](#g0-与检查边界)）默认检查 / `--write` 采用与复查使用[黄金样板中的 PowerShell 示例](codegen-golden.md#windows-powershell-51)，没有 patch 管道或 PowerShell 文本重定向。它仍会重置隔离测试库（`qiwu_test` / Redis 15），须先核对环境覆盖文件。

## CLI 与工作区写入

根命令委托服务端包，先 build，再运行 `dist/modules/platform/codegen/cli.js`。服务端 cwd 为 `apps/server`，加载 `.env.local` 和 `.env`，凭据分层见[入门文档](getting-started.md)。

| 命令                                     | 行为                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| `pnpm gen import <table...>`             | 存储每张表的默认配置并输出提示                                                           |
| `pnpm gen render <table...>`             | 按配置渲染到 stdout；尚未导入的表使用导入默认值                                          |
| `pnpm gen render <table...> --out <dir>` | 写副本到仓库外目录，允许替换副本已有文件；目录不能通过符号链接指回仓库，使用专用输出目录 |
| `pnpm gen write <table...>`              | 只使用已导入配置；要求 `NODE_ENV=development` 且 `CODEGEN_WRITE=true`                    |

`--out` 只用于 render。`writeWorkspace()` 允许 `apps/*/src`、`packages/shared/src`、`apps/server/test` 与可选的 `mobile/src`，拒绝不合法路径、符号链接与重复输出路径。已有相同文件保留；任何文件内容不同就输出 diff，整批不写。差异先按 Buffer 逐字节比较，再由 Git（`git diff --no-index --no-color --no-ext-diff`）显示 unified hunks；头部只保留仓库相对路径，不泄漏临时文件位置。字节不同但 Git 因行尾或属性归一化返回相同，或没有文本 hunk 时，仍返回带路径的差异提示。未安装 Git 时返回差异提示，其他 Git 错误不会当成空 diff。先检查全部路径，以 `wx` 创建新文件；写入失败时清理本批已创建文件及新建的空目录，不覆盖他人文件。render/write 末尾输出手工注册提示。

渲染实现文件是 `render.ts`：`renderTargets()` 执行 EJS → Prettier → `@generated by qw-codegen (<template>)` 文件头，JSON 无注释头。`emit()`、`str()`、`json()`、`comment()` 管理标识符、字符串与注释输出，模板 lint 禁止不受约束的原样输出。标签、注释和示例值是输入，不能绕过这些转义函数。

G0 样板使用独立命令 `pnpm gen:check-golden`：默认只比较，差异返回退出码 1；明确采用模板渲染结果时运行 `pnpm gen:check-golden --write`，然后再运行默认检查。该命令先构建、重置指定测试库并渲染，沿用 `.env.local` → `.env.test` → 可选本地覆盖 `.env.test.local` 的分层，并校验隔离测试库（`qiwu_test` / Redis 15）的 DB/Redis 配对。

`--write` 只替换现有 G0 模块范围内的渲染文件（含各模块的双语 JSON 片段），只删除原有 `committedGenerated()` 范围内已不再渲染的 `@generated` 文件。写入前校验全部路径及 Git 状态，拒绝符号链接、脏目标、标记为 assume-unchanged / skip-worktree 的目标和未跟踪的已有目标（包括被 Git 忽略的文件）；允许创建尚不存在的目标。替换已有文件时先移除该路径，再以 `wx` 创建新文件，避免改写其他硬链接指向的内容；Node 直接写 UTF-8，不使用 shell patch 管道。中途失败会返回非零、列出已触及路径和 `git checkout -- <paths>` 恢复提示，并列出需移除的新文件；已经写入的内容不会自动回滚。不要手改 G0 产物，应修改模板或配置后用此命令同步。详见 [golden 样板](codegen-golden.md)。

## 建表、软删除与引用约定（New tables）

普通可写业务表有主键、审计列、`deleted_at datetime(3) NULL`。唯一键使用生成列：

```sql
alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL,
UNIQUE (order_no, alive)
```

`alive` 不映射到实体；软删除释放原唯一值。生成实体继承 `BaseEntity` 等基类，常规查询排除软删除行，删除经 `softDeleteRows()` 写删除时间和适用的审计信息。

项目不用数据库外键。引用列保留普通索引，被引用表的 `options.referencedBy` 配置列出 `[{ table, column, label }]`，生成实体调用 `referencedBy()` 登记。配置页和 `PUT /api/codegen/tables/:id` 校验引用表/列以及该表的 `deleted_at`，无效配置返回 422 `C3009`。写入新的引用经 `assertReferencesLive()` 读父行 `FOR SHARE`：不存在或已删除返回 404；删除父行发现有效限制引用则 409 `in_use`。

主子表模板把子表 fk 登记为 `cascade: true`，删除主表时同事务软删除子行；编辑省略整组子行会保留，提交新数组则删除数组中遗漏的旧行。子表自身被其他记录引用时，主表删除同样受限制。手写模块的引用需要在其注册位置手工登记，例如 `project.module.ts` 中 `demo_book.dept_id` → `iam_dept` 的引用。

没有 `deleted_at` 的表在 import、默认 render、preview/download/write 和 sync 入口被拒绝，CLI 退出非零，配置不会因失败 sync 而被替换。导入列表用 `noDeletedAt` 标记。唯一键没有 `alive` 只给提示，数据库仍可能占用软删除行的旧值；生成器不会自动修 DDL。提交为 G0 的表由 `seedCgConfig()` 强制检查这些约定，缺失会使种子与 golden 检查失败。

## 数值精度边界

`rules.ts` 的 `tsTypeOf()`、`SAFE_DIGITS = 15`、`crud.ts` 的 `zodOf()` 与 `entityOptions()` 决定实际模型。生成配置、API、shared schema、表单和 Excel 必须沿同一条类型路径。

| 数据库列                                  | 当前生成模型                                                                                             | 使用边界                                                                                                                     |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `int` 等整数、`bigint`                    | JavaScript `number`，整数 schema                                                                         | 本项目 bigint 数值合同写作 **≤ 2^53**；要逐整数可靠，严格安全上限是 `Number.MAX_SAFE_INTEGER = 2^53 - 1`（9007199254740991） |
| `decimal(p,s)` / `numeric(p,s)`，`p ≤ 15` | 默认 `number`；MySQL 的 decimal 字符串经生成实体的 `decimalNumber` 转换；表单数字控件和数值 Excel 单元格 | **总有效数字 ≤ 15 位**，包含整数与小数位，不能理解为仅小数位 ≤ 15                                                            |
| 宽 decimal，`p > 15`                      | 导入规则已经默认 `string`；decimal 渲染路径输出十进制字符串校验、文本输入与文本 Excel 单元格             | 保留驱动返回的文本精度；不要为了使用数字控件而转成 `Number()`                                                                |
| `float` / `double`                        | `number`                                                                                                 | 是近似数值，不承诺十进制精确计算                                                                                             |

`2^53 = 9007199254740992` 本身可表示，但已经超过安全整数边界，无法承诺相邻每个整数都准确表示。例如：

```js
Number.isSafeInteger(2 ** 53 - 1) // true
Number.isSafeInteger(2 ** 53) // false
2 ** 53 + 1 === 2 ** 53 // true
```

ID、计数和外部系统 bigint 不应超过安全整数范围。MySQL 支持更大的 bigint/decimal；这些应用边界不会给数据库自动加拒绝约束。驱动可能把过大的 bigint 返回为字符串，与当前 number schema 不一致，不能据此承诺已支持全范围 bigint。

生成的整数输入 schema 使用 `z.number().int()`（`crud.ts` 的 `zodOf()`）；Zod 4 的 `.int()` 只接受安全整数，因此生成 API 的写入已拒绝大于 `2^53 - 1`（`Number.MAX_SAFE_INTEGER`）的值，数据库自身仍允许其列类型范围内的更大值。

15 位是 number 路径的保守上限，不保证二进制浮点能精确表达每个小数（如 `0.1`）。金额等业务若需要精确运算，应明确舍入规则或采用十进制字符串/运算方案。当前宽 decimal 已有字符串路径；若还需要完整 bigint 或新的精确计算合同，应另立 CR，同步 schema、API、实体、筛选、表单、导入导出与调用者。

## 模板能力与公共控件

CRUD 模板生成标准权限与路由、列表筛选（like/eq/between）、软删除、导出、可选导入、options、详情抽屉与表单。`withImport` 的 upsert 按可导入列中的首个唯一字段匹配范围内记录，再走基类 create/update；没有适用唯一字段时只提供 insert。只读配置保留 browse/view/export，不生成写路由、写按钮和表单；仅有追加日志列的表用 `IdEntity` / `CreatedEntity` 并保持只读。

`tree` 模板用于 `parent_id` + `tree_path`，服务继承 `BaseTreeService`，列表为森林，无分页/批量删除/导出。`master_sub` 需要主表配置与子表配置的 `masterTableId/subFkCol` 关联，服务按主表锁与子行 id 做差量更新；引用与整单事务仍适用。细节与手写部门特性见[黄金样板](codegen-golden.md)。

生成的桌面列表以 `div.qw-page` 开始，使用搜索卡片、`TableToolbar`、`QwTable`、`Pagination`；标签页与面包屑显示页名，不额外生成页标题或 `.description` 词条。列来自 `QwColumn[]`，`#cell-<prop>` / `#actions` 承载自定义单元格与操作，`table-id` 是 `<domain>.<camelBusiness>`。编辑按钮需要 view 与 modify，因为表单会读取详情。

公共组件行为：`QwTable` 在首次 `loading` 且尚未结束首次请求时显示骨架，首次结束后（包括失败或空结果）后续加载不再回到首屏骨架；生成页通过 `:loading` 使用它。含日期范围筛选的 `index.vue.ejs` 调用 `useDateRangeShortcuts()`，与用户页、动作日志页共用今天/近七天/近三十天，点击时计算本地日界，标签响应语言切换；不在各页复制常量。弹框底部分隔线与 `.el-dialog` 的视口宽度上限统一在 `styles/element.css` 定义。G0 产物随模板原样重渲染，不能手改样例补这些效果。

## 手写扩展的位置

`iam/user` 是复杂手写样例。生成器覆盖通用能力，下面的业务规则在需要时按现有入口添加。G0 模块的生成文件不得手改：优先用约束、生成配置、手写同目录组件或 `<domain>-<business>-extra.e2e-spec.ts`；确实需要修改生成文件时，从 golden 清单移除该模块，转为 G。

| 扩展                 | 入口                                                                      | 用户模块示例                                                              |
| -------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 数据范围             | 实体 `@DataScoped`，读 `scopedQb`，写 `lockScopedIds/assertWritableScope` | `owner: 'id'`，`own_rows` 只见自己的用户行；详见[数据权限](data-scope.md) |
| 关联显示列           | 在范围查询中 join，再映射 VO                                              | `withDept()` / `deptName`                                                 |
| 服务端写入列         | 从请求 schema 排除，由服务写入；秘密列 `select: false`                    | password hash、改密时间、最近登录                                         |
| 额外字段格式         | shared schema `.regex()`、`z.email()`、`blankAsNull()`、固定枚举          | username/mobile/email/gender；字典生成列不自动验证值是否在字典中          |
| 掩码显示             | 服务 VO 映射 `masked.*`                                                   | 没有 modify 时隐藏联系方式明文                                            |
| 运行时校验政策       | controller 接收 unknown 并提供 Swagger，服务与表单用相同政策构造 schema   | `userCreate(policy)` / 改密 schema                                        |
| 多对多关联           | 写事务内 `replaceLinks()`，详情返回关联 id，表单多选                      | user_roles/user_positions                                                 |
| 防越权与保护行       | 范围锁之后、事务内判断                                                    | `GrantPolicy.assertAssignableRoles()`、root/本人保护                      |
| 会话副作用           | 最外层提交后执行                                                          | `PermVersion.bumpUser()` / `SessionRevoker.revokeUser()`                  |
| 跨字段筛选           | query 与 `filter()` 同步，列表/导出共用                                   | keyword、部门子树、受掩码约束的 mobile 筛选                               |
| 带查询的 options     | schema + 范围过滤 + 数量上限 + 所需显示字段                               | `userOptionQuery`、`PAGE_SIZE_MAX`、UserPicker                            |
| 模块动作             | 独立 perm 与日志动词，按 id 的写操作先锁定                                | `/:id/password`、`/:id/roles`                                             |
| 隐藏子页面           | 在模块 seed 中建立不可见页面及动作                                        | `iam-user-roles`，授予动作同时下发路由                                    |
| Excel 下拉           | 列 `pick: true` 与 template 的 lists；导出也用相同 id/文本表示            | 部门 `<id> - <名称路径>`                                                  |
| 自定义导入           | `ExcelService.read()` → 模块自己的 create/update → 每行 failure/result    | 初始密码、保护行、upsert username；不绕过范围和授权                       |
| 列表旁树筛选         | `TreePanel` 与列表条件绑定                                                | 用户页部门树，持久化宽度与折叠                                            |
| 默认隐藏列           | `QwColumn.hidden: true`                                                   | email、最近登录、创建时间、备注                                           |
| 额外详情             | 手写 detail 组件与 VO                                                     | 角色/岗位名、联系方式掩码与状态头                                         |
| 更多行操作           | `#actions` 的 dropdown，每项检查权限                                      | 重置密码、跳转分配角色                                                    |
| 行与调用者限制       | 禁用服务端会拒绝的按钮，按权限控制筛选字段                                | `locked(row)`、root/本人限制                                              |
| 仅新增字段、弹框宽度 | form 用 `v-if="id == null"`，`openDialog(Form, { id }, { title, width })` | 密码仅新增时显示，用户弹框 600px                                          |

生成 `secret` 控件的列保留密文实体属性、写入字段去掉 Enc，VO/列表/Excel 排除秘密；非空写入经 `SecretBox`，空更新保留已有密文。富文本经 `sanitizeFields` 保存与读取清洗，字典、部门树、用户选择、上传控件复用 core 组件。控件契约以[黄金样板](codegen-golden.md)和模板为准，业务新增验证不能只做在前端。

用户导入不含角色、岗位和密码。新增用户使用初始密码并在首次登录改密；更新用户保留原密码。角色和岗位后续从页面分配，执行对应授权与范围检查。

## 移动端与双语片段

开启生成页的移动端开关 `options.withMobile`，且 `hasMobile()` 检测到 `mobile/src/pages.json` 时，同次 render/preview/zip/write 输出 uni-app API、列表、详情、添加/编辑页和双语片段。依赖客户端的 `mobile/src/core/crud.ts` 与公共 `crud.*` 词条；登记 pages.json 和入口仍由项目完成。

只读模块无 form；移动端不生成桌面完整筛选、秘密控件等能力，具体边界见[黄金样板移动页说明](codegen-golden.md#mobile-pages-optionswithmobile)。只做 PC 的项目按[移动端文档](mobile.md)删除 `mobile/`，生成器就不渲染或比较移动文件，`MOBILE` 路径常量和 `uni/` 模板可保留。

模块自有文案进入新片段，`field.*` 来自 shared，通用操作来自 `crud.*`，没有中文硬编码进业务 `.ts/.vue`。新项目在自己的领域片段增加双语词条，不修改平台文案实现业务定制；默认英文标签需要校对，检查及严格 TODO 清零见[国际化文档](i18n.md)。

## G0 与检查边界

G0 指"生成且零手改"的模块，由 `pnpm gen:check-golden` 保证与模板渲染结果逐字一致；G 指生成后再手工修改的模块，不受该检查约束。

保留的生成配置以 `apps/server/src/db/seeds/codegen/<table>.cg.ts` 注册到 `CG_SEEDS`。G0 样例为 `iam_position`、`demo_book`、`demo_topic`、`demo_invoice`（含 line）。`pnpm gen:check-golden` 重新渲染并逐字比较提交的生成物；模板变更必须与原样生成物一起维护，脚手架产物以独立的 `scaffold via codegen` 提交保存。

该命令会重置隔离测试库（`qiwu_test` / Redis 15），使用 `.env.test` 与可选本地覆盖 `.env.test.local`，不是纯静态检查；执行前按[入门指南第 2 节](getting-started.md#2-空库账号与隔离)核对测试数据库与 Redis 配置，并确保没有其他检查同时使用它们。`pnpm gen write` 不覆盖已有文件；模板变更后按[上文 `--write` 说明](#cli-与工作区写入)及[黄金样板](codegen-golden.md)采用重新渲染的 G0 生成物，再检查 `git diff`。默认检查会输出差异以及 `missing:` / `stale:` 路径提示，不能作为 patch 管道输入：

```sh
pnpm gen:check-golden --write
pnpm gen:check-golden
```

`pnpm verify` 检查 lint、架构、类型、i18n、原创性与许可证，不包含生成项目演练或权限/通知运行时验证。人工验收在隔离项目完成：导入生成一个项目模块、注册与授权、检查数据范围及中英切换；通知观察见[通知文档](notify.md)。

## 实现入口

- [CLI](../apps/server/src/modules/platform/codegen/cli.ts)：参数、配置获取、输出与退出码。
- [导入规则](../apps/server/src/modules/platform/codegen/rules.ts)和[配置服务](../apps/server/src/modules/platform/codegen/codegen.service.ts)：命名、表结构与配置校验。
- [CRUD/树/主子模型](../apps/server/src/modules/platform/codegen/crud.ts)和[渲染器](../apps/server/src/modules/platform/codegen/render.ts)：生成类型、路径、转义和注册提示。
- [工作区写入](../apps/server/src/modules/platform/codegen/workspace.ts)：路径白名单、冲突与清理。
- [数值转换与实体基类](../apps/server/src/core/db/base.entity.ts)、[引用登记](../apps/server/src/core/db/references.ts)。
- [列表模板](../apps/server/codegen-templates/web/index.vue.ejs)、[QwTable](../apps/web/src/core/components/QwTable.vue)、[日期快捷项](../apps/web/src/core/date-shortcuts.ts)。
