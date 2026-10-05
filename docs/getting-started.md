# 入门指南

本文用于本地模板开发。独立业务项目先看 [从模板创建新项目](new-project.md)，部署到服务器见 [部署](deploy.md)。下列 shell 示例面向 macOS / POSIX 终端；Windows 示例见文末。

## 1. 准备运行环境

- 使用 Node **22，≥ 22.22.1** 与 pnpm **11.28.3**，与 `.nvmrc` 和根 `package.json` 的 `packageManager` 一致。
- MySQL 与 Redis；Socket.IO 分片适配器要求 **Redis ≥ 7**。macOS 本地使用 Homebrew 服务；已有服务可直接使用，不要重复启动或重置。
- 本地模板仓库，默认 Web 地址 `http://localhost:5173`；API 绑定 `127.0.0.1:3000`，由 Vite 代理访问。

```sh
node --version
npm install -g pnpm@11.28.3
pnpm --version
```

尚未安装 MySQL / Redis 的 macOS 使用者，可由本机管理员执行：

```sh
brew install mysql redis
brew services start mysql
brew services start redis
```

服务的账号、密码与持久配置由部署者管理。项目不会自动创建数据库或 Redis ACL 用户。

## 2. 空库、账号与隔离

由 MySQL 管理员建立以下**独立空库**，编码 `utf8mb4`，给应用账号 `qiwu` 授予这些库内的读写和迁移所需 DDL 权限；不要授予全局管理权限。应用连接配置的 `DB_HOST` 与账号允许连接的主机须对应。生产和新项目另外建库，不沿用模板库。

| 用途                                | MySQL 库          | Redis db | 后端端口 | Web / H5 端口 |
| ----------------------------------- | ----------------- | -------- | -------- | ------------- |
| 模板开发                            | `qiwu_dev`        | 13       | 3000     | 5173          |
| 服务端测试                          | `qiwu_test`       | 15       | 3100     | —             |
| Web Playwright                      | `qiwu_e2e`        | 14       | 3200     | 4173          |
| 移动端 Playwright（保留 mobile 时） | `qiwu_mobile_e2e` | 9        | 3201     | 4175          |

