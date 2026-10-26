# 升级模板版本

从本模板建立的项目，怎样合并模板发布的新版本。新项目的建立见[从模板创建新项目](new-project.md)；已有安装的数据库升级（migrate → seed）见[入门指南](getting-started.md#5-检查与后续使用)与[部署](deploy.md)。

## 升级到 v1.11.0

先备份业务库并保留 Redis 与 `APP_SECRET`，在已有数据库执行迁移和种子，不能用重置替代升级。首次升级到带恢复检查点的版本前，应先暂停新任务，让旧任务完成；不能完成的先人工核对业务结果和上游费用，再停止全部旧 worker、迁移并启动新版。旧版从未保存的回复片段与调用起点无法事后恢复。后续升级也不能混跑旧 worker，或直接回退到不理解恢复闸的代码。

模型须先配置普通输入、输出、缓存读取与缓存写入的积分费率。每轮、用户每日、租户每日预算均按积分，`0` 表示不限额；旧 Token 预算不会换算成积分。历史缺失字段保留未知，当次费率快照不随调价改变，有限预算会阻止未知消费继续累积。在途请求可能越过预算阈值。

断线后按持久回执核对发送是否已接收，明确重试沿用原标识；连接恢复只补拉已保存内容，不自动重发消息。恢复的是会话和任务状态，不能续传原模型 Token 连接，当前步骤可能重新生成。浏览器只保存按本人和租户隔离的投递标识，不存正文，整页刷新不能恢复未发送草稿。写入或图片生成结果未知时，先核对实际结束、效果和费用，再由本人解除后续操作暂停；旧轮次和排队消息不重放，关联自动化需重新配置和授权。

当前公开版本仅含基础 OA 申请与现有审批引擎。v1.10.0 已发布的原生考勤与 OA 助手代申请属于历史版本，当前公开组合不再包含对应运行代码。升级会停用旧入口、授权与保留任务，保留已有业务数据和迁移执行历史；已使用这些功能的项目须核对自己的源码和迁移依赖，保留旧标签及备份，不要直接删表、重置或手动删迁移执行记录。

## 1. 哪些文件属于谁

升级时冲突少不少，取决于项目改了多少模板的文件。项目代码和登记尽量只写项目自己的文件：

| 归属     | 文件                                                                                                                                                                                                                                                                                    |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 项目     | 项目域目录：`apps/server/src/modules/<域>/`、`apps/web/src/views/<域>/`、`apps/web/src/api/<域>/`、`packages/shared/src/<域>/`；`apps/server/src/modules/project.module.ts`；`apps/server/src/db/seeds/project/*`；`apps/server/src/db/project-tables.ts`；项目自己的迁移；`.env*` 配置 |
| 模板     | `apps/server/src/core/`、`modules/platform/`、`modules/workflow/`；`apps/web/src/core/`、`views/platform/`、`views/workflow/`；`packages/shared` 的平台与公共部分；`apps/server/src/core/db/tenant-tables.ts`；模板发布过的迁移；`scripts/`；模板的测试与文档                           |
| 两边都改 | 语言包 JSON（`apps/web/src/locales/*`、`packages/shared/src/i18n/*`、`apps/server/src/i18n/*`）、`apps/server/src/db/seeds/index.ts`（`SEEDS.project` 的登记）、根目录与各包的 `package.json`、`pnpm-lock.yaml`                                                                         |

模板里的 `biz`、`demo` 是示例项目域，可以修改或删除；删改过的示例在升级时按项目文件处理。项目确实需要改模板文件时，改动尽量小而集中，并在提交说明里写清原因，升级时更容易认出来。

## 2. 取得模板的新版本

模板的公开仓库是 `https://github.com/732124645/qiwu-vue-admin`，每个版本有一个标签（如 `v1.4.0`）。在项目仓库里加一次远端，之后每次升级只需取标签：

```sh
git remote add upstream https://github.com/732124645/qiwu-vue-admin.git
git fetch upstream --tags
git tag --list 'v*' --sort=-v:refname | head
```

先在新分支上合并，确认无误再并回主分支：

```sh
git switch -c upgrade-v1.4.0
git merge v1.4.0
```

只关心模板的提交、想要线性历史时，也可以把项目的提交变基到新标签上（`git rebase v1.4.0`）；已推送、多人共用的分支用合并，不要变基。合并前读一遍模板的 `CHANGELOG.md`，留意不兼容的变更与新的环境开关。

## 3. 常见冲突与处理

- **`project.module.ts`、`seeds/project/*`、`project-tables.ts`**：这些是项目文件，模板只在示例需要时才改。冲突时保留项目的登记，再按模板这一侧的改动（如新增的示例模块）决定要不要一起保留。
- **`apps/server/src/db/seeds/index.ts`**：模板会在这里增加平台种子；项目只在 `SEEDS.project` 里登记自己的种子。两边的条目都保留，顺序以模板的注释为准。
- **语言包 JSON**：两边各自新增的键都保留，注意 JSON 的逗号与括号；同一个键两边都改过时，以项目的文案为准。合并后运行 `pnpm i18n:check`，它会报出只在一种语言里有的键。
- **菜单**：项目的菜单分组在 `seeds/project/menu-groups.seed.ts`，模板的菜单在各平台模块的种子里，一般不会冲突；两边都改过的菜单种子按上面语言包的办法逐条保留。
- **迁移**：迁移文件各自独立，通常不冲突。模板发布过的迁移不要修改或改名（已安装的数据库按名字记录它）。项目迁移与模板迁移时间戳相同时，`pnpm verify` 的架构检查会报出这两个文件：改项目自己的迁移（文件名与类名换成当前时间）。如果那个项目迁移已经在某些库上执行过，还要在这些库上把记录改成新名字，例如 `UPDATE meta_migrations SET name = 'CrmOrder20261020153817', timestamp = 261020153817 WHERE name = 'CrmOrder20261018100000'`（`timestamp` 是类名末尾 13 位数字的数值）。
- **执行顺序**：已有的库只执行尚未执行的迁移，按时间戳先后；时间戳早于项目迁移的模板新迁移，会在这次升级时排在后面执行。模板迁移不依赖项目的表；项目迁移若要用到模板新版本改过的表结构，它的时间戳必须晚于对应的模板迁移。
- **`package.json` 与 `pnpm-lock.yaml`**：先按两边的依赖合并 `package.json`，锁文件不要手工合并，取模板一侧后执行 `pnpm i` 重新生成；项目新增的依赖同样要在 `pnpm-workspace.yaml` 的 `allowBuilds` 里登记需要构建脚本的包。
- **项目地图 `docs/ai/project-map.md`**：它由 `pnpm ai:map` 从源码生成，不要手工解决其中的冲突。先解决其他文件，再运行 `pnpm ai:map` 重新生成并提交；没有冲突时合并后也运行一次，因为模板与项目两边的改动都会让它过期（`pnpm verify` 会检查它与源码是否一致）。
- **模板的测试**：迁移测试从迁移目录读取清单、按规则检查每张表，项目不需要改模板的测试。项目改过的模板测试如有冲突，优先采用模板的新版本，再补回项目确实需要的断言。

## 4. 合并后的检查

```sh
pnpm i
pnpm --filter @qiwu/shared build
pnpm ai:map
pnpm verify
pnpm --filter @qiwu/server build
pnpm --filter @qiwu/server test
pnpm ci:local
```

本地反复调试服务端测试时可以用快速模式（`QW_TEST_REUSE_DB=1`，见[入门指南的服务端测试](getting-started.md#服务端测试)），但升级的结论以完整重建测试库的运行为准：部署前完整跑一次 `pnpm ci:local`（Windows 用 `pnpm.cmd ci:local --serial`）。开发库用 `pnpm db:migrate` 与 `pnpm db:seed` 升级，不要对已有的库执行 `pnpm db:reset`。生产环境先备份数据库，再按[部署](deploy.md)的步骤执行迁移与种子。

新版本带来的可选模块由启动开关控制，默认关闭，例如公众号（`APP_WXOA`）与智能体接入（`APP_MCP`）：升级后它们保持关闭，表照常由迁移创建；需要时在 `.env` 里打开开关并重启全部实例，用法见各模块的文档。
