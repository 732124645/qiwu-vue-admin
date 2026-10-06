# 部署要点

> 当前交付形态：`pnpm -r build` 产物，server `node dist/main.js`（工作目录 `apps/server`），web 静态 `dist/` 由反向代理托管。Docker、compose 与远端 CI 支持计划中；本文采用主机部署，可选全局 PM2。

## 构建产物与环境

使用 Node 22（≥ 22.22.1）、pnpm 11.28.3、MySQL 与 Redis ≥ 7。下列 POSIX 命令与服务器绝对路径均为部署示例，由部署管理员执行；本地安装见 [入门指南](getting-started.md)。以完整 checkout 部署到 `/srv/qiwu/current` 为例，在仓库根安装并构建：

```sh
pnpm i --frozen-lockfile
pnpm -r build
```

保留 `apps/server/dist/`、`packages/shared/dist/` 和工作区依赖关系，不只复制 `dist/main.js`；服务端 dist 包含 i18n 与 codegen 模板（`apps/server/nest-cli.json`）。前端产物为 `apps/web/dist/`，由 nginx 托管，生产不运行 Vite 开发服务器。数据库、上传目录和凭据独立于可替换的构建产物，并由部署方备份。

在 `apps/server/.env` 写**非秘密**的正式配置，不照搬开发库与测试环境。以下值须换成自己的部署参数：

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=my_admin_prod
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_DB=0
REDIS_KEY_PREFIX=qw:
TRUST_PROXY=127.0.0.1/32
CORS_ORIGIN=https://qiwu.example.com
SWAGGER_ENABLED=false
ALLOW_PRIVATE_ENDPOINTS=false
CODEGEN_WRITE=false
APP_DEMO_MODE=false
STORAGE_LOCAL_ROOT=/srv/qiwu/uploads
LOG_LEVEL=info
```

这里的 Redis db 0 必须先确认空闲且在服务配置范围内；开发、测试与独立演示安装不能共用它。`TRUST_PROXY` 只填实际代理地址；同机代理示例是 `127.0.0.1/32`，跨机部署需替换。Nest 保持 loopback 监听，不向 LAN / 公网开放端口；浏览器走同源 `/api/`，CORS 列表只列实际允许的源。

`DB_USER`、`DB_PASSWORD`、`REDIS_USERNAME`、`REDIS_PASSWORD`、`APP_SECRET`、可选 `SEED_ADMIN_PASSWORD` 与微信密钥只放 git 忽略的 `apps/server/.env.local`，或由部署密钥系统注入进程环境。`.env` 不得定义这些键，连空值也不写；否则会遮住 `.env.local`。`APP_SECRET` 至少 32 个随机字符；同一部署全部实例必须一致，它还用于派生加密密钥，轮换需另做数据与会话处理。不要复制测试密钥；在 `NODE_ENV=production` 下，服务启动校验以及 `db:seed` / `db:migrate` 都拒绝含 `not-for-production`（不区分大小写）的 `APP_SECRET` / `SEED_ADMIN_PASSWORD`；数据库命令在连接或写入之前退出，错误不输出凭据值。任何 `VITE_*` 都不得含秘密。

部署用户必须能读构建产物与凭据，能写 `/srv/qiwu/uploads/public`、`/srv/qiwu/uploads/private` 与受限日志目录；nginx 只读公开目录。凭据文件在 POSIX 下设为 0600。IP 数据仍放服务端工作目录的 `data/`，见 [IP 地理位置数据](#ip-地理位置数据ip2region)。

## 首次安装、升级与启动

由部署管理员先建库并配置 MySQL / Redis 账号，再在仓库根串行执行一次：

```sh
pnpm db:migrate
pnpm db:seed
```

**先 migrate 再 seed**，升级前备份数据库、上传文件与密钥；升级也沿此顺序，不使用 `db:reset`。这些命令自身会 build 并加载 `.env.local` / `.env`，因此应使用同一套构建环境。迁移与 seed 是发布步骤，不能放进每个实例或 PM2 自动重启的启动命令。已有种子账号密码不会被 seed 覆盖；首次随机密码只显示一次，详见 [入门密码规则](getting-started.md#4-安装迁移种子与登录)。

生产环境的 `pnpm db:seed` 也会创建请假样例的 5 个 OA 示例账号，共用一个仅打印一次的随机密码，非演示模式下首登强制改密；正式上线前应禁用 / 删除这些账号，或移除请假样例，不要公开 seed 日志。

使用 PM2 升级时，顺序为 `pnpm -r build` → `pnpm db:migrate` → `pnpm db:seed` → `pm2 restart qiwu-server`。migrate / seed 会重新执行 `nest build`，其 `deleteOutDir` 会删除并重建运行中 PM2 所用的 `apps/server/dist/`；代码生成器运行时也从该目录读取模板。迁移期间旧进程代码与新数据库结构会短暂并存，须确认兼容；需要避免这一窗口时，先 `pm2 stop qiwu-server`，再构建、迁移、seed 与重启。按版本目录部署（见 [GitHub Actions 自动部署](#github-actions-自动部署可选)）时，每个版本在独立目录构建，不会删除运行中的 `dist/`。

直接启动时必须进入服务端目录：

```sh
cd /srv/qiwu/current/apps/server
node --env-file-if-exists=.env.local --env-file-if-exists=.env dist/main.js
```

或先由密钥系统提供全部进程环境，再在相同工作目录执行 `node dist/main.js`。环境优先级是进程环境高于文件；Node 先读 `.env.local` 再读 `.env`，后者覆盖同名键。Nest 也按 `.env` → `.env.local` 加载。`apps/server/src/core/paths.ts` 的 i18n、迁移、模板、IP 数据与默认上传路径均基于 cwd；不要从仓库根直接执行 `node apps/server/dist/main.js`。

部署后由管理员检查 `GET /api/health`、登录、上传 / 私有下载及推送。本文只给出源码核对过的配置示例，未在真实 PM2 / nginx 服务器执行；生产网络、TLS、权限、存储与容量需要实际验收。

## Windows：构建与启动（PowerShell 5.1）

原生 Windows 11 + Windows PowerShell 5.1（含 cmd 入口）已验证用于开发与完整本地闸门（`pnpm ci:local --serial`）；无文件 symlink 权限时，符号链接防护测试跳过；Windows 服务器部署及 App / 小程序发布未验证。服务须由用户提供已验证的 MySQL 与 Redis ≥ 7，账号、ACL、隔离与浏览器准备见[入门指南](getting-started.md#windows原生-powershell-51)。本文 nginx / PM2 / 开机自启及 `/srv/` 路径属于 POSIX 主机示例，未验证 Windows 服务守护与反代安装。

`pnpm.cmd` 仅随 npm / Corepack 安装提供，避免 `.ps1` 执行策略且不改执行策略；独立 `pnpm.exe`（winget / get.pnpm.io）使用 plain `pnpm`，将下列 `pnpm.cmd` 换成 `pnpm`。 在部署副本根目录先按上文准备非秘密 `.env` 和 git 忽略的 `.env.local`（秘密键不放 `.env`，即便为空），路径改为自己的 Windows 目录，例如 `STORAGE_LOCAL_ROOT=C:/qiwu/uploads`。用编辑器保存 UTF-8 / LF，并限制凭据文件 ACL。发布步骤串行、先 migrate 再 seed，失败立即停止：

```powershell
pnpm.cmd i --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw "Install failed" }
pnpm.cmd -r build
if ($LASTEXITCODE -ne 0) { throw "Build failed" }
pnpm.cmd db:migrate
if ($LASTEXITCODE -ne 0) { throw "Migration failed" }
pnpm.cmd db:seed
if ($LASTEXITCODE -ne 0) { throw "Seed failed" }
Set-Location apps/server
node --env-file-if-exists=.env.local --env-file-if-exists=.env dist/main.js
```

最后一条由部署用户在服务端 cwd 启动前台进程，Ctrl+C 停止；长期运行方式由管理员另行验收。升级前备份，迁移与 seed 不放自动重启命令，不能用 reset 升级。

S3 的 CSP 构建与策略打印在仓库根执行；环境赋值用 `$env:`，每条原生命令检查 `$LASTEXITCODE`，结束后清除。以下假定变量原先未设置；已有值先保存并在完成后恢复：

```powershell
$env:CSP_CONNECT_SRC='https://qw-files.s3.example.com'
try {
  pnpm.cmd --filter @qiwu/web build
  if ($LASTEXITCODE -ne 0) { throw "Web build failed" }
  node -e "import('./apps/web/csp.ts').then((m) => console.log(m.SPA_CSP))"
  if ($LASTEXITCODE -ne 0) { throw "CSP output failed" }
} finally {
  Remove-Item Env:CSP_CONNECT_SRC
}
```

将完整策略交实际反代配置并验收响应头。ip2region 代理下载同样不改系统代理，在仓库根设置进程变量；下载仍要求已审阅的 sha256 pin：

```powershell
$env:NODE_USE_ENV_PROXY='1'
$env:HTTPS_PROXY='http://host:port'
try {
  node scripts/fetch-ip2region.mjs
  if ($LASTEXITCODE -ne 0) { throw "IP data download failed" }
} finally {
  Remove-Item Env:NODE_USE_ENV_PROXY
  Remove-Item Env:HTTPS_PROXY
}
```

## nginx 反向代理与 CSP

以下配置放在 nginx 的 `http` 上下文中。替换域名、证书路径、Web 根目录与上传路径；示例假定 nginx 与 Nest 同机、TLS 在 nginx 终止。后端 `TRUST_PROXY=127.0.0.1/32` 与该 loopback upstream 对应。

```nginx
map $http_upgrade $qw_connection_upgrade {
    default upgrade;
    '' close;
}

