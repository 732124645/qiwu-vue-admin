# 栖梧 / Qiwu — qiwu-vue-admin

[中文](#中文) · [English](#english)

## 中文

栖梧是一个 MIT 许可的管理后台模板，采用 NestJS 12、Vue 3.5、Element Plus、TypeScript、MySQL 和 Redis，使用 pnpm workspace 管理服务端、Web 与共享契约。品牌为「栖梧 / Qiwu」，项目名为 `qiwu-vue-admin`，内部包名为 `@qiwu/*`。

当前实现包括：

- 用户、角色、菜单、部门、岗位与五种数据权限范围；会话、个人中心、字典、参数、审计与监控。
- 原创 CRUD、树、主子代码生成模板，Excel 导入导出、本地与 S3 存储、定时任务、站内信、邮件与短信。
- 树形与 BPMN 流程设计、审批中心、业务表单与动态表单，以及 OAuth2 / SSO。
- 中文与英文界面、Socket.IO 推送、Redis 共享限流与多服务实例支持；部署边界见 [多实例部署](docs/scale-out.md)。

v1.0.0 已于 2026-10-05 发布，功能与已知边界见 [CHANGELOG.md](CHANGELOG.md)；这里不宣称生产容量或外部服务已实测。

### 在线演示

- 演示地址：[demo.qiwuadmin.com](https://demo.qiwuadmin.com)
- 账号：`admin`；密码：`admin@123`
- 文档站：[qiwuadmin.com](https://qiwuadmin.com)；源码：[qiwu-vue-admin](https://github.com/732124645/qiwu-vue-admin)
- 版本：`v1.0.0`；许可：[MIT](LICENSE)

演示模式可浏览全部功能，写操作均拒绝并提示「演示模式下不能执行此操作」，访客 IP / UA 已脱敏，登录使用滑块验证码，请勿输入真实个人数据。

```sh
git clone https://github.com/732124645/qiwu-vue-admin.git
```

### 开始使用

使用 Node 22（≥ 22.22.1）与 `package.json` 固定的 pnpm 11.28.3。先按 [入门指南](docs/getting-started.md) 准备 MySQL 空库、Redis ACL 与环境文件，凭据只写 `apps/server/.env.local`，然后在仓库根执行：

```sh
pnpm i
pnpm --filter @qiwu/shared build
pnpm db:migrate
pnpm db:seed
pnpm dev
```

先 migrate 再 seed；`pnpm dev` 由使用者在终端交互启动。管理员账号为 `admin`，密码行为见入门指南。独立业务项目请按 [从模板创建新项目](docs/new-project.md) 使用新目录、新库和空闲 Redis 库号。

### Windows（原生 PowerShell 5.1）

原生 Windows 11 + Windows PowerShell 5.1（含 cmd 入口）已验证用于开发与完整本地闸门（`pnpm ci:local --serial`）；无文件 symlink 权限时，符号链接防护测试跳过；Windows 服务器部署及 App / 小程序发布未验证。 用户须提供已验证的 MySQL 与 Redis ≥ 7 服务，按[入门指南的 Windows 清单](docs/getting-started.md#windows原生-powershell-51)准备独立数据库、ACL、浏览器与 `.env.local` 凭据。

下列手敲命令使用 `pnpm.cmd`，避开 PowerShell 的 `.ps1` 执行策略，不修改执行策略。`pnpm.cmd` 仅随 npm / Corepack 安装提供；独立安装的 `pnpm.exe`（如 winget / get.pnpm.io）请把示例中的 `pnpm.cmd` 换成 `pnpm`。 完成环境准备后，在仓库根逐行执行，每步失败即停止：

```powershell
pnpm.cmd i
if ($LASTEXITCODE -ne 0) { throw "Install failed" }
pnpm.cmd --filter @qiwu/shared build
if ($LASTEXITCODE -ne 0) { throw "Shared build failed" }
pnpm.cmd db:migrate
if ($LASTEXITCODE -ne 0) { throw "Migration failed" }
pnpm.cmd db:seed
if ($LASTEXITCODE -ne 0) { throw "Seed failed" }
pnpm.cmd dev
```

`pnpm.cmd dev` 仅由使用者交互启动，Ctrl+C 停止。Windows 完整产品闸门用 `pnpm.cmd ci:local --serial`。

### 文档与目录

| 入口                                                                 | 内容                                               |
| -------------------------------------------------------------------- | -------------------------------------------------- |
| [设计说明](docs/design-notes.md)                                     | 分层、会话、权限与公共契约                         |
| [部署](docs/deploy.md)                                               | 构建产物、nginx、CSP、文件目录、演示模式与可选 PM2 |
| [代码生成](docs/codegen.md) / [黄金样板](docs/codegen-golden.md)     | 项目域与 CRUD 约定                                 |
| [实时推送](docs/realtime.md) / [多实例部署](docs/scale-out.md)       | 推送、共享状态与扩容前置条件                       |
| [OAuth2](docs/oauth2.md)                                             | 第三方接入与 SSO                                   |
| [BPMN](docs/workflow-bpmn.md) / [流程超时](docs/workflow-timeout.md) | 流程设计与处理边界                                 |
| [移动端](docs/mobile.md)                                             | uni-app 员工客户端与「只要 PC」删除步骤            |

`apps/server` 是后端，`apps/web` 是 Web，`packages/shared` 是共享 schema、类型与 i18n；`mobile/` 是独立于根 workspace 的可选移动端，PC 项目可按移动端文档删除。业务代码放项目域目录，保留 `@qiwu/*` 包 scope，不需要全仓替换模板内部命名。

`pnpm verify` 是静态任务检查；`pnpm ci:local` 是含数据库、构建、测试、Playwright 与冒烟的完整本地闸门，须先准备独立测试库。当前采用本地 git 与构建产物部署，暂不提供 Docker、compose 和远端 CI，相关支持计划中。

### 许可与原创性

项目代码按 [MIT](LICENSE) 发布；代码、模板与种子原创，参考其他后台仅用于功能与架构，不复制实现。第三方资产另见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)：BPMN 设计器所用 `bpmn-js` 有额外的 bpmn.io 标志义务，标志必须保持可见、未遮挡、未修改；移动端和数据资产也须遵守各自许可。PM2 仅作为可选全局运维工具，使用方式见部署文档。

## English

Qiwu is an MIT-licensed admin template built with NestJS 12, Vue 3.5, Element Plus, TypeScript, MySQL and Redis. A pnpm workspace contains the server, Web app and shared contracts. The display brand is **栖梧 / Qiwu**, the project name is `qiwu-vue-admin`, and internal packages use `@qiwu/*`.

Implemented areas include identity and organization management, five data-scope modes, sessions, settings, auditing and monitoring; original CRUD/tree/master-detail generators; Excel, local/S3 storage, scheduling and messaging; workflow designers and approvals; OAuth2/SSO; Chinese/English interfaces; Socket.IO and shared Redis rate limiting. v1.0.0 was released on 2026-10-05. See the [changelog](CHANGELOG.md) and [scale-out boundaries](docs/scale-out.md) for features and limits; this README makes no production capacity or external-service validation claim.

### Live demo

- Demo: [demo.qiwuadmin.com](https://demo.qiwuadmin.com)
- Account: `admin`; password: `admin@123`
- Docs: [qiwuadmin.com](https://qiwuadmin.com); source: [qiwu-vue-admin](https://github.com/732124645/qiwu-vue-admin)
- Version: `v1.0.0`; license: [MIT](LICENSE)

Demo mode lets visitors browse all features but refuses every write with “演示模式下不能执行此操作” (“This operation is not allowed in demo mode”); visitor IP / UA are masked, login uses a slider captcha, and visitors should not enter real personal data.

```sh
git clone https://github.com/732124645/qiwu-vue-admin.git
```

### Getting started

Use Node 22 (≥ 22.22.1) and pnpm 11.28.3, pinned in `package.json`. Follow the [getting-started guide](docs/getting-started.md) to prepare empty MySQL databases, a Redis ACL user and environment files. Store credentials only in the ignored `apps/server/.env.local`, then run from the repository root:

```sh
pnpm i
pnpm --filter @qiwu/shared build
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Run migrations before seeds. Start `pnpm dev` interactively in your terminal. The administrator username is `admin`; the guide explains initial passwords. Use the [new-project guide](docs/new-project.md) for a separate directory, database and unused Redis database number.

### Windows (native PowerShell 5.1)

Native Windows 11 + Windows PowerShell 5.1 (including the cmd entry) is verified for development and the full local gate (`pnpm ci:local --serial`); symlink-protection tests skip without file-symlink privilege; server deployment and App / mini-program publishing on Windows are not verified. Prepare your isolated services and credentials with the [Windows setup](docs/getting-started.md#windows原生-powershell-51).

Use the PowerShell commands in the Chinese Windows section above, in order: install, build shared contracts, migrate, seed, then start development interactively. Check `$LASTEXITCODE` after each native command and stop on failure. `pnpm.cmd` avoids the `.ps1` shim without changing execution policy; it exists only with npm / Corepack installs. With standalone `pnpm.exe` (winget / get.pnpm.io), use plain `pnpm` instead. Store secrets in `apps/server/.env.local`; do not define their keys in `.env`, even as empty values. Use `pnpm.cmd ci:local --serial` for the full Windows product gate.

### Structure and guides

- `apps/server`: NestJS server; `apps/web`: Vue Web app; `packages/shared`: schemas, types and i18n.
- `mobile/`: optional uni-app employee client outside the root workspace. PC-only users can remove it using the [mobile guide](docs/mobile.md). Keep the internal `@qiwu/*` scope; place application code in project-domain directories.
- [Deployment](docs/deploy.md): build output, nginx, CSP, public files, demo mode and optional PM2. [Scale-out](docs/scale-out.md) and [realtime](docs/realtime.md): prerequisites and reliability limits.
- [Design notes](docs/design-notes.md): layering, sessions, permissions and public contracts.
- [Code generation](docs/codegen.md), [golden examples](docs/codegen-golden.md), [OAuth2](docs/oauth2.md), [BPMN](docs/workflow-bpmn.md), and [workflow timeouts](docs/workflow-timeout.md).

`pnpm verify` runs static checks. `pnpm ci:local` runs the full local gate, including database tests, builds, Playwright and bounded smoke checks; prepare isolated test databases first. Deployment currently uses build artifacts and local git. Docker, compose and remote CI support are planned.

### License and originality

Project code is released under [MIT](LICENSE). Implementations, templates and seeds are original; other admin systems are referenced only for features and architecture. Consult [third-party notices](THIRD-PARTY-NOTICES.md) for dependencies and assets. The BPMN designer's `bpmn-js` license additionally requires the bpmn.io logo to remain visible, unobscured and unchanged. PM2 is an optional globally installed operations tool described in the deployment guide.
