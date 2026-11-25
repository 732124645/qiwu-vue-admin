# 升级模板版本

从本模板建立的项目，怎样合并模板发布的新版本。新项目的建立见[从模板创建新项目](new-project.md)；已有安装的数据库升级（migrate → seed）见[入门指南](getting-started.md#5-检查与后续使用)与[部署](deploy.md)。

## 升级到 v1.17.0

内置智能助手已整体移除：`APP_AGENT` 开关、`/api/agent/*` 接口、智能体菜单组及其页面、助手种子与对应文档、配方和技能都不再提供。MCP 接入（`APP_MCP`）保留，外部客户端的接口、护栏和各模块工具不变。`v1.8.0` 至 `v1.16.0` 已从公开仓库撤回，其中与助手无关的变化都包含在本版本中，从 `v1.7.1` 升级时下面各版本小节同样适用。

先执行迁移与种子，再重启全部实例：新代码不再按 `APP_AGENT` 隐藏旧菜单，迁移完成前有授权的用户会看到一个打不开的智能体分组。迁移 `20261125040531-agent-retire` 只在装过助手的数据库上起作用：软删助手的菜单、这些菜单的角色授权与租户套餐授权、`agent.*` 系统参数，以及助手的站内信和邮件模板。助手的数据表与历史数据全部保留，不会删表；确认项目自己没有读取这些表并做好备份后，才可以自行处理。

`.env` 里的 `APP_AGENT` 可以删掉；留着也会被忽略（启动时的环境变量校验会丢弃未知键，不报错）。

旧版本留在 Redis 里的助手数据不影响运行，可按需清理：BullMQ 队列 `agent-turn`、`agent-cleanup`、`agent-automation`、`agent-memory`（键为 `qw:queue:<队列名>:*`，含其重复任务），以及 `qw:agent:*` 与 `qw:lock:agent-*` 键。先停掉全部旧版本实例，再用 `SCAN` + `UNLINK` 删除，不要用 `KEYS` 或 `FLUSHDB`（共用的 Redis 里还有别的数据）。下面的 `-n` 换成部署的 `REDIS_DB`，`qw:` 换成实际的 `REDIS_KEY_PREFIX`，按需补上 `-h` / `-p`：

```sh
export REDISCLI_AUTH='<Redis 密码>'
for p in 'qw:queue:agent-turn:*' 'qw:queue:agent-cleanup:*' 'qw:queue:agent-automation:*' \
  'qw:queue:agent-memory:*' 'qw:agent:*' 'qw:lock:agent-*'; do
  redis-cli --user qiwu -n 13 --scan --pattern "$p" | xargs -r -n 100 redis-cli --user qiwu -n 13 UNLINK
done
```

项目代码用到下列已删除的接口时，按下面改：

- `@McpTool` 不再接受 `preview`、`highRisk`、`perCallConfirmation`、`confirmationRevision`，`MCP_CONFIRMATION_REVISION` 与 `ToolExecutionContext` 也已删除，工具方法只收到校验后的入参。写工具的预览和逐次本人确认随助手一起移除：删掉这些选项和对应的预览方法即可，MCP 写工具照常受令牌的写权限、工具权限、数据权限与操作日志约束。`@AgentBatchTarget` 及其 `batchLabels` 一并删除。
- 本人收件箱接口的条目不再有 `action` 字段，前端按普通文本通知展示。
- B8xxx 错误码（`Err.AGENT_*`）已删除，引用处改用项目自己的错误码。
- core 中删除了 `AuditWriter.onAction`（及 `ActionHeard`）、`ParamService.onInvalidate`、`maskSecrets`、`StorageService.putAgentImage`（及 `AGENT_IMAGE_TAG`）和 `CACHE_NAMESPACES` 的 `agent*` 项：需要在操作或参数变化后做事的，在项目自己的服务里显式调用；需要文本脱敏的，用 `core/redact.ts` 里仍保留的函数或项目自己的实现。
- `@qiwu/shared` 不再导出助手的 schema（`platform/agent/*`）、`DEMO_CUSTOMER_TARGET` / `DEMO_CUSTOMER_ENRICH_SKILL` 与实时事件 `RT.agentEvent`；`BUILTIN_MENU_GROUPS` 不再含 `agent`，`PLATFORM_ONLY_ROUTES` 不再含 `agent-setting`。
- 服务端去掉了依赖 `openai`，Web 去掉了 `marked`。项目直接用到它们时，在自己的 `package.json` 里加上（注意 `allowBuilds` 登记）。

## 员工聊天与媒体源码升级

从旧公开版本升级时，先备份并执行迁移、种子，再启用 `APP_IM`；多租户套餐需要包含聊天分组。语音消息不依赖 LiveKit，前台通话还需按 [LiveKit 指南](livekit.md)配置服务端地址和凭据并打开 `im.call.enabled`。密钥只保存在应用服务器，不能进入前端环境变量或安装包。

App 必须重新构建原生整包或自定义基座，包含 SQLite、Record 与 `qw-livekit` 插件，并配置可访问的 API 地址、平台标识及签名；旧包仅更新 wgt 无法增加这些原生能力。本版本不提供签名安装包。Android 传递依赖的再分发许可仍待澄清；真实服务和目标设备媒体尚未验收，详见[聊天使用前提](im.md#当前交付与使用前提)。

## 升级到 v1.15.0

照常执行迁移与种子。新迁移给任务日志加两个可空列：`instance`（执行实例）与 `loop_max_ms`（执行期间事件循环最大延迟），另给一张已退役功能的表加一个可空列。旧记录保持空值。

新增的环境变量都有不改变原行为的默认值：`APP_ROLE`（默认 `all`）、`DB_POOL_SIZE`（默认 10）、`DB_POOL_ACQUIRE_TIMEOUT_MS` / `DB_POOL_QUEUE_LIMIT`（默认 0 不限）、`LOG_SLOW_REQUEST_MS` / `LOG_EVENT_LOOP_INTERVAL_MS` / `LOG_EVENT_LOOP_WARN_MS`（默认 0 关闭）。默认 `all` 角色多一个空闲的 `scheduler-run` 队列（任务队列监控页能看到），用于把 api 进程上的“执行一次”交给 worker。

启动日志多两类内容：`.env` 与 `.env.local` 同一个键写了不同值时的一条警告（只列键名），以及 `listen` 后一行 `effective config: …`。项目自己的非秘密键可以追加到 `EFFECTIVE_CONFIG_KEYS`。

要把后台任务拆到单独进程时，按[部署 · 使用 PM2 部署](deploy.md)设置 `QW_PM2_WORKER_INSTANCES`；第一次开启和切回单个应用都要先 `pm2 delete` 再启动，因为 PM2 会沿用进程原来的环境变量。至少保留一个 `all` 或 `worker` 实例，否则定时任务和队列都会停。

## 升级到 v1.14.0

照常执行迁移与种子。新迁移只建一张已退役功能使用的表，不影响其他模块。

## 升级到 v1.13.0

照常执行迁移与种子，没有需要另外处理的变化。

## 升级到 v1.12.0

没有新迁移，照常执行迁移与种子即可。开发服务改为编译到独立的 `dist-dev/` 目录，由旧模板派生的项目要把它加入 `.gitignore`。

## 升级到 v1.11.0

先备份业务库并保留 Redis 与 `APP_SECRET`，在已有数据库执行迁移和种子，不能用重置替代升级。

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

新版本带来的可选模块由启动开关控制，默认关闭，例如公众号（`APP_WXOA`）、MCP 接入（`APP_MCP`）与员工即时通讯（`APP_IM`）：升级后它们保持关闭，表照常由迁移创建；需要时在 `.env` 里打开开关并重启全部实例，用法见各模块的文档。

员工聊天增加语音附件和两张通话表，先备份并执行全部迁移，再启动新版；语音沿用现有私有附件与发件箱。新通话默认关闭，须另配置 LiveKit 并打开 `im.call.enabled`，见 [LiveKit](livekit.md)。部署 Web 时同步完整 CSP 的 WSS 与 media-src；移动 App 须重新原生构建，不能仅发 wgt。关闭聊天或新通话后维护模块仍清理存量，删除 LiveKit 控制凭据前须完成 drain，不得将未知媒体创建直接改成已结束。