upstream qiwu_api {
    server 127.0.0.1:3000;
}

server {
    listen 443 ssl;
    server_name qiwu.example.com;
    ssl_certificate /etc/nginx/tls/qiwu.fullchain.pem;
    ssl_certificate_key /etc/nginx/tls/qiwu.key;
    root /srv/qiwu/current/apps/web/dist;
    index index.html;

    location ^~ /api/ {
        client_max_body_size 21m;
        proxy_pass http://qiwu_api;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Host $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;
    }

    location ^~ /socket.io/ {
        proxy_pass http://qiwu_api;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $qw_connection_upgrade;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Host $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_read_timeout 75s;
    }

    location /files/ {
        alias /srv/qiwu/uploads/public/;
        autoindex off;
        add_header X-Content-Type-Options nosniff always;
        add_header Content-Security-Policy "default-src 'none'; sandbox" always;
    }

    location ~ /\. {
        return 404;
    }

    location /assets/ {
        try_files $uri =404;
        add_header Cache-Control "public, max-age=31536000, immutable";
        add_header X-Content-Type-Options nosniff always;
        add_header Referrer-Policy same-origin always;
        add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; frame-src 'self' https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" always;
    }

    location = /index.html {
        add_header Cache-Control no-cache;
        add_header X-Content-Type-Options nosniff always;
        add_header Referrer-Policy same-origin always;
        add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; frame-src 'self' https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" always;
    }

    location / {
        try_files $uri $uri/ /index.html;
        add_header X-Content-Type-Options nosniff always;
        add_header Referrer-Policy same-origin always;
        add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; frame-src 'self' https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" always;
    }
}
```

SPA 回退支持 `/sso` 等前端路由；`/api/` 与 `/socket.io/` 保留原路径转发。代理**覆盖** `X-Forwarded-For`，不追加客户端伪造的值；Host 与 Proto 保留本站来源，避免 refresh 与 WebSocket Origin 校验失败。WebSocket 读超时应长于心跳周期；若修改心跳配置，重新核对 75 秒示例。原理见 [nginx WebSocket 官方说明](https://nginx.org/en/docs/http/websocket.html)。

`location ~ /\.` 也会阻断 `/.well-known/`。使用 webroot 方式续签证书时，在处理 ACME 请求的 `server` 中单独放行挑战目录（HTTP-01 通常由 80 端口处理）；`root` 与证书客户端的 webroot 一致，例如：

```nginx
location ^~ /.well-known/acme-challenge/ {
    root /var/lib/letsencrypt;
    try_files $uri =404;
}
```

`/files/` 只 alias 到 `STORAGE_LOCAL_ROOT/public/`，不能指向整个上传根目录或 `private/`；私有下载走鉴权 API。公开目录不应包含符号链接到私有数据。nginx 的 `client_max_body_size` 默认只有 1 MB；示例在 `/api/` 设为 `21m`，覆盖后台默认 20 MB 上传与 10 MB Excel 导入，并预留 multipart 开销。修改后台 `storage.max_size_mb` 或 `excel.import_max_mb` 时，必须同步调整 nginx 限制，使其至少覆盖两者较大值及 multipart 开销，并一并验收。

示例中的完整 CSP 是 `apps/web/csp.ts` 的默认 `SPA_CSP`，仅发给 Web 静态响应；API / Swagger 的头由服务端 helmet 负责。使用 S3 直传或私有预签名下载时，用同一份 `CSP_CONNECT_SRC` 构建，并从仓库根生成**完整策略**，替换示例的所有三处 CSP 字符串：

```sh
CSP_CONNECT_SRC=https://qw-files.s3.example.com pnpm --filter @qiwu/web build
CSP_CONNECT_SRC=https://qw-files.s3.example.com node -e "import('./apps/web/csp.ts').then((m) => console.log(m.SPA_CSP))"
```

不要自行删减策略或改成通配符；源与 S3 CORS 的配置见下面的存储小节。部署管理员更新 nginx 后先用 `nginx -t` 检查，再按服务器流程加载配置，检查实际响应头与浏览器 CSP 错误。

## 使用 PM2 部署（可选）

PM2 是 AGPL-3.0 运维工具；这里只在服务器全局安装，用它守护 Node 进程，不加入任何 `package.json`、不 `import pm2`，项目依赖的许可禁用清单保持不变。配置字段见 [PM2 官方说明](https://pm2.keymetrics.io/docs/usage/application-declaration/)。

```sh
npm install -g pm2
```

仓库自带 [`scripts/deploy/ecosystem.config.cjs`](../scripts/deploy/ecosystem.config.cjs)：cluster 模式 2 个 worker，cwd 为 `<根目录>/current/apps/server`，两个 env 文件按绝对路径加载，日志写入 `<根目录>/logs/`。仓库是 ESM，所以配置使用 `.cjs`。根目录、进程名与 worker 数取环境变量 `QW_DEPLOY_ROOT`（默认 `/srv/qiwu`）、`QW_PM2_NAME`（默认 `qiwu-server`）与 `QW_PM2_INSTANCES`（默认 2）。由部署管理员建立仅部署用户可写的 `/srv/qiwu/logs`，并把该文件放到部署用户不可写的 `/opt/qiwu-deploy/bin/`（下文的准备脚本会这样安装）。

env 文件通过 Node 的 `node_args` 加载，密钥仍在受限 `.env.local` 或外部进程环境，配置文件不含秘密。发布管理员**先执行一次 migrate → seed**，再以同一部署用户管理 PM2：

```sh
pm2 start /opt/qiwu-deploy/bin/ecosystem.config.cjs --env production
pm2 logs qiwu-server
pm2 save
pm2 startup
```

`pm2 logs` 是交互观察，Ctrl+C 退出。`pm2 save` 保存当前进程列表；`pm2 startup` 打印的系统自启安装命令由服务器管理员核对后执行，再确认重启后的进程状态，流程见 [PM2 自启说明](https://pm2.keymetrics.io/docs/usage/startup/)。日志目录和 PM2 状态目录须限制访问并安排轮转；进程环境中的秘密也须按秘密文件管理。

升级后用 `pm2 startOrReload /opt/qiwu-deploy/bin/ecosystem.config.cjs --env production` 逐个替换 worker，服务不中断；调整 worker 数用 `pm2 scale qiwu-server <n>` 后 `pm2 save`；启用了下文的自动部署时，同时把 `/opt/qiwu-deploy/deploy.env` 的 `QW_PM2_INSTANCES` 改成同一个数：健康检查要求 worker 数不少于它，两者不一致时之后每次部署都会失败，切回后的检查同样失败（退出 3）。

同一主机上的 cluster 已满足 [scale-out.md](scale-out.md) 的大部分前提：各 worker 读同一组 env 文件，共用 MySQL 库、Redis 库号与前缀及 `APP_SECRET`；上传目录是同一主机路径；项目只启用 websocket，每条连接固定在一个 worker 上，无需粘性会话；定时任务靠 Redis 锁去重。Redis 版本、ACL 与适配器就绪仍按 scale-out.md 核对；跨主机多实例另需共享存储与代理验收，将来启用 polling 必须另配粘性会话。

## GitHub Actions 自动部署（可选）

仓库带两个工作流和 `scripts/deploy/` 下的服务器部署套件。复刻仓库时，把两个工作流里的 `github.repository == '732124645/qiwu-vue-admin'` 改成自己的仓库名，`deploy.env` 的 `QW_REPO` 也一样。两个工作流必须一起改：只改了 `release.yml` 时，main 推送的 CI 运行会跳过门禁却显示成功，发布工作流会因其中的 `gate` 作业被跳过而报错退出。

- [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)：main 推送、PR 与手动触发时运行。ubuntu-24.04 上启动 MySQL 8.4 与 Redis 8 服务容器（账号密码每次随机；Redis 用户与生产一样只能访问 `qw:*`），`PW_CHANNEL=chromium` 让 Playwright 使用自带的 Chromium（本地默认仍是 Edge），然后运行完整门禁 `pnpm ci:local`；失败时上传 Playwright 结果（保留 7 天）。只在上游仓库自动运行，其他仓库只能手动触发。
- [`.github/workflows/release.yml`](../.github/workflows/release.yml)：推送 `vX.Y.Z` 标签时不再重跑门禁。先校验标签格式、标签指向本次运行的提交且该提交在 `main` 上、`CHANGELOG.md` 中有非空的 `## [X.Y.Z]` 一节 → 再通过 Actions API 确认本仓库的 CI 工作流（按文件 `.github/workflows/ci.yml` 识别）已为同一提交成功跑完一次推送运行：事件为 `push`、分支为 `main`、提交号完全一致、已完成且结论为成功，同一仓库而非 fork，且这次运行中的 `gate` 作业结论为成功（被跳过不算：所有作业都被跳过的运行整体也显示成功）；PR、手动触发或其他分支的运行都不算 → 以该节创建 GitHub Release → 等待环境 `demo` 审批 → 通过 SSH 把 `<标签> <提交号>` 发给服务器执行部署。预发布标签（如 `v1.1.0-rc.1`）不触发。