Redis 的配置须提供这些数据库号。已有满足隔离要求的 `qiwu` ACL 用户可复用；首次安装由管理员在**持久 ACL 配置**中建立该用户，键仅允许 `~qw:*`、频道仅允许 `&qw:*`，不允许 `FLUSHDB`、`KEYS`、`CONFIG` 等管理或危险命令。业务需要普通读写、过期、事务、`SCAN` / `UNLINK`、Lua 等命令；分片适配器还需要 `SSUBSCRIBE`、`SPUBLISH`、`PUBSUB SHARDNUMSUB`，共享限流需要 `EVAL`、`TIME` 及 ZSET / hash 命令。测试用的 ACL 用户还需要只读 `INFO` 权限（`monitor.e2e` 读取 Redis 监控信息），由管理员审核并加入持久 ACL；这不放开 `FLUSHDB` / `KEYS` / `CONFIG`。其余监控所需的只读权限由管理员单独审核。参考 [Redis ACL 官方说明](https://redis.io/docs/latest/operate/oss_and_stack/management/security/acl/) 与 [多实例部署前置条件](scale-out.md)，不要给应用账号 `+@all` 或用它修改 ACL。

所有键通过 `apps/server/src/core/redis/cache-namespaces.ts` 构造，保持 `REDIS_KEY_PREFIX=qw:`。不同部署必须选择不同的空闲 Redis db；Pub/Sub 频道还包含库号。同库同前缀会共用会话、缓存、限流与推送。演示环境不得占用上述测试库与 Redis db，不要凭端口空闲判断数据库可用。

## 3. 配置与凭据

在仓库根执行：

```sh
cp apps/server/.env.example apps/server/.env
```

编辑 `apps/server/.env` 的非秘密配置：`DB_HOST`、`DB_PORT`、`DB_NAME`、`REDIS_HOST`、`REDIS_PORT`、`REDIS_DB`、`PORT` 等。默认是上表的模板开发配置。已有 `.env` 时先核对内容，不直接覆盖。

另建 git 忽略的 `apps/server/.env.local`，以下值须自行替换；这里没有可直接使用的密码：

```dotenv
DB_USER=qiwu
DB_PASSWORD='<本机 MySQL 应用账号密码>'
REDIS_USERNAME=qiwu
REDIS_PASSWORD='<本机 Redis ACL 密码>'
APP_SECRET='<至少 32 字符的独立随机密钥>'
# 可选；不设置时首次 seed 生成管理员密码
# SEED_ADMIN_PASSWORD='<满足密码策略的管理员密码>'
```

可用 `openssl rand -base64 48` 生成 `APP_SECRET`，只保存到忽略文件或部署密钥系统。在 macOS / Linux 上限制凭据文件访问：

```sh
chmod 600 apps/server/.env.local
```

服务端的优先级为**进程环境 → `ENV_FILE` 指定的文件（默认 `.env`）→ `.env.local`**。`db:*` 命令先加载 `.env.local` 再加载 `.env`，进程环境仍优先。两条路径下，`.env` 中定义的键都会盖住 `.env.local`，**空值 `KEY=` 也会遮住凭据**；因此 DB / Redis 账号密码、`APP_SECRET`、`SEED_ADMIN_PASSWORD`、`WX_MP_APPID` / `WX_MP_SECRET` 只写 `.env.local`，不在 `.env` 写空占位。

`.env.example` 的 `SWAGGER_ENABLED=true` 用于开发；schema 的缺省值是 `false`。`APP_DEMO_MODE=false`、`ALLOW_PRIVATE_ENDPOINTS=false` 是正常安装的设置。微信凭据只在需要该功能时配置，详见 [移动端](mobile.md)。`VITE_*` 会进入浏览器，严禁保存任何密钥；Web 可在 `apps/web/.env.development` / `.env.production` 设置非秘密的 `VITE_APP_TITLE`，API 请求固定走同源 `/api`。

## 4. 安装、迁移、种子与登录

确认配置指向自己的空库与开发 Redis db 后，在仓库根按顺序执行：

```sh
pnpm i
pnpm --filter @qiwu/shared build
pnpm db:migrate
pnpm db:seed
```

**先 migrate 再 seed。** 根命令委托 `@qiwu/server`，数据库脚本会先编译后运行 `dist/db/*.js`，工作目录自动是 `apps/server`。不要用 tsx 或 Node 去执行带 Nest 装饰器的源码。安装不得出现 `ERR_PNPM_IGNORED_BUILDS`，遇到它应核对仓库的 `allowBuilds`，不要直接放开所有安装脚本。

首次创建的管理员用户名为 `admin`，密码规则如下（源码：`apps/server/src/db/seeds/iam/iam.seed.ts`）：

| `SEED_ADMIN_PASSWORD`                     | 新建管理员行为                                           |
| ----------------------------------------- | -------------------------------------------------------- |
| 未设置或空字符串                          | 安全随机密码，仅在首次创建时打印一次；正常安装首登须改密 |
| 非空                                      | 使用提供的密码，不打印管理员密码，按已改密状态创建       |
| 未设置或空字符串，且 `APP_DEMO_MODE=true` | 仍随机并仅首次打印，但新建种子管理员免首登改密           |

重跑 seed 不重写已有账号的密码或改密状态。首次输出还可能包含新用户初始密码，妥善保存，不公开 seed 日志；丢失管理员密码时不要靠重跑 seed 期待它再次显示。新项目脚本会预先生成并保存 `SEED_ADMIN_PASSWORD`，该路径从 `.env.local` 安全读取自己的管理员密码，不等待终端回显。

然后由使用者在终端交互启动：

```sh
pnpm dev
```

打开 `http://localhost:5173` 登录；停止开发进程使用该终端的 Ctrl+C。需要修改后端端口时，同时给 Web 的 Vite 进程设置 `API_PROXY_TARGET` 为对应后端地址（`apps/web/vite.config.ts`）；不要为了访问 API 把 Nest 端口开放给局域网。

## 5. 检查与后续使用

```sh
pnpm verify
```

这只执行 lint、架构、类型、i18n、原创性与许可检查，不证明数据库、浏览器或生产部署已验收。完整本地闸门 `pnpm ci:local` 会使用并重置测试库，应先准备表中全部所需测试库；移动端安装与构建步骤见 [移动端](mobile.md)。测试加载器以 `.env.local` 为凭据底层，再叠加 `.env.test` / `.env.e2e`；不要把其中的测试 `APP_SECRET` 或管理员密码复制到正式部署，在 `NODE_ENV=production` 下，服务启动校验以及 `db:seed` / `db:migrate` 都会拒绝 `APP_SECRET` 或 `SEED_ADMIN_PASSWORD` 中的 `not-for-production` 标记（不区分大小写）；两个数据库命令在建立连接、执行写入之前即报错退出，错误不会输出凭据值。

升级已有安装同样使用 migrate → seed；`pnpm db:reset` 会删除目标库所有表和视图再重建，**不是升级步骤**，不要对已有 `qiwu_dev` 执行裸 reset。PC 项目可按 [「只要 PC：删除移动端」](mobile.md#只要-pc删除移动端) 去掉 mobile；新业务代码与生成器使用方式见 [代码生成](codegen.md)。

## Windows（原生 PowerShell 5.1）

已在 Windows 11 + Windows PowerShell 5.1 上验证开发与完整本地闸门。

完整本地闸门使用 `pnpm.cmd ci:local --serial`。没有文件符号链接权限时，相关防护测试会跳过；Windows 服务器部署及 App / 小程序发布尚未验证。无需 WSL / Git Bash。

### 服务、工具与环境文件

- 准备 MySQL 与 Redis **≥ 7** 服务；按第 2 节准备空库、隔离库号、账号和持久 ACL，核对 `SSUBSCRIBE` / `SPUBLISH` / `PUBSUB SHARDNUMSUB` 以及限流需要的命令。
- 使用 Node 22 与固定的 pnpm 版本，并按 Web / mobile 的 Playwright 配置安装所需浏览器。
- 项目路径可含中文或空格。保存 `.env` / `.env.local` 为 UTF-8、LF；用编辑器创建秘密文件，限制 Windows 文件访问权限，不用 PowerShell 5.1 的重定向或 `Set-Content` 生成它们。

下列手敲命令使用 `pnpm.cmd`，避开 PowerShell 的 `.ps1` 执行策略，不修改执行策略。`pnpm.cmd` 仅随 npm / Corepack 安装提供；独立安装的 `pnpm.exe`（如 winget / get.pnpm.io）请把示例中的 `pnpm.cmd` 换成 `pnpm`。

```powershell
$PSVersionTable.PSVersion
node --version
git --version
npm.cmd install -g pnpm@11.28.3
if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }
pnpm.cmd --version
if (-not (Test-Path apps/server/.env)) { Copy-Item apps/server/.env.example apps/server/.env }
```

shell 版本应是 5.1。按第 3 节在编辑器里填写主机、库号和端口；DB / Redis 凭据、`APP_SECRET`、`SEED_ADMIN_PASSWORD` 与微信密钥仅放 `apps/server/.env.local`。`.env` 不得定义秘密键，空值也会遮住 `.env.local`。可用以下 Node 标准库命令生成随机密钥，再只保存到秘密文件（不记录或分享输出）：

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

### 安装与检查

在仓库根逐行执行，每条原生命令后检查 `$LASTEXITCODE`，非零时先停止、记录和修复。后续命令依赖前一步成功，PowerShell 5.1 用显式检查控制顺序：

```powershell
pnpm.cmd i --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw "Install failed" }
pnpm.cmd --filter @qiwu/shared build
if ($LASTEXITCODE -ne 0) { throw "Shared build failed" }
pnpm.cmd db:migrate
if ($LASTEXITCODE -ne 0) { throw "Migration failed" }
pnpm.cmd db:seed
if ($LASTEXITCODE -ne 0) { throw "Seed failed" }
pnpm.cmd verify
if ($LASTEXITCODE -ne 0) { throw "Verify failed" }
```

先 migrate 再 seed，确认目标是自己的安装库。完整产品闸门会重置测试库，须准备第 2 节的隔离测试库；使用 `pnpm.cmd ci:local --serial`。需要严格 i18n 检查时，用进程环境赋值并在结束后清除：

```powershell
$env:I18N_TODO_STRICT='1'
try {
  pnpm.cmd i18n:check
  if ($LASTEXITCODE -ne 0) { throw "Strict i18n check failed" }
} finally {
  Remove-Item Env:I18N_TODO_STRICT
}
```

环境示例在变量原先未设置的终端运行；已有值时先保存，完成后恢复原值。开发服务由用户交互执行 `pnpm.cmd dev`，Ctrl+C 停止。

### 完整本地检查

准备好第 2 节的隔离测试库后运行：

```powershell
pnpm.cmd ci:local --serial
if ($LASTEXITCODE -ne 0) { throw "Local gate failed" }
```

使用 UTF-8 / LF 保存环境文件；项目路径可含中文或空格。没有文件符号链接权限时，跳过相关测试的结果不能视为该防护已在当前机器验证。

### cmd 入口

用 `cmd.exe /d /v:off` 打开终端（不执行 AutoRun，关闭延迟展开，避免 `!` 被改写），在仓库根按顺序运行安装、共享包构建、迁移、种子与检查命令，每步用 `echo %ERRORLEVEL%` 检查结果，非零即停止。环境变量用 `set "VAR=..."` 赋值、`set "VAR="` 清除，引号包住整个赋值，避免尾随空格进入值。每个 pnpm 调用写成 `call pnpm.cmd ...`：手敲时效果相同，写入 `.bat` / `.cmd` 文件时控制流才会返回批处理文件，后续步骤才会执行。秘密文件用编辑器保存并限制访问。

```cmd
cd /d C:\path\to\qiwu-vue-admin
call pnpm.cmd i --frozen-lockfile
echo %ERRORLEVEL%
call pnpm.cmd --filter @qiwu/shared build
echo %ERRORLEVEL%
call pnpm.cmd db:migrate
echo %ERRORLEVEL%
call pnpm.cmd db:seed
echo %ERRORLEVEL%
call pnpm.cmd verify
echo %ERRORLEVEL%
set "CSP_CONNECT_SRC=https://files.example.com"
call pnpm.cmd --filter @qiwu/web build
echo %ERRORLEVEL%
set "CSP_CONNECT_SRC="
```

`CSP_CONNECT_SRC` 只是示例变量，含义见 [部署](deploy.md)；不用 S3 直传时省略最后四行。
