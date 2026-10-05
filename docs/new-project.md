# 从模板创建新项目

从本地模板建立独立目录，使用新 MySQL 库与空闲 Redis db，保留内部 `@qiwu/*` 包名和原创生成模板。运行环境、账号与 ACL 准备见 [入门指南](getting-started.md)。本文的 clone 和启动命令由使用者人工执行。

## 1. 克隆到新目录

替换下列本地路径，在目标父目录执行：

```sh
git clone --origin template /absolute/path/to/qiwu-vue-admin my-admin
cd my-admin
```

`template` 指向自己的本地模板路径，用于以后比较模板更新；本步骤不添加网络远端或推送。clone 只复制已提交内容，不包含模板的 `.env`、`.env.local`、依赖或运行数据。不要把原模板凭据文件直接当作新安装密钥。

## 2. 预览配置计划

新项目脚本只使用 Node 标准库，只配置以下四个文件，不修改 package scope、表前缀、业务模板或 mobile：

| 文件                        | 脚本写入                                                |
| --------------------------- | ------------------------------------------------------- |
| `apps/server/.env`          | `DB_NAME`、`REDIS_DB`；不存在时从 `.env.example` 准备   |
| `apps/server/.env.local`    | 缺失的 `APP_SECRET`、`SEED_ADMIN_PASSWORD`，限制为 0600 |
| `apps/web/.env.development` | `VITE_APP_TITLE`                                        |
| `apps/web/.env.production`  | `VITE_APP_TITLE`                                        |

```sh
node scripts/new-project.mjs --help
node scripts/new-project.mjs --dry-run --name my-admin
```

`--dry-run` **零写入**，不生成或显示秘密值；可省略 `--redis-db`，此时仅显示「待提供」，不会回落到模板 db 13。它会报告已有配置的写入阻塞，例如凭据误写在 `.env`；没有执行真实配置或基础设施操作。

## 3. 交互或 CLI 配置

终端交互方式：

```sh
node scripts/new-project.mjs
```

按提示输入项目 slug、空闲 Redis 库号、数据库名和显示标题。数据库名与标题可按 Enter 使用默认值；每次输入等待最多 60 秒，EOF / 超时会结束，不写入。非交互执行必须提供 `--name` 和 `--redis-db`。

CLI 示例中的 **db 0 只是候选**：由使用者先确认它未被本机其他项目使用，并在 Redis 的 `databases` 范围内，再执行；不空闲就换一个合法库号。

先通过自己的秘密管理方式将 Redis 密码注入当前终端的 `REDISCLI_AUTH` 环境变量，不使用 `-a` 或把密码写进命令行。以下以 ACL 用户 `qiwu`、候选 db 0 为例；主机、端口、用户与库号按实际环境替换：

```sh
redis-cli --user qiwu -n 0 --scan --pattern 'qw:*' | head
redis-cli --user qiwu -n 0 DBSIZE
unset REDISCLI_AUTH
```

扫描出现任何 `qw:*` 键就换库号；`DBSIZE` 返回该库所有命名空间的键数，预期空库为 0。若应用 ACL 不允许 `DBSIZE`，请由有权限的管理员查询。空扫描只说明当前没有匹配键，还须确认没有其他项目正在使用或已预留该库号；认证失败或权限错误不能当作空闲。

```sh
node scripts/new-project.mjs --dry-run --name my-admin --db-name my_admin_dev --redis-db 0 --title '我的后台'
node scripts/new-project.mjs --name my-admin --db-name my_admin_dev --redis-db 0 --title '我的后台'
```

| 参数            | 当前契约                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `--name`        | 1–63 字符、小写字母开头的 slug，仅小写字母、数字和 `-`                                                                         |
| `--db-name`     | 默认将 slug 的 `-` 换为 `_` 后加 `_dev`；1–64 字符、小写字母开头，仅小写字母、数字与 `_`，必须以 `_dev` 结尾，拒绝 `qiwu_dev`  |
| `--redis-db`    | 非负十进制安全整数；拒绝模板开发与测试使用的库号（9、13、14、15，`--help` 打印当前保留清单），不验证服务端实际配置或是否被占用 |
| `--title`       | 默认项目 slug，1–128 字符；拒绝 CR / LF / NUL 和 `$ < > & "`；用于 HTML、浏览器、侧栏与登录页标题                              |
| `--dry-run`     | 只读预览；缺少 Redis 库号时保留待确认状态                                                                                      |
| `--self-test`   | 临时目录中的脚本自检，不连接数据库 / Redis 或修改当前项目                                                                      |
| `--help` / `-h` | 显示用法                                                                                                                       |