发布顺序因此是：推 `main` → 等 CI 通过 → 推标签。CI 还在运行、失败或没有运行时，发布工作流报错退出，不建 Release 也不部署；CI 通过后在 Actions 页面重新运行该发布工作流即可（校验在运行时进行）。标签必须打在 CI 实际测过的那次推送的尖端提交上：一次推送多个提交时只有最后一个有 CI 运行，提交信息带 `[skip ci]` 的推送没有运行，这两种情况重跑多少次发布工作流都不会通过。CI 偶发失败时，先在 Actions 页面重跑那次 CI 运行，通过后再重跑发布工作流。

第三方 action 均按完整提交号固定。只有创建 Release 的作业有 `contents: write`（另有读取 CI 运行记录的 `actions: read`）；部署作业没有令牌权限，只拿环境机密。

### 仓库设置

1. Settings → Environments 新建 `demo`：Required reviewers 填仓库所有者（可以审批自己的发布）；Deployment branches and tags 选 Selected，只加标签规则 `v*`。环境机密：
   - `DEPLOY_SSH_KEY`：部署私钥。用 `ssh-keygen -t ed25519 -N '' -C deploy -f deploy_key` 生成，公钥交给下文的准备脚本，私钥存进机密后从本机删除。
   - `DEPLOY_HOST`：服务器地址；前面有 CDN 时填源站 IP，不填经代理的域名。
   - `DEPLOY_KNOWN_HOSTS`：服务器主机公钥行（准备脚本最后打印），主机字段须与 `DEPLOY_HOST` 完全一致。

   可选环境变量 `DEPLOY_USER`，默认 `qiwu`。

