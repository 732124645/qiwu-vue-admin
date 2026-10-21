# 开发规则（写给在本模板上开发业务的人与 AI 编程工具）

本文件是项目开发约定的唯一入口：Claude Code 经 `CLAUDE.md`、Codex 直接、Cursor 经 `.cursor/rules/qiwu.mdc`、Copilot 经 `.github/copilot-instructions.md` 读到它。细节都在仓库的 `docs/`，这里只列必须遵守的约定与去处。

**项目自己的规则写在 `docs/project-rules.md`**。模板不提供这个文件，升级模板时不会冲突。动手前先看它是否存在：存在就先读它，它与本文冲突时以它为准。

常见任务的分步配方在 [docs/ai/recipes/](docs/ai/recipes/)，总览见 [docs/ai.md](docs/ai.md)。项目里有哪些模块、表、接口、权限码、菜单、字典与参数，先查自动生成的 [docs/ai/project-map.md](docs/ai/project-map.md)，不必遍历仓库。

## 技术栈与目录

NestJS 12（ESM）+ Vue 3.5 + Vite + Element Plus + TypeScript + MySQL + Redis，pnpm workspace 单仓。Node ≥ 22.22.1，pnpm 版本由 `package.json` 的 `packageManager` 固定。

| 目录              | 内容                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/server`     | `@qiwu/server`：`src/core`（框架）、`src/modules/{platform,workflow}`（模板模块）、`src/db/{migrations,seeds}`、`src/i18n`、`test/`              |
| `apps/web`        | `@qiwu/web`：`src/core`（布局、路由、请求、状态、权限、i18n、公共组件）、`src/views`、`src/api`、`src/locales`、`e2e/`                           |
| `packages/shared` | `@qiwu/shared`：zod schema、类型、错误码、权限常量、校验消息与字段标签                                                                           |
| `mobile/`         | 可选的 uni-app 员工端，在根 workspace 之外（自己的 `package.json` 与锁文件），别处不得导入它；只做 PC 可按 [docs/mobile.md](docs/mobile.md) 删除 |

项目代码只放项目领域目录，领域取表名第一段（`erp_sale_order` → 领域 `erp`、业务 `sale-order`）：

- 服务端 `apps/server/src/modules/<domain>/<business>/`，在 `apps/server/src/modules/project.module.ts` 注册；
- Web `apps/web/src/views/<domain>/<business>/`、`apps/web/src/api/<domain>/`；
- shared `packages/shared/src/<domain>/`，在 `packages/shared/src/index.ts` 导出。
- 后台智能体（智能助手）用的工具写在模块的 `<business>.mcp-tools.ts`（`@McpTool`，写入工具加 `preview` 给审批卡片），列表批量执行的目标用 `@AgentBatchTarget`，项目自带的技能写成 `SEEDS.project` 里的种子，见 [docs/ai/recipes/agent-skill.md](docs/ai/recipes/agent-skill.md)。

`biz`、`demo` 是模板自带的示例领域，可改可删；本文与配方里引用的示例路径（`demo/book` 等）只是可模仿的写法，项目删掉示例后它们可能已不存在。包作用域保持 `@qiwu/*`，不需要全仓改名。哪些文件属于项目、哪些属于模板见 [docs/upgrade.md](docs/upgrade.md)：尽量不改模板文件，升级时冲突才少。

## 分层

由 lint 与 `pnpm arch:check` 强制（[docs/design-notes.md#layering](docs/design-notes.md#layering)）：

- `core` 不导入任何模块；
- `platform` 不导入 `workflow` 与项目领域；
- `workflow` 不导入项目领域；
- 项目领域可以使用以上各层；前后端共享的东西放 `@qiwu/shared`。
- `packages/shared` 也跑在移动端，只能导入 zod 与自身文件（不用 Node API、不用 Vue）。

## 命名

- **表名**：`<领域>_<业务>`，如 `erp_sale_order`。模板占用的前缀 `iam_ cfg_ msg_ aud_ fs_ job_ cg_ oauth_ im_ wxoa_ wf_ biz_ demo_ test_ meta_` 不给项目新领域用；保留的领域名见 `packages/shared/src/common/reserved-names.ts`。
- **权限码**：`<domain>.<resource>.<verb>`，如 `erp.saleOrder.browse`（业务段小驼峰；常用动词 `browse view create modify remove import export`），在 shared 的 `xxxPerms` 对象里导出、前后端同源。绝不用 `a:b:c` 形式。
- **字典码**用点分：`iam.gender`；**枚举值**用字符串码，不用数字。
- **路由名**：页面 `<domain>-<business>`（`erp-sale-order`），菜单分组只用小写字母、数字与连字符（`erp-sale`），保存后只读。
- **字段标签**：`field.<domain>.<prop>`；**表格 id**：`<domain>.<business>`（如 `erp.saleOrder`）。
- 生成器的完整命名推导见 [docs/codegen.md](docs/codegen.md)。

## API 约定

详见 [docs/design-notes.md#api-envelope](docs/design-notes.md#api-envelope)。

- 路径 `/api/<domain>/<复数-kebab>`（控制器 `@Controller('erp/sale-orders')`），Swagger 标签为领域（`@ApiTags('erp')`），每个路由写 `@ApiOperation` 与 `@ApiEnvelope(...)`。
- 成功响应 `{ code: 0, msg, data }`；分页 data 为 `{ items, total }`，查询用 shared 的 `pageQuery([...可排序字段])`。
- 失败带业务码、已翻译的 `msg` 与 `traceId`；HTTP 状态用真实语义：400 校验、401 未认证、403 无权限、404 不存在或超出数据范围（含跨租户）、409 冲突、422 业务拒绝、429 限流或重复提交。
- 请求校验只用 `@qiwu/shared` 的 zod schema：`@Body({ schema })`、`@Query({ schema })`。校验消息是 `validation.*` 翻译键，schema 用 `.register(fieldDomains, { domain })` 登记字段领域；服务端不另建 `validation.json` / `field.json`。
- 每个路由用 `@RequirePerm(xxxPerms.<verb>)` 检查权限；前端用 `v-perm` / `usePerm` 只控制显示，不代替服务端授权。
- 数据库会话用 UTC，API 时间为 ISO-8601。

## 多语言

详见 [docs/i18n.md](docs/i18n.md)。

- `.ts` / `.vue` 里不写中文字面量（locale 与种子文件除外），一律用翻译键。
- 每个键同时写 `zh-CN` 与 `en-US`，两边同键。项目词条放自己的片段：Web `apps/web/src/locales/{zh-CN,en-US}/<domain>.<business>.json`，shared 字段 `packages/shared/src/i18n/{zh-CN,en-US}/modules/<domain>.<business>.json`，服务端消息 `apps/server/src/i18n/{zh-CN,en-US}/`。不要复制 shared 已有的键。
- 数据库里的显示名存翻译键（菜单 `menu.*`、种子 `seed.*`）或 `*_i18n` JSON（字典、参数）；用户填写的业务数据保持原文。

## 多租户与数据权限

代码一律按多租户写，开关（`APP_MULTI_TENANT`）关闭时只是全部请求都在默认租户里。详见 [docs/multi-tenancy.md#编写租户感知的项目代码](docs/multi-tenancy.md#编写租户感知的项目代码) 与 [docs/data-scope.md](docs/data-scope.md)。

- **新表默认是租户表**：`tenant_id bigint unsigned NOT NULL`，唯一键以它开头（`UNIQUE (tenant_id, order_no, alive)`），没有唯一键时加 `KEY idx_<表名>_tenant (tenant_id)`；实体用 `@TenantColumn()` 映射这一列。
- 确由平台统一维护、全部租户共用的表登记进 `apps/server/src/db/project-tables.ts` 的 `PROJECT_PLATFORM_TABLES`；必须跨租户唯一的键登记进同文件的 `PROJECT_GLOBAL_UNIQUE` 并写明释放方式（`none` / `row-delete` / `takeover`）。不要改 `apps/server/src/core/db/tenant-tables.ts`（模板的登记）。
- 平台页面：`route_name` 加进 shared 的 `PLATFORM_ONLY_ROUTES`（`packages/shared/src/common/tenancy.ts`），控制器每个带权限点的路由加 `@PlatformOnly()`。该文件属于模板（没有项目自己的登记处），升级时可能冲突，见 [docs/upgrade.md](docs/upgrade.md)。
- ORM 自动加租户条件；**原始 SQL 自己写**：每张租户表（含 join 的）带 `<别名>.tenant_id = ?`，顶层 `OR` 先加括号；`INSERT` 写 `tenant_id`；确需跨租户的语句写 `qw:cross-tenant <理由>`。
- 租户表不用 ORM upsert（`orUpdate`、`repo.upsert`）、`clear()` 与 `@ManyToMany`（关联表用 `core/db/links.ts` 或映射成实体）。
- 跨租户只经 `core/context/tenant.ts` 的 `withTenant` / `allTenants`，每处调用写 `qw:cross-tenant <理由>` 注释。按租户的定时任务：在 `allTenants` 下只扫可用租户的行，再逐行 `withTenant`。
- **数据权限**：带 `@DataScoped` 的实体只经 `BaseCrudService` 的 `scopedQb()` 读，按 id 写之前在事务内 `lockScopedIds(ids)`，新增与改范围列时 `assertWritableScope()`。自定义过滤用 `andWhere()`，不要用会覆盖范围的 `where()`。
- 原始 SQL 读带范围的表：在同一函数里调用 `dataScopeSql` / `dataScopeSqlFor`，把 `${scope.sql}` 插进语句；不代表调用者读数据的系统查询写 `qw:no-data-scope <理由>`。原始 SQL 还要自己写 `deleted_at IS NULL`（有意读已删除行时写 `qw:include-deleted`）。
- Redis 键一律经 `apps/server/src/core/redis/cache-namespaces.ts` 构造（前缀 `qw:`，每个命名空间声明 `tenant` / `global-id` / `platform` 维度）。
- 后台任务用队列：`QueueService.add` 记下当前租户，处理器继承 `TenantJobProcessor` 且必须幂等，见 [docs/queue.md](docs/queue.md)。
- 新的 `@Public()` 路由在 `apps/server/test/e2e/tenant-public.e2e-spec.ts` 登记租户来源（模板文件，升级时可能冲突）。

## 安全默认

详见 [docs/security.md](docs/security.md)。

- SQL 只用参数（`?` / `:name`）。动态拼接被 `no-sql-concat` 拒绝；确需拼接（标识符来自代码）时写 `// arch-allow: sql-concat <理由>`，并在其中写 `tenant: <怎样留在租户内>`。
- 每个非 GET 控制器方法带 `@ActionLog({ domain, verb })` 或 `@SkipActionLog()`。项目新动词（kebab-case）登记在 `apps/server/src/db/seeds/project/action-verbs.seed.ts` 的 `PROJECT_ACTION_VERBS`，不改平台的 `VERBS`。
- 新建类写路由加 `@Idempotent()`（`core/guard/idempotent.ts`，3 秒内重复回 429）；前端提交按钮在请求期间 `loading` 且禁用（CRUD 套件已处理）。
- 不用 `eval`、`new Function`、`vm`；富文本经 `sanitizeFields` 清洗；文件上传与 Excel 走 core 的现成服务。
- 秘密（数据库与 Redis 凭据、`APP_SECRET`、`SEED_ADMIN_PASSWORD`）只写在 git 忽略的 `apps/server/.env.local`；`.env` 不定义这些键（空值也会遮住 `.env.local`）；任何秘密都不放 `VITE_*`。
- 依赖只选维护活跃、许可宽松的包，要过 `pnpm license:check`（禁用包列表在 `scripts/license-check.mjs`）；需要构建脚本的包登记到 `pnpm-workspace.yaml` 的 `allowBuilds`。

## 前端 CRUD 套件

详见 [docs/codegen-golden.md](docs/codegen-golden.md) 与 [docs/design-notes.md#crud-kit](docs/design-notes.md#crud-kit)。

- 列表：`QwTable` + `columns` 数组（`#cell-<prop>` / `#actions` 插槽）、`TableToolbar :columns`、`Pagination`，`table-id` 为 `<domain>.<business>`，列偏好由 `useTablePrefs` 保存；列表状态用 `useCrudList`。
- 新增与编辑：对话框内容组件（`id?` 属性，发出 `done` / `cancel`，内部用 `useCrudForm`），用 `await openDialog(Form, { id }, { title })` 打开。
- 页面由菜单加载，视图与 locale 片段按 glob 合并，不手工注册路由。
- 样式遵守 [docs/design/visual-system.md](docs/design/visual-system.md)：颜色、圆角、阴影只用 `--qw-*` 令牌，组件里不写原始十六进制色值；Element Plus 的覆盖只写在 `apps/web/src/styles/element.css`。

## 迁移与种子

- 迁移放 `apps/server/src/db/migrations/`，文件名 `<14 位时间戳>-<kebab 名>.ts`，类名以同一时间戳结尾。时间戳用**创建时的真实当前时间，精确到秒**，不用整点。发布过的迁移不改不改名。见 [docs/new-project.md](docs/new-project.md)。
- 每张表有主键、审计列、`deleted_at datetime(3) NULL`；`ENGINE=InnoDB`、`utf8mb4_0900_ai_ci`，表和每一列都写 `COMMENT`；`id` 与 `*_by` 用 `bigint unsigned`，`*_at` 用 `datetime(3)`；`down()` 必须完整撤销 `up()`（测试会把全部迁移回退到空库再重新执行）。软删除唯一性用生成列 `alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL`，实体不映射它。不用数据库外键，引用用 `referencedBy()` 登记。约定见 [docs/codegen.md](docs/codegen.md#建表软删除与引用约定new-tables)。
- 迁移里往租户表 INSERT 时显式写 `tenant_id`。
- 项目种子登记在 `apps/server/src/db/seeds/index.ts` 的 `SEEDS.project`（只在默认租户运行）；菜单分组在 `apps/server/src/db/seeds/project/menu-groups.seed.ts` 的 `PROJECT_MENU_GROUPS`；每个租户都要的基础数据在 `apps/server/src/db/seeds/project/tenant.seed.ts` 的 `PROJECT_TENANT_SEEDS`。种子必须可重复执行，只补缺少的行。
- 先 `pnpm db:migrate` 再 `pnpm db:seed`；不要对已有的开发库执行 `pnpm db:reset`。

## 生成器优先

标准 CRUD、树、主子表一律先用生成器，再在生成物上手写扩展（[docs/codegen.md](docs/codegen.md)）：

1. 写迁移建表 → `pnpm db:migrate`；
2. `pnpm gen import <table>` 导入并检查配置；
3. `pnpm gen render <table> --out <仓库外目录>` 预览，或 `NODE_ENV=development CODEGEN_WRITE=true pnpm gen write <table>` 写入工作区（不覆盖已有文件）；
4. 按命令末尾打印的提示手工注册（模块、种子、shared 导出、菜单分组）→ `pnpm --filter @qiwu/shared build` → `pnpm db:seed` → `pnpm ai:map`；
5. 在运行中的后台“角色管理”授权（多租户时再勾进租户套餐）：由开发者操作，或请用户操作，AI 工具不自己启动 `pnpm dev`。

`pnpm db:migrate`、`pnpm db:seed`、`pnpm gen` 都先 `nest build`，读的是 `@qiwu/shared` 的构建产物（只有类型检查与单元测试读源码）：改了 shared 的导出、权限点或参数键后，先 `pnpm --filter @qiwu/shared build` 再运行它们。

生成物带 `@generated` 文件头；模板自带的生成样例（`iam_position`、`demo_*`）由 `pnpm gen:check-golden` 逐字比对，不要手改。

## 测试与完成标准

一项改动完成 = 代码 + 测试 + `pnpm verify` 通过 + 中英文词条 + Swagger 描述 + 权限进 `xxxPerms` 与模块的菜单种子；改了模块、表、接口、权限、菜单、字典、参数、任务或 MCP 工具时先 `pnpm ai:map` 更新项目地图。

- 逻辑写单元测试；每个接口写端到端用例：成功、403（无权限）、400（校验失败）与范围外 404；租户表的每个端点至少一条跨租户 404（`apps/server/test/setup/tenants.ts` 的 `createTenant`，`afterAll` 里 `dispose()`）。生成的 spec 已带这些分组，手写补充放 `<domain>-<business>-extra.e2e-spec.ts`。
- spec 文件名全仓唯一；运行单个 spec 用完整的名字主干：`pnpm --filter @qiwu/server test erp-sale-order.e2e`（不要加 `--`，加了就不再过滤）。
- 服务端测试每次运行前重建 `.env.test` 指定的测试库（`qiwu_test`、Redis 15），准备方法见 [docs/getting-started.md#服务端测试](docs/getting-started.md#服务端测试)；不要让它指向开发库。
- 非平凡方法写简洁的中文注释，说明业务目的；租户边界、安全检查、幂等与失败处理写明原因。

## 命令与闸门

| 命令                                                                   | 作用                                                                                                           |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `pnpm i`                                                               | 安装依赖                                                                                                       |
| `pnpm --filter @qiwu/shared build`                                     | 构建 shared（首次安装后；改了 shared 后、运行 `db:migrate` / `db:seed` / `gen` 或服务端前）                    |
| `pnpm verify`                                                          | **完成线**：规则入口、lint、架构检查、项目地图是否过期、类型检查、i18n、原创性、许可，不连数据库               |
| `pnpm lint` / `pnpm arch:check` / `pnpm typecheck` / `pnpm i18n:check` | `verify` 的单项，定位问题时单独跑                                                                              |
| `pnpm format`                                                          | prettier 格式化                                                                                                |
| `pnpm --filter @qiwu/server test <stem>`                               | 跑一个服务端 spec（需要测试库）                                                                                |
| `pnpm --filter @qiwu/web test <stem>`                                  | 跑一个 Web 单元测试                                                                                            |
| `pnpm db:migrate` / `pnpm db:seed`                                     | 迁移 / 种子                                                                                                    |
| `pnpm gen import\|render\|write <table>`                               | 代码生成器                                                                                                     |
| `pnpm ai:map`                                                          | 重新生成项目地图 `docs/ai/project-map.md`（改了模块、表、接口、权限、菜单或种子后；`verify` 会检查它是否过期） |
| `pnpm ci:local`                                                        | 完整本地闸门（构建、全部测试、Playwright、冒烟），耗时长，需要全部测试库；由开发者决定何时跑                   |
| `pnpm mobile:verify` / `pnpm mobile:test`                              | 移动端检查（有 `mobile/` 时）                                                                                  |

`pnpm dev` 只由人在终端交互运行；AI 工具不要启动常驻的开发服务器。提交信息用 Conventional Commits（commitlint 检查），scope 建议写 `<domain>/<module>`，如 `feat(erp/sale-order): ...`。

## 常见错误

架构检查、`i18n:check`、`originality:check`、`license:check` 的失败后面带 `fix:`（怎么改）与 `see:`（哪篇文档），项目地图过期时提示运行 `pnpm ai:map`，先照它改；lint、类型检查与 `rules:check` 只给出原始报错。下表是常见的几类。不要绕过检查：

| 报错来源                                        | 原因与改法                                                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| arch `action-log`                               | 非 GET 路由缺 `@ActionLog` / `@SkipActionLog()`，或项目动词没登记在 `action-verbs.seed.ts`                      |
| arch `tenant-sql`                               | 原始 SQL 漏了某张租户表的 `tenant_id` 条件或 INSERT 的 `tenant_id`；补上，确需跨租户写 `qw:cross-tenant <理由>` |
| arch `data-scope-sql`                           | 原始 SQL 读带 `@DataScoped` 的表却没插 `${scope.sql}`；用 `dataScopeSql`，系统查询写 `qw:no-data-scope <理由>`  |
| arch `soft-delete-sql`                          | 原始 SQL 漏了 `deleted_at IS NULL`                                                                              |
| arch `no-sql-concat`                            | SQL 里拼了变量；改成参数                                                                                        |
| arch `scoped-access`                            | 带 `:id` / `ids` 的写路由没经过 `lockScopedIds`                                                                 |
| arch `redis-keys`                               | 直接写了 Redis 键字符串；改用 `cache-namespaces.ts`                                                             |
| arch `migration-names`                          | 迁移文件名不是 14 位时间戳，或时间戳重复；换成当前真实时间（文件名与类名一起改）                                |
| arch `project-layers` / `reserved-names`        | 模板层导入了项目领域，或项目领域占用了保留名                                                                    |
| arch `no-eval` / `shared-portable` / `web-deps` | 动态执行代码；shared 用了 Node API；Web 用到的包放在了 devDependencies                                          |
| `i18n:check`                                    | 中文字面量写进了 `.ts/.vue`、键只在一种语言里、重复的键、引用了不存在的键                                       |
| `originality:check`                             | 出现 `a:b:c` 形式的权限串                                                                                       |
| `license:check`                                 | 依赖的许可不在允许列表或是禁用包                                                                                |
| `typecheck` 找不到 `@qiwu/shared`               | 新检出或改了 shared 的导出后先运行 `pnpm --filter @qiwu/shared build`（Web 的 e2e 用例读它的构建产物）          |