不设置 `VITE_APP_TITLE` 时，HTML 使用中文默认标题；浏览器、侧栏、登录页品牌跟随界面语言。标题文件是非秘密配置，可提交。脚本不修改根 `package.json` 的项目名；业务标识及项目域按 [代码生成指南](codegen.md) 设置，无需重命名 `@qiwu/*`。

## 4. 密钥与重复运行

缺失的 `APP_SECRET` 与管理员密码会用安全随机数生成并保存到 `.env.local`，**不回显**。管理员用户名为 `admin`，密码在本项目的 `.env.local` 中安全查看；不要把文件内容贴到聊天、日志或版本库。

也可通过进程环境 `NEW_PROJECT_APP_SECRET` / `NEW_PROJECT_ADMIN_PASSWORD` 提供值，使用自己的秘密管理方式注入，不将秘密写进可分享的命令历史。已有非空合法值优先保留，新的环境输入不会覆盖它们。脚本拒绝含 `not-for-production` 标记的已有密钥，须手动替换；不会静默轮换密钥。`APP_SECRET` 至少 32 字符；管理员密码按默认策略检查：至少 8 字符、至少两类字符、UTF-8 不超过 72 字节，实际运行时仍受 `cfg_param` 的密码策略约束。

脚本保留其他配置和已有 DB / Redis 凭据；若 `.env` 定义任何凭据键（即便为空），先手动迁至 `.env.local`。相同参数重复执行保留已有密钥；文件写入失败会尝试回滚。进程或断电中断不能保证四文件原子提交，恢复后检查文件再重跑；若提示保留 `.new-project-*.backup`，先手动恢复备份。

## 5. 人工创建基础设施并启动

脚本只打印后续步骤，**不建库、不配置 ACL、不 reset、不执行 git 操作或启动服务**。由使用者确认新库名、Redis 库号和账号授权，创建空 MySQL 库；Redis ACL 保持键 `qw:*`、频道 `qw:*` 的范围。检查 `.env` 的主机、端口、库名，并在新项目的 `apps/server/.env.local` 中补充 `DB_USER`、`DB_PASSWORD`、`REDIS_USERNAME`、`REDIS_PASSWORD`，使用本机应用账号的凭据。脚本只生成缺失的 `APP_SECRET` / `SEED_ADMIN_PASSWORD`，不会生成 DB / Redis 凭据；首次迁移前必须完成配置。

由 MySQL 管理员为新项目建库，并将应用账号授权到**新的数据库名**，例如：

```sql
CREATE DATABASE my_admin_dev CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
GRANT ALL PRIVILEGES ON my_admin_dev.* TO 'qiwu'@'localhost';
```

库名替换为脚本配置的 `DB_NAME`，授权账号及其 host 替换为实际应用账号；已有账号仅获授权 `qiwu_%` 时，并不覆盖 `my_admin_dev`，须由管理员补授权。Redis 库号按第 3 节用 `SCAN` 与 `DBSIZE` 确认空闲，ACL 保持 `qw:*` 范围。

```sh
pnpm i
pnpm --filter @qiwu/shared build
pnpm db:migrate
pnpm db:seed
pnpm dev
```