2. Settings → Rules → Rulesets 新建 Tag 规则集：目标 `v*`，限制更新与删除，已发布的标签不能被移动。
3. Settings → Actions → General：Workflow permissions 选只读；不允许 Actions 创建或批准 PR；外部贡献者的 fork PR 运行需要审批。工作流只用 `pull_request`，fork 的 PR 拿不到机密。
4. 服务器 SSH 端口要对 GitHub 托管 runner 开放（其地址段很大），启用前先关闭密码登录，root 只允许密钥登录。sshd 对同一关键字只采用读到的第一个值，`sshd_config.d/` 下的文件按文件名顺序读入（Debian/Ubuntu 在 `sshd_config` 开头引入它们，先于主文件自己的设置），云镜像或服务商的 `00-*.conf` 之类可能重新打开密码登录；加固结果以 `sshd -T` 的实际值为准，例如 `sshd -T | grep -Ei '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin) '`。不带 `-C` 的 `sshd -T` 只显示全局值，而 Match 段会覆盖全局值（例如 `Match Address` 为部分来源重新打开密码登录），所以还要检查 `sshd_config` 与 `sshd_config.d/` 下有没有 Match 段，并用 `sshd -T -C user=root,host=<主机名>,addr=<外部地址>` 按连接核对。

### 服务器布局

