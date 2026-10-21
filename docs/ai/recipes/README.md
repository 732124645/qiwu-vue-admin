# 任务配方

在本底座上写业务时的高频任务，每篇按同一结构写：**适用场景 → 步骤（文件与命令）→ 完成检查 → 常见错误**。能用代码生成器的步骤一律先用生成器，不手写。配方只写操作顺序，规则的原因和细节链接到 `docs/` 下的专题文档。

开始任何任务前先读仓库根目录的 `AGENTS.md`；项目自己有 `docs/project-rules.md` 时一并读，冲突时以它为准。

| 配方                                   | 什么时候用                                                   |
| -------------------------------------- | ------------------------------------------------------------ |
| [新增业务模块](new-module.md)          | 新增一张业务表的增删改查页面（单表、树、主子表），生成器优先 |
| [建表与迁移](table-migration.md)       | 新建或修改表：迁移命名、租户列、软删除、唯一键、平台表登记   |
| [权限与菜单](permission-menu.md)       | 新增权限点、页面菜单、菜单分组、操作日志动词，给角色授权     |
| [字典与系统参数](dict-param.md)        | 新增字典或系统参数，种子写入，前后端读取                     |
| [数据权限](data-scope.md)              | 让表按部门、创建人过滤；手写 SQL 读带数据权限的表            |
| [手写 SQL 与租户](tenant-sql.md)       | 原始 SQL 读写租户表、跨租户扫描、拼接 SQL                    |
| [队列任务与定时任务](job.md)           | 把耗时工作交给后台队列，或新增定时任务处理器                 |
| [MCP 工具](mcp-tool.md)                | 让智能体通过 MCP 调用本模块的能力                            |
| [智能助手的工具与技能](agent-skill.md) | 给后台智能体一个读写本模块的工具、批量执行目标与技能         |
| [多语言词条](i18n.md)                  | 新增界面、校验、字段、菜单、服务端消息的中英文词条           |
| [接口测试](api-test.md)                | 给接口写端到端测试：成功、403、400、404 与跨租户 404         |

## 通用完成标准

每个任务结束前至少运行该配方“完成检查”里的命令，改了模块、表、接口、权限、菜单、字典、参数、任务或 MCP 工具时运行 `pnpm ai:map` 更新项目地图，最后运行 `pnpm verify`（规则同步、lint、架构检查、项目地图是否过期、类型检查、多语言、原创性、许可证）。改了接口的任务还要跑对应的端到端测试：`pnpm --filter @qiwu/server test <spec 文件名去掉 -spec.ts>`，例如 `pnpm --filter @qiwu/server test demo-book.e2e`。

示例模块：`demo` 领域是生成器的样例（单表 `demo_book`、树 `demo_topic`、主子表 `demo_invoice`），`biz/leave` 是接入审批流程的手写样例。下面各篇以图书 `demo/book` 为例；这些路径只是可模仿的写法，项目删掉示例领域后它们可能已不存在，照配方里的 `crm_customer` 例子写即可：

| 层     | 文件                                                                                                             |
| ------ | ---------------------------------------------------------------------------------------------------------------- |
| 迁移   | `apps/server/src/db/migrations/20260927130100-demo-book.ts`（之后的迁移又加了 `tenant_id` 等）                   |
| 服务端 | `apps/server/src/modules/demo/book/`（entity、service、controller、module、seed）                                |
| 共享   | `packages/shared/src/demo/book.schema.ts`（schema、`bookPerms`）                                                 |
| 词条   | `apps/web/src/locales/zh-CN/demo.book.json`、`packages/shared/src/i18n/zh-CN/modules/demo.book.json`             |
| 页面   | `apps/web/src/views/demo/book/`（index、form、detail）、`apps/web/src/api/demo/book.ts`                          |
| 测试   | `apps/server/test/e2e/demo-book.e2e-spec.ts`（生成）、`apps/server/test/e2e/demo-book-extra.e2e-spec.ts`（手写） |
| 智能体 | `apps/server/src/modules/demo/book/book.mcp-tools.ts`                                                            |

## 维护

配方与 AI 入口文件由 `pnpm arch:check` 的 `ai-docs` 检查（`scripts/arch/ai-docs.mjs`）核对：提到的 `pnpm` 脚本必须存在于对应的 `package.json`，提到的仓库路径必须存在，`.md` 链接及其 `#锚点` 必须能解析到标题。报错给出文件与行号；改正文中的写法，或者在代码改名时同步改配方。含 `<`、`*`、`{` 的路径视为占位符，不检查。
