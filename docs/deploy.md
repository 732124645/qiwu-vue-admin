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

使用 PM2 升级时，顺序为 `pnpm -r build` → `pnpm db:migrate` → `pnpm db:seed` → `pm2 restart qiwu-server`。migrate / seed 会重新执行 `nest build`，其 `deleteOutDir` 会删除并重建运行中 PM2 所用的 `apps/server/dist/`；代码生成器运行时也从该目录读取模板。迁移期间旧进程代码与新数据库结构会短暂并存，须确认兼容；需要避免这一窗口时，先 `pm2 stop qiwu-server`，再构建、迁移、seed 与重启。

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

PM2 是 AGPL-3.0 运维工具；这里只在服务器全局安装，用它守护 Node 进程，不加入任何 `package.json`、不 `import pm2`，项目依赖的许可禁用清单保持不变。默认部署一个实例。配置字段见 [PM2 官方说明](https://pm2.keymetrics.io/docs/usage/application-declaration/)。

```sh
npm install -g pm2
```

由部署管理员建立仅部署用户可写的 `/srv/qiwu/logs`，并在 `/srv/qiwu/current/ecosystem.config.cjs` 保存下列示例。仓库是 ESM，所以配置使用 `.cjs`；cwd 必须是绝对服务端路径：

```js
module.exports = {
  apps: [
    {
      name: 'qiwu-server',
      cwd: '/srv/qiwu/current/apps/server',
      script: 'dist/main.js',
      node_args: '--env-file-if-exists=.env.local --env-file-if-exists=.env',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      time: true,
      error_file: '/srv/qiwu/logs/server-error.log',
      out_file: '/srv/qiwu/logs/server-out.log',
      env_production: { NODE_ENV: 'production' },
    },
  ],
}
```

这里通过 Node 的 `node_args` 加载工作目录的 env 文件，密钥仍在受限 `.env.local` 或外部进程环境，配置文件不含秘密。发布管理员**先执行一次 migrate → seed**，再以同一部署用户管理 PM2：

```sh
pm2 start /srv/qiwu/current/ecosystem.config.cjs --env production
pm2 logs qiwu-server
pm2 save
pm2 startup
```

`pm2 logs` 是交互观察，Ctrl+C 退出。`pm2 save` 保存当前进程列表；`pm2 startup` 打印的系统自启安装命令由服务器管理员核对后执行，再确认重启后的进程状态，流程见 [PM2 自启说明](https://pm2.keymetrics.io/docs/usage/startup/)。日志目录和 PM2 状态目录须限制访问并安排轮转；进程环境中的秘密也须按秘密文件管理。

开 cluster / `-i` 多实例前，先闭合 [scale-out.md](scale-out.md) 的共享 MySQL / Redis、同库号 / 前缀 / `APP_SECRET`、适配器就绪、共享存储及实际代理验收条件，再调整配置。当前只启用 websocket，无需 sticky；将来启用 polling 必须另配粘性会话。本文不把单实例 PM2 示例当作生产横向扩容已验证。

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