| 路径                                              | 属主                  | 用途                                                                                                          |
| ------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `/opt/qiwu-deploy/bin/`                           | root，0755            | `server-deploy.sh`、`deploy-forced-command.sh`、`ecosystem.config.cjs`：应用用户改不了部署逻辑                |
| `/opt/qiwu-deploy/deploy.env`                     | root，0644            | 部署配置，不含秘密；模板 [`deploy.env.example`](../scripts/deploy/deploy.env.example)                         |
| `/opt/qiwu-deploy/deploy.lock`                    | root:应用用户组，0660 | 部署锁；放在 root 的目录里，root 取锁时不会跟随应用用户放的符号链接                                           |
| `/opt/qiwu-deploy/authorized_keys`                | root，0644            | 部署公钥；sshd 只从这里读应用用户的公钥，应用用户加不了自己的公钥                                             |
| `/srv/qiwu/`                                      | root:应用用户组，1775 | 应用用户可以新建自己的条目；粘滞位让它不能改名或删除 root 放在这里的文件（例如 Nginx 片段）                   |
| `/srv/qiwu/releases/<标签>-<UTC 时间>/`           | 应用用户              | 每次部署一个完整目录（源码、依赖与构建产物）；`REVISION` 记录 `<标签> <提交号>`，部署成功后写 `DEPLOYED` 标记 |
| `/srv/qiwu/current`                               | 应用用户              | 指向当前版本的符号链接，原子切换；Nginx root 与 PM2 cwd 都经过它                                              |
| `/srv/qiwu/shared/apps/server/.env`、`.env.local` | 应用用户，0644 / 0600 | 链接进每个版本（`QW_SHARED_LINKS`）                                                                           |
| `/srv/qiwu/shared/ip2region/<sha256>.xdb`         | 应用用户              | 按 pin 区分的 IP 数据，回到旧版本时也有对应文件                                                               |
| `/srv/qiwu/logs/`、`/srv/qiwu/logs/deploy/`       | 应用用户              | PM2 日志；每次部署的详细日志（0640，保留 90 天）                                                              |
| `/srv/qiwu/backups/`                              | 应用用户，0700        | 可选的迁移前 `mysqldump`（保留 14 天）                                                                        |

上传目录必须在代码目录之外：`STORAGE_LOCAL_ROOT` 设为绝对路径，解析符号链接后也不能落在 `current`、`releases`、`app` 之下（例如 `/srv/qiwu/uploads`），否则部署脚本拒绝继续——切换会换掉代码目录，清理会删除旧版本。Nginx 的 `root` 指向 `/srv/qiwu/current/apps/web/dist`。

`deploy.env` 的键：

| 键                                 | 默认                                      | 说明                                                                                                  |
| ---------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `QW_DEPLOY_ROOT`                   | `/srv/qiwu`                               | 部署根目录                                                                                            |
| `QW_REPO`                          | 必填                                      | 标签来源的公开仓库 `<owner>/<name>`，下载不需要凭据                                                   |
| `QW_APP_USER`                      | `qiwu`                                    | 脚本只以该用户运行                                                                                    |
| `QW_PM2_NAME`、`QW_PM2_INSTANCES`  | `qiwu-server`、`2`                        | PM2 进程名与 worker 数                                                                                |
| `QW_HEALTH_URL`、`QW_HEALTH_TRIES` | 本机 `:3000/api/health`、`30`             | 健康检查地址与次数（间隔 2 秒）                                                                       |
| `QW_KEEP_RELEASES`                 | `3`                                       | 保留的已部署版本数（含当前版本）                                                                      |
| `QW_MIN_FREE_MB`                   | `3072`                                    | 部署前要求的剩余空间                                                                                  |
| `QW_DEPLOY_SEED`                   | `1`                                       | 迁移后运行种子（幂等；新菜单与权限需要它）                                                            |
| `QW_ASSET_CARRY_DAYS`              | `14`                                      | 旧版本网页资源的保留天数                                                                              |
| `QW_SHARED_LINKS`                  | `apps/server/.env apps/server/.env.local` | 从 `shared/` 链接进版本目录的文件                                                                     |
| `QW_DB_NAME`、`QW_DB_BACKUP_CNF`   | 空                                        | 两者都设置时，迁移前 `mysqldump`；后者是仅有备份权限账号的 MySQL 选项文件（0600）                     |
| `QW_MIGRATE_ENV`                   | 空                                        | 可选 env 文件，提供有 DDL 权限的 `DB_USER` 与 `DB_PASSWORD`，只用于迁移与种子；应用账号可以只保留 DML |
| `QW_ALLOW_DOWNGRADE`               | `0`                                       | 默认拒绝部署比当前更低的标签                                                                          |
| `QW_BUILD_TIMEOUT`                 | `30m`                                     | `pnpm i` 与 `pnpm -r build` 各自的时限（GNU `timeout` 的写法）                                        |
| `QW_MIGRATE_TIMEOUT`               | `10m`                                     | 迁移与种子各自的时限；等元数据锁的 DDL 会阻塞线上对该表的查询，时限不宜过长                           |

### 服务器准备（一次）

部署全程以应用用户运行；只有准备服务器与更新部署套件需要 root。准备脚本中 root 只写 root 拥有的路径（`/opt/qiwu-deploy`、Nginx 与 sshd 配置），`/srv/qiwu` 下与应用用户家目录里的操作都以应用用户身份执行，应用用户放的符号链接因此换不来 root 权限。

root 运行套件并把它装进 root 拥有的 `bin/`，所以套件本身也只能由 root 修改：由 root 按提交号下载标签的源码包，解压到 root 拥有的新目录再运行。**不要从 `/srv/qiwu/current` 或 `/srv/qiwu/releases/` 运行**：那里应用用户可写，拿到应用用户身份的代码可以先改掉脚本，等 root 执行时提权。脚本开头检查套件目录、它的每一级父目录和每个套件文件，属主不是 root 或组与其他用户可写时拒绝运行。