先 migrate 再 seed；`pnpm dev` 在使用者终端交互运行，打开 Web 后使用 `admin` 与本项目保存的密码登录。不要对已有模板库 `qiwu_dev` 执行裸 `pnpm db:reset`。生产安装使用独立环境、数据库与密钥，见 [部署](deploy.md)；PC-only 裁剪见 [移动端](mobile.md#只要-pc删除移动端)。

首次开发登录默认会显示滑块验证码，模式由参数 `captcha.mode` 控制。`pnpm db:seed` 只在新建时打印新用户初始密码（包括 OA 演示用户）；重跑不会再次显示，须当场安全保存，绝不要粘贴到聊天、工单、日志或版本库。脚本预设的 `admin` 密码仍在本项目的 `.env.local` 中安全查看。

### 与模板同时运行

脚本不会改变后端 / Web 端口。同机已有模板服务时，在 `apps/server/.env` 设置空闲的 `PORT`（以下示例为 `3310`），并设置 `CORS_ORIGIN=http://localhost:5190`，与新 Vite 页面的实际 origin 一致。根目录 `pnpm dev` 实际执行 `pnpm -r --parallel dev`；不能用 `pnpm dev --port 5190`，否则参数也会传给 shared 的 `tsc -w` 并导致启动失败。

完成上述 install、shared build、migrate、seed 后，在第一个终端运行 shared 与后端：

```sh
API_PROXY_TARGET=http://127.0.0.1:3310 pnpm --filter @qiwu/shared --filter @qiwu/server --parallel dev
```

在第二个终端进入同一新项目目录，运行 Web：

```sh
API_PROXY_TARGET=http://127.0.0.1:3310 pnpm --filter @qiwu/web dev --port 5190 --strictPort
```

`API_PROXY_TARGET` 是 **Vite 进程的环境变量**，不是 `.env` 配置键；终端之间不会共享它，因此第二个终端也必须赋值。将 `3310` / `5190` 换成自己的空闲后端 / Vite 端口，打开 `http://localhost:5190`；两个终端均由用户交互运行并用 Ctrl+C 停止。

## Windows（原生 PowerShell 5.1）

Windows 开发与完整本地检查的环境要求见[入门指南](getting-started.md#windows原生-powershell-51)。准备 MySQL 与 Redis ≥ 7 服务；本文其余 shell 块面向 macOS / POSIX。

下列手敲命令使用 `pnpm.cmd`，避开 PowerShell 的 `.ps1` 执行策略，不修改执行策略。`pnpm.cmd` 仅随 npm / Corepack 安装提供；独立安装的 `pnpm.exe`（如 winget / get.pnpm.io）请把示例中的 `pnpm.cmd` 换成 `pnpm`。 脚本打印的通用 `pnpm` 后续步骤也遵循此规则。用编辑器保存 UTF-8 / LF 的环境文件；脚本的 0600 模式不能替代 Windows ACL，秘密文件仍由用户限制访问。

替换本地模板路径与目标目录；使用仓库的 LF 检出配置：

```powershell
git clone -c core.autocrlf=true -c core.symlinks=false --origin template "C:/templates/qiwu-vue-admin" "C:/projects/my-admin"
if ($LASTEXITCODE -ne 0) { throw "Clone failed" }
Set-Location "C:/projects/my-admin"
node scripts/new-project.mjs --dry-run --name my-admin --db-name my_admin_dev --redis-db 0 --title '我的后台'
if ($LASTEXITCODE -ne 0) { throw "Preview failed" }
node scripts/new-project.mjs --name my-admin --db-name my_admin_dev --redis-db 0 --title '我的后台'
if ($LASTEXITCODE -ne 0) { throw "Configuration failed" }
```

db 0 仍须先确认空闲且在 Redis 服务范围内；脚本不建库、不改 ACL、不 reset、不启动服务。交互式输入也可直接用 `node scripts/new-project.mjs`，参数与校验规则同上。完成第 5 节的人工建库、账号授权与 `.env.local` 凭据后执行：

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

先 migrate 再 seed，dev 由用户交互启动并用 Ctrl+C 停止。脚本自检为 `node scripts/new-project.mjs --self-test`，只用临时夹具；真实配置、回滚与登录还应在目标环境检查。

与模板同时运行时，先按第 5 节将 `apps/server/.env` 的 `PORT` 设为 `3310`、`CORS_ORIGIN` 设为 `http://localhost:5190`，用下面两个终端命令代替上面的 `pnpm.cmd dev`。示例在 `API_PROXY_TARGET` 原先未设置的终端运行；已有值时先保存，结束后恢复原值。

第一个终端（shared 与后端）：

```powershell
$env:API_PROXY_TARGET = 'http://127.0.0.1:3310'
try {
  pnpm.cmd --filter @qiwu/shared --filter @qiwu/server --parallel dev
} finally {
  Remove-Item Env:API_PROXY_TARGET -ErrorAction SilentlyContinue
}
```

第二个终端进入同一新项目目录（Web；必须再次设置 Vite 进程环境变量）：

```powershell
$env:API_PROXY_TARGET = 'http://127.0.0.1:3310'
try {
  pnpm.cmd --filter @qiwu/web dev --port 5190 --strictPort
} finally {
  Remove-Item Env:API_PROXY_TARGET -ErrorAction SilentlyContinue
}
```

打开 `http://localhost:5190`，两个终端都用 Ctrl+C 停止；`finally` 清除各终端的环境变量。`API_PROXY_TARGET` 不写入 `.env`。

## 6. 首次登录耗时

在已预热依赖缓存的机器上，新项目从 clone 到首次登录通常远少于 10 分钟。

冷安装需要另外计入依赖下载与服务准备时间；网络、硬件及基础设施配置会影响总耗时。