```sh
sudo -i                                    # 以下以 root 执行
TAG=vX.Y.Z SHA=<标签的 40 位提交号>        # 与 GitHub 上该标签的提交核对
git ls-remote https://github.com/732124645/qiwu-vue-admin "refs/tags/$TAG^{}" "refs/tags/$TAG"
install -d -m 0700 /root/qiwu-kit-$TAG
curl -fsSL https://codeload.github.com/732124645/qiwu-vue-admin/tar.gz/$SHA |
  tar -xz --strip-components=1 --no-same-owner --no-same-permissions -C /root/qiwu-kit-$TAG
bash /root/qiwu-kit-$TAG/scripts/deploy/server-migrate-layout.sh --pubkey deploy_key.pub
```

`git ls-remote` 打印的附注标签行（`^{}`）或轻量标签行须等于 `SHA`。`--no-same-permissions` 让解压后的文件按 root 的 umask 去掉组写权限（源码包里的文件可能带组写权限）。

脚本可以重复运行，已完成的步骤会跳过：

1. 建立 root 拥有的 `/opt/qiwu-deploy/`；`deploy.env` 不存在时从模板生成并停下，核对后再运行。之后取部署锁（有部署在进行时停下），把部署套件装进 `bin/`（先写临时文件再改名，正在读旧脚本的进程不受影响）。
2. `/srv/qiwu` 设为 root:应用用户组 1775，以应用用户身份建立上表的目录。应用用户组里只能有应用用户（脚本开始时检查，否则停下）：组成员都能在 `/srv/qiwu` 新建条目；应用用户的家目录可能就是 `/srv/qiwu`，组成员还能在里面放入部署时 git、pnpm 会读取的点文件（如 `.npmrc`、`.gitconfig`），以应用用户身份执行代码。已有单目录安装（`/srv/qiwu/app`，PM2 fork 进程）时：把 `.env`、`.env.local` 与 IP 数据复制到 `shared/`，原来的两个 env 文件换成指向 `shared/` 的符号链接（旧版本的 worker 和切回旧版本都读 `shared/`，修改配置或轮换密钥只改一处；运行中的进程启动时已读完 env，不受影响），确认上传目录在外部，把 `app` 移为 `releases/legacy-*` 并建立 `current`；`app` 留作兼容链接，首次自动部署成功、确认 Nginx 不再引用后即可删除。
3. Nginx 配置中的 `/srv/qiwu/app/` 改为 `/srv/qiwu/current/`；`nginx -t` 通过才重载，否则还原。
4. 指定 `--pubkey` 时：sshd 配置片段 `/etc/ssh/sshd_config.d/60-qiwu-deploy.conf` 的 `Match User` 段对应用用户设 `AuthorizedKeysFile /opt/qiwu-deploy/authorized_keys`，强制 `ForceCommand /opt/qiwu-deploy/bin/deploy-forced-command.sh`，只允许公钥，`DisableForwarding yes`（端口、套接字、代理与 X11 转发全部关闭）、`PermitUserRC no`、`PermitTTY no`。`sshd -t` 通过，并且 `sshd -T` 显示应用用户的这些设置全部生效、root 的强制命令与公钥文件不受影响，才重载 sshd；否则删除该片段并停下（前面的配置文件中匹配该用户的 Match 段若先设了同一关键字，sshd 会采用它）。公钥以 `restrict,command="/opt/qiwu-deploy/bin/deploy-forced-command.sh" <公钥>` 一行写入 root 拥有的 `/opt/qiwu-deploy/authorized_keys`（0644），已有的公钥跳过。公钥不放在应用用户家目录：家目录可能就是 `/srv/qiwu`，第 2 步把它设为组可写后，sshd 的 StrictModes 会拒绝其中的 `~/.ssh/authorized_keys`。应用用户 `~/.ssh/` 下已有的文件不改动，sshd 也不再读取；应用用户既加不了公钥，改写 `~/.ssh/rc` 也无效，root 拥有的 sshd 配置只允许运行部署脚本，也不能转发。强制命令固定 `LC_ALL=C`（客户端可以传入 `LC_*`）。
5. PM2 进程从 fork 改为 cluster：唯一的停机点，约几秒；先把 `~/.pm2/dump.pm2` 复制一份，健康检查不通过时用它恢复原来的进程列表。PM2 命令在干净的环境里运行，root 会话的变量不会被 `pm2 save` 存下来。
6. 打印 `DEPLOY_KNOWN_HOSTS` 需要的主机公钥行（读服务器本机文件，不依赖首次连接时的信任）。

`git`、`curl`、`tar`、`flock`、`timeout`、`node`、`pnpm`、`pm2` 须在应用用户的默认 PATH 中（脚本会检查）；启用备份时还需要 `mysqldump`。脚本只支持 Linux 与 bash。发布改动了 `scripts/deploy/` 时，按上面的步骤把新标签解压到新的 `/root/qiwu-kit-<标签>` 再运行一次本脚本，即可更新 `/opt/qiwu-deploy/bin/`。第一次建议先在服务器上手动部署一个标签、观察完整流程，再配置环境机密。

### 每次部署

强制命令只接受 `<vX.Y.Z> <40 位提交号>`，再调用 `server-deploy.sh`：

1. 校验参数，读 `deploy.env`，确认运行用户，取得 `deploy.lock`（已有部署在进行时退出 75）。标签解析与源码下载有超时，安装、构建、迁移与种子各有总时限（`QW_BUILD_TIMEOUT`、`QW_MIGRATE_TIMEOUT`，超时按失败处理），卡住的步骤不会一直占着锁。
2. 在 `QW_REPO` 解析标签（支持附注标签），结果必须等于工作流发来的提交号；默认拒绝降级；检查剩余空间。
3. 按提交号从 GitHub 下载源码包到新的 `releases/<标签>-<UTC 时间>`，链接共享文件与 IP 数据，然后 `pnpm i --frozen-lockfile` 与 `pnpm -r build`（低优先级，把 CPU 让给在线服务）。
4. 把当前版本自身的网页资源与最近 `QW_ASSET_CARRY_DAYS` 天的资源硬链接进新版本：已打开的页面仍能加载旧分块，CDN 也不会缓存到 404。
5. 可选备份，然后运行新版本的迁移与种子（`dist/db/migrate.js`、`dist/db/seed.js`）。
6. 原子切换 `current`，`pm2 startOrReload` 逐个替换 worker。健康检查要求 `/api/health` 正常，**并且**每个 worker 的工作目录都是新版本；通过后写 `DEPLOYED`、`pm2 save`，清理多余版本与过期的日志和备份。

切换前任何一步失败（包括切换本身）：退出 1，删除新版本目录，旧版本照常服务；这时新版本的迁移与种子可能已经执行，数据库不回退（见下文边界）。切换后健康检查失败：切回上一版本并重载，成功退出 2，仍然失败退出 3（需要人工处理）。参数错误退出 64。SSH 中断不会打断部署，它会完成或切回。Actions 日志只有步骤摘要（公开仓库的日志所有人可见），详细输出在 `/srv/qiwu/logs/deploy/`。

迁移超时后，被结束的进程留下的语句可能仍在 MySQL 里等锁：用 `SHOW PROCESSLIST` 找到状态为 `Waiting for table metadata lock` 的迁移语句并 `KILL` 它，再找出持有锁的长事务处理后重新部署。部署进程本身卡住（例如被手动暂停）时，用 `pgrep -af server-deploy.sh` 找到它，结束它及其子进程；进程退出后 `deploy.lock` 自动释放。

在服务器上手动操作：

```sh
sudo -u qiwu -H /opt/qiwu-deploy/bin/server-deploy.sh vX.Y.Z      # 手动部署一个标签
sudo -u qiwu -H /opt/qiwu-deploy/bin/server-deploy.sh --rollback  # 切回上一个已部署的版本，只回代码
```

`--dry-run <源码包> <标签>` 只用于测试：只能针对带 `DRY_RUN` 标记文件的临时根目录，标签在本地 git 仓库解析，跳过网络、pnpm、数据库与 PM2 重载；worker 检查读该根目录下的 `proc/`，由 PATH 上的 `pm2` 替身写入。

### 边界

- 自动切回只回代码，不回数据库。迁移必须兼容上一版本（先加后删，分两个版本完成）；不兼容的迁移在维护窗口手动部署，必要时从迁移前备份恢复。MySQL 的 DDL 不是事务性的，失败的迁移可能已部分执行。
- 部署从不调用 `db:reset`；种子幂等，不覆盖已有密码。将来若加定时重置任务，须取同一把 `/opt/qiwu-deploy/deploy.lock`。
- 仍不提供 Docker 镜像；CI 的服务容器只是 GitHub runner 上的测试设施。

## 演示模式与 OAuth 边界

公开演示使用独立库、Redis db 与凭据，设置 `APP_DEMO_MODE=true`。全局守卫放行 GET / HEAD 与精确的登录、登出、refresh、锁屏验证、验证码检查、语言 / 列偏好、公告 / 站内信 / 抄送已读等写入；其他写操作（包含 root 和公开路由）返回 403 `A0431`。`POST /api/demo/realtime/send` 仍被阻断。

演示模式继续阻断 **`POST /api/oauth2/{authorize,token,introspect,revoke}`**。**要演示 OAuth，请用非演示安装（to demo OAuth, use a non-demo install）**，并按 [OAuth2 接入指南](oauth2.md) 配置客户端。

demo seed 给**新建**的种子管理员与 OA 示例用户免首登改密；未预设管理员密码时仍生成随机密码，OA 示例用户共用的随机密码仅在创建时打印一次。已有账号不重写。把开关改回 `false` 不会撤销已经公布的密码或恢复旧账号改密标志；正式环境应独立安装并重建 / 轮换凭据，不复用公开 demo 数据库。

## IP 地理位置数据（ip2region）

- 登录日志、操作日志、在线用户的"地点"与 `GET /api/geo/areas/by-ip` 读取 `<工作目录>/data/ip2region_v4.xdb`（`apps/server/src/core/paths.ts`）。文件约 11 MB，不入库（`.gitignore` 的 `*.xdb`），许可见 `THIRD-PARTY-NOTICES.md`。
- 下载：`node scripts/fetch-ip2region.mjs`（默认写入 `apps/server/data/`；`--out <目录或 .xdb 路径>` 指定位置；`--url <镜像>` 换来源）。下载内容的 sha256 必须等于 `scripts/ip2region.sha256` 中固定的值，否则什么都不写并以非 0 退出。
- 仓库尚未提交 `scripts/ip2region.sha256` 时，上述命令在下载前即以非 0 退出并打印下面的步骤。**一次性审阅固定（pin）**（首次使用，或上游数据更新后有意升级）：
  1. `node scripts/fetch-ip2region.mjs --pin`：下载并打印 sha256 与大小，**不写任何文件**；
  2. 审阅：来源为 `github.com/lionsoul2014/ip2region`（许可 `Apache-2.0 OR MIT`，按 MIT 使用，见 `THIRD-PARTY-NOTICES.md`）；哈希与再次下载（或其他网络/镜像）的结果、上游对应提交中的文件一致；
  3. `node scripts/fetch-ip2region.mjs --pin --confirm <上一步的 sha256>`：仅当这次下载的哈希仍等于确认值时，写入 `scripts/ip2region.sha256` 与数据文件；不一致则什么都不写；
  4. 提交 `scripts/ip2region.sha256`；之后的下载（含日后镜像构建期）都按它校验。
- 需要代理时，macOS / POSIX：`NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://host:port node scripts/fetch-ip2region.mjs`；Windows 用[上文 PowerShell 代理示例](#windows构建与启动powershell-51)。
- 文件缺失或损坏时服务照常运行：地点为空，启动后首次查询打印一条警告。放入文件后重启服务生效。

## 文件存储（S3 直传与私有下载）

- 上传组件的直传开关（`direct`）让浏览器把文件 `PUT` 到主 S3 存储的 `staging/<key>`；私有文件预览（`fetchBlob`）跟随 302 到 60 s 预签名 GET。两者都是浏览器对 S3 源的跨源请求，受 SPA CSP 的 `connect-src` 约束，默认只有 `'self'`（`apps/web/csp.ts`）。
- 构建 / 预览 web 时用 env `CSP_CONNECT_SRC` 列出这些源（空格或逗号分隔；每项必须是 `https://主机[:端口]`，开发时可用 `http://localhost[:端口]`；带路径、通配符、关键字或其他协议的项使构建失败）：`CSP_CONNECT_SRC=https://qw-files.s3.example.com pnpm --filter @qiwu/web build`。填 S3 请求实际发往的源：path-style 为 endpoint 的源，virtual-hosted 为 `https://<bucket>.<endpoint 主机>`。
- 反向代理（nginx）下发的 CSP 必须与之逐字一致，用同一 env 打印：`CSP_CONNECT_SRC=… node -e "import('./apps/web/csp.ts').then((m) => console.log(m.SPA_CSP))"`。
- 存储桶须配置 CORS：允许本站源的 `PUT`（请求头 `Content-Type`、`x-amz-checksum-sha256`）与 `GET`；并给 `staging/` 设生命周期规则（例如 1 天后过期），清理未确认或重复 `PUT` 留下的暂存对象。
- 公开对象直链（`publicDomain` 或桶地址）由 `<img>` 加载，已在 `img-src https:` 之内，不必列入。
- 服务端连接管理员配置的 S3 endpoint（及 SMTP 主机）只允许公网地址与登记端口（SSRF 防护）：S3 默认 80/443，SMTP 默认 25/465/587。自建服务使用其他端口时，由部署者在 server env 登记：`OUTBOUND_S3_PORTS=9000,8333`、`OUTBOUND_SMTP_PORTS=2525`（逗号或空格分隔的端口号，其他写法使启动失败）。该名单只能由 env 设置，存储/邮件配置表单不可修改；未登记的端口一律拒绝。

## 接口文档（Swagger）

- `SWAGGER_ENABLED=true` 时服务端在 `/api/docs` 提供 Swagger UI（JSON：`/api/docs-json`）；默认 `false`，生产环境建议保持关闭。
- `SWAGGER_ENABLED=false` 时不注册 Swagger UI / JSON 端点，菜单也自动隐藏；关闭后可人工检查两端点为 404。开发 `.env.example` 显式设为 `true`，正式部署须按本文设回 `false`。
- 菜单"系统工具 → 系统接口"是 `link_type=iframe` 的页面，在布局内以 iframe 打开同源的 `/api/docs`（反向代理须把 `/api/` 转发到服务端）。
- `SWAGGER_ENABLED=false` 时 `GET /api/auth/menus` 不下发该菜单（无论角色是否授权），前端也就不注册该路由。映射在 `apps/server/src/core/auth/menu-features.ts`（`route_name → 开关`，v1 仅此一项）：新增"随服务端开关出现"的菜单时在此登记。

## 实时推送（Socket.IO）

- 服务端在 `/socket.io`（仅 websocket）提供推送；反向代理须把 `/socket.io/` 以 WebSocket 升级转发到服务端，并保留浏览器的 `Host`（或由 `TRUST_PROXY` 信任的代理设置 `X-Forwarded-Host` / `X-Forwarded-Proto`）。
- 握手校验浏览器的 `Origin`：只接受本站自身的源（`协议://Host`，与 refresh 的 `Origin` 校验同一规则）或 `CORS_ORIGIN` 中列出的源（逗号分隔，开发时 `http://localhost:5173`）；其他页面发起的连接以 `connect_error` `forbidden_origin` 拒绝。没有 `Origin` 头的非浏览器客户端不受此限，但仍须有效的访问令牌。

## OAuth2 与单点登录

- 第三方的授权入口 `/sso` 是前端路由，和其他页面一样靠 SPA 回退：反向代理对 `/api/`、`/files/`、`/socket.io/` 以外、又不是静态文件的路径返回 `index.html`（nginx：`try_files $uri $uri/ /index.html;`），否则直接打开授权链接会 404。
- `POST /api/oauth2/token`、`/introspect`、`/revoke` 按来源 IP 限流（每分钟 600 / 1200 / 1200 次），`TRUST_PROXY` 必须设成反向代理的地址，否则所有第三方都计在代理这一个 IP 上。这三个端点和 `GET /api/oauth2/userinfo` 由第三方的后端直接调用，不需要 CORS。
- 接入流程、请求与响应见 [oauth2.md](oauth2.md)。
