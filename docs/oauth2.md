# OAuth2 提供方与单点登录（第三方接入）

> 第三方应用可以通过 OAuth2 使用栖梧账号登录并读取基本资料。协议回归见 [oauth2.e2e-spec.ts](../apps/server/test/e2e/oauth2.e2e-spec.ts)，客户端管理见 [oauth-client.e2e-spec.ts](../apps/server/test/e2e/oauth-client.e2e-spec.ts)，浏览器入口 `/sso` 见 [sso.spec.ts](../apps/web/e2e/sso.spec.ts)。反向代理要求见 [deploy.md](deploy.md#oauth2-与单点登录)。

**要演示 OAuth，请用非演示安装。** `APP_DEMO_MODE=true` 时，`POST /api/oauth2/authorize`、`/token`、`/introspect`、`/revoke` 都被全局演示守卫拒绝，返回 403 `A0431` 错误信封（不是 RFC JSON），即使是 root 或标 `@Public()` 的端点也一样。GET 同意预览仍按原认证执行，但不能完成授权；客户端管理写入也被拦截。精确豁免见 [security.md](security.md#演示模式的精确豁免)。以下接入步骤要求非演示环境。

## Windows 入口与 POSIX 教程范围

本文所有 `sh` 代码块（curl、openssl、变量赋值、管道与续行）仅适用于 macOS / POSIX 终端，不是 PowerShell 5.1 教程。Windows 按下面的 UI 入口登记客户端，由第三方后端构造完整的 `/sso` 授权 URL（含 PKCE 与 state），在浏览器地址栏打开；不将 PowerShell 的 curl 别名当作这些示例的等价命令。服务准备与已验证支持范围见[Windows 入门清单](getting-started.md#windows原生-powershell-51)。

准备隔离测试库（`qiwu_test` / Redis 15）、配置 `.env.local` 凭据及 `.env.test` 与可选本地覆盖 `.env.test.local` 后，可复用已有端点测试；它会通过 globalSetup 重置所选 `*_test` 库，不对开发 / 生产库执行。`pnpm.cmd` 仅随 npm / Corepack 安装存在，独立 `pnpm.exe` 使用 `pnpm`：

```powershell
pnpm.cmd --filter @qiwu/server test oauth2.e2e
if ($LASTEXITCODE -ne 0) { throw "OAuth2 tests failed" }
```

此检查不能代替第三方客户端的真实回调走查；要演示 OAuth，请用非演示安装。

## 概览

- 本系统是 OAuth2 授权服务器：授权码 + PKCE（只收 `S256`）、刷新令牌、`client_credentials`，外加令牌校验（RFC 7662）与撤销（RFC 7009）。
- 不做：OIDC（没有 `id_token`、discovery、JWKS）、`password` 与 `implicit` 授权、公共客户端。v1 只支持**机密客户端**：`/token`、`/introspect`、`/revoke` 一律要客户端密钥，用了 PKCE 也一样，所以 SPA 和原生 App 要经自己的后端接入。
- 令牌是不透明的随机串（43 个 base64url 字符），不是 JWT，第三方无法自行验签；要知道令牌是否有效，调 introspect 或直接调 userinfo。服务端只存令牌的 SHA-256 摘要。

| 端点                                 | 谁调用                        | 请求 → 响应               | 限流（每 IP）  |
| ------------------------------------ | ----------------------------- | ------------------------- | -------------- |
| `GET /sso?…`（前端路由）             | 用户的浏览器                  | 同意页                    | —              |
| `POST /api/oauth2/token`             | 第三方后端                    | 表单 → RFC 6749 原始 JSON | 600 次/分钟    |
| `POST /api/oauth2/introspect`        | 第三方后端                    | 表单 → RFC 7662 原始 JSON | 1200 次/分钟   |
| `POST /api/oauth2/revoke`            | 第三方后端                    | 表单 → 空响应体           | 1200 次/分钟   |
| `GET /api/oauth2/userinfo`           | 第三方后端（Bearer 访问令牌） | `{code, msg, data}` 信封  | —              |
| `GET` / `POST /api/oauth2/authorize` | 只由 `/sso` 页内部调用        | `{code, msg, data}` 信封  | 各 120 次/分钟 |

`/api/oauth2/authorize` 只接受本系统自己的登录会话（第三方令牌一律 401），第三方不要直接调用，把用户的浏览器带到 `/sso` 即可。

## 1. 注册客户端

在「系统管理 → 客户端管理」登记（页面 `/oauth/clients`，接口 `/api/oauth/clients`；权限 `oauth.client.{browse,view,create,modify,remove,reset-secret}`）。

| 字段                       | 规则                                                                                                                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 客户端标识（`client_id`）  | 管理员填写，`^[a-z0-9][a-z0-9._-]{2,63}$`，区分大小写，创建后不能修改；`console`、`mobile` 是保留标识（400）                                                                                                                 |
| 客户端名称、图标           | 显示在同意页上；图标（`logoUrl`）须为 https 地址或本站路径（以 `/` 开头）                                                                                                                                                    |
| 授权方式                   | `authorization_code`、`refresh_token`、`client_credentials` 至少选一项；选 `refresh_token` 必须同时选 `authorization_code`                                                                                                   |
| 回调地址（`redirect_uri`） | 选了授权码就必须登记，最多 10 个；必须 https，本机调试可用 `http://localhost` 或 `http://127.0.0.1`（可带端口）；不能有 `#`、`*`、空白、反斜杠或用户名密码。授权时**逐字符比对**（大小写、末尾 `/`、多出的查询参数都算不同） |
| 授权范围（`scope`）        | 选了授权码就必须登记；只用 `client_credentials` 时页面不强制，但不登记的话申请令牌会返回 `invalid_scope`；v1 只有 `user.read`（读取用户名、姓名、头像、语言，见 [userinfo](#24-用户信息userinfo)）                           |
| 自动授权范围               | 只能从授权范围里选；这些 scope 不需要用户同意，同意页上也不出现                                                                                                                                                              |
| 访问令牌有效期（秒）       | 300–86400，默认 1800；即响应里的 `expires_in`，不滑动续期                                                                                                                                                                    |
| 刷新令牌有效期（秒）       | 3600–2592000，默认 604800；同时是一次授权会话的**绝对上限**：从首次换码签发会话时起算，刷新不延长                                                                                                                            |
| 是否启用                   | 停用后立即失效，见下                                                                                                                                                                                                         |

- **密钥只显示一次。** 服务端生成 256 位随机密钥，创建时（以及每次"重置密钥"时）在弹窗里显示明文，之后任何接口和日志里都看不到，服务端只存它的 SHA-256 摘要。丢了只能重置；重置后旧密钥立即失效，已签发的令牌不受影响。3 秒内重复点重置 → 429。
- **停用或删除客户端**（含批量删除）会立即结束它的全部会话，包括用户授权的和 `client_credentials` 的；此后它的 refresh、introspect、revoke 都返回 `invalid_client`。删除后可以用同一个 `client_id` 重新登记，旧会话和尚未兑换的授权码不会被继承；用户对它记住的授权也随删除一并作废。
- 授权码绑定客户端数据库主键 `clientPk`，不只绑定可复用的 `client_id`。它还保存签发时用户的 `credVer`：换码时原子比较版本，防止撤销/改密与签发竞态产生新会话；会话签发后再检查客户端仍启用且未删除，否则撤销刚签发的会话。核对 [oauth-model.ts](../apps/server/src/modules/platform/oauth/provider/oauth-model.ts) 和 `oauth2.e2e` 的客户端重建、撤销后换码及签发竞态用例。
- 内置客户端 `console`（管理后台自己）只读：修改、启停、重置密钥、删除一律 422（错误码 `B4010`）。

也可以用接口登记（需要有 `oauth.client.create` 权限的后台会话；响应 201，`data.secret` 就是那唯一一次的明文密钥）：

```sh
curl -sS -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"clientId":"crm","name":"CRM","grantTypes":["authorization_code","refresh_token","client_credentials"],
       "redirectUris":["http://localhost:8080/cb"],"scopes":["user.read"],"autoApproveScopes":[]}' \
  "$BASE/api/oauth/clients"
```

## 2. 授权码 + PKCE 全流程（curl / openssl，仅 POSIX）

下面以本机 `pnpm dev` 为例（后台 `http://localhost:5173`，`/api` 由 Vite 代理到服务端）。先在客户端管理里登记一个客户端：标识 `crm`，授权方式三项全选，回调地址 `http://localhost:8080/cb`，授权范围 `user.read`，保存后记下弹窗里的密钥。本机 8080 端口上不需要真有服务：浏览器回跳时会显示"无法连接"，从地址栏里复制 `code` 即可。

```sh
BASE=http://localhost:5173                  # 生产环境换成 https://<后台域名>
CLIENT_ID=crm
CLIENT_SECRET='<创建或重置时显示的密钥>'
REDIRECT_URI=http://localhost:8080/cb        # 与登记值逐字相同
```

### 2.1 生成 PKCE 与 state

每次授权请求都生成新的一组，`VERIFIER` 留在第三方后端（例如放进用户的会话），不要发给浏览器：

```sh
VERIFIER=$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n')    # 64 个字符
CHALLENGE=$(printf %s "$VERIFIER" | openssl dgst -binary -sha256 | openssl base64 | tr '+/' '-_' | tr -d '=\n')
STATE=$(openssl rand -hex 16)
```

`CHALLENGE` = base64url(SHA-256(`VERIFIER`))，去掉 `=`，正好 43 个字符。只收 `code_challenge_method=S256`：`plain` 或省略都会被拒绝。

### 2.2 把用户带到同意页

```sh
ENC_REDIRECT=$(node -p 'encodeURIComponent(process.argv[1])' "$REDIRECT_URI")
# macOS 用 open，Linux 用 xdg-open；也可以把这条链接复制进浏览器
open "$BASE/sso?response_type=code&client_id=$CLIENT_ID&redirect_uri=$ENC_REDIRECT&scope=user.read&state=$STATE&code_challenge=$CHALLENGE&code_challenge_method=S256"
```

| 参数                    | 说明                                                              |
| ----------------------- | ----------------------------------------------------------------- |
| `response_type`         | 只能是 `code`                                                     |
| `client_id`             | 客户端标识                                                        |
| `redirect_uri`          | 必填，与登记值逐字相同；兑换令牌时还要再传一次同样的值            |
| `scope`                 | 空格分隔；省略时取客户端登记的全部 scope；超出登记范围 → 请求无效 |
| `state`                 | 可选，原样带回；用来防 CSRF，第三方回调时**必须**核对             |
| `code_challenge`        | 上一步的 `CHALLENGE`（43 个字符）                                 |
| `code_challenge_method` | 只能是 `S256`                                                     |

浏览器里会发生：

1. 没登录时先到登录页，登录后回到同一个同意页；同意页上有"切换账号"。
2. 同意页显示客户端名称、图标、申请的权限和回跳的主机名。用户点"同意授权"后，浏览器跳到
   `http://localhost:8080/cb?code=<授权码>&state=<STATE>`。
3. 用户点"拒绝"时跳到 `http://localhost:8080/cb?error=access_denied&state=<STATE>`（请求里没带 `state` 时也就没有 `state`）。
4. 同一用户在记住授权的有效期内再次授权同一客户端（或申请的 scope 全是自动授权的），同意页不再询问，直接回跳（见 [§6](#6-记住授权)）。
5. 请求本身无效（客户端未知或已停用、回调地址未登记、PKCE 缺失或为 `plain`、scope 越界、`response_type` 不是 `code`）时，页面停在 `/sso` 显示原因，**不会回跳**，以免把用户送到未经核实的地址（见 [§4.3](#43-同意页上的错误)）。

调试同意页内部请求时，使用后台自己的 `$ADMIN_TOKEN`，参数放 query，POST 的 JSON body 只有 `approve`（与 spec 的 `view`/`answer` 相同）：

```sh
AUTH_URL="$BASE/api/oauth2/authorize?response_type=code&client_id=$CLIENT_ID&redirect_uri=$ENC_REDIRECT&scope=user.read&state=$STATE&code_challenge=$CHALLENGE&code_challenge_method=S256"
curl -sS -H "Authorization: Bearer $ADMIN_TOKEN" "$AUTH_URL"
curl -sS -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"approve":true}' "$AUTH_URL"
```

GET 返回 `data.client`、`data.scopes`、`data.pending`；POST 返回 `data.redirectTo`，由前端跳转，不是 302。`approve: false` 表示拒绝。上面的 POST 会签发授权码并写入授权记录；不要与浏览器重复兑换同一码。此 curl 是开发者调试请求形状，第三方正式接入仍把用户带到 `/sso`。

登记的回调地址自带查询参数时会保留在前面，例如登记 `https://q.example/cb?tenant=7`，回跳为 `https://q.example/cb?tenant=7&code=…&state=…`。

```sh
CODE='<地址栏里的 code>'      # 有效期 300 秒，只能兑换一次
```

### 2.3 用授权码换令牌

```sh
curl -sS -u "$CLIENT_ID:$CLIENT_SECRET" \
  --data-urlencode grant_type=authorization_code \
  --data-urlencode "code=$CODE" \
  --data-urlencode "redirect_uri=$REDIRECT_URI" \
  --data-urlencode "code_verifier=$VERIFIER" \
  "$BASE/api/oauth2/token"
```

- 请求体只接受 `application/x-www-form-urlencoded`（`curl -d` / `--data-urlencode` 默认就是）；JSON 请求体，或者某个字段写成数组（`code[]=…`），一律 400 `invalid_request`。
- 客户端认证用 HTTP Basic（`-u`）或表单字段 `client_id` + `client_secret`，二选一。Basic 里的标识和密钥不做表单解码；生成的密钥只含 URL 安全字符，不受影响。

响应 200，带 `Cache-Control: no-store` 和 `Pragma: no-cache`，正好这五个字段：

```json
{
  "access_token": "<access_token>",
  "token_type": "Bearer",
  "expires_in": 1800,
  "refresh_token": "<refresh_token>",
  "scope": "user.read"
}
```

- `expires_in` 是客户端的访问令牌有效期（秒）；离授权的绝对上限不足这么久时，取剩余时间。
- 客户端没有 `refresh_token` 授权时没有 `refresh_token` 字段，这次授权在访问令牌过期时就结束了。
- `scope` 用空格分隔。

```sh
AT='<access_token>'
RT='<refresh_token>'
```

### 2.4 用户信息（userinfo）

```sh
curl -sS -H "Authorization: Bearer $AT" "$BASE/api/oauth2/userinfo"
```

响应是本系统统一的信封（不是 OIDC 的 userinfo）：

```json
{
  "code": 0,
  "msg": "ok",
  "data": {
    "sub": "1",
    "username": "admin",
    "name": "Administrator",
    "avatarUrl": null,
    "locale": null
  }
}
```

| 字段        | 说明                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `sub`       | 用户 ID（字符串），在本系统内不变，用它关联第三方的账号                                                                                     |
| `username`  | 登录名（管理员可以修改，关联账号请用 `sub`）                                                                                                |
| `name`      | 显示名                                                                                                                                      |
| `avatarUrl` | 没有头像时为 `null`。文件存在本地存储时是**本站相对路径**（`/files/…`），要拼上后台的源（`$BASE`）才能访问；用 S3 存储时是完整的 https 地址 |
| `locale`    | 用户选的界面语言（`zh-CN` / `en-US`），没选过为 `null`                                                                                      |

只返回这五项，不含手机号、邮箱、部门、角色。令牌须带 `user.read`，否则 403（`A0430`）；`client_credentials` 令牌不代表任何用户 → 403（`B4003`）；令牌无效、过期、被撤销，或用户已改密、被停用、被删除 → 401。本系统自己的后台会话也能调用，返回本人的数据。

### 2.5 刷新

```sh
curl -sS -u "$CLIENT_ID:$CLIENT_SECRET" \
  --data-urlencode grant_type=refresh_token \
  --data-urlencode "refresh_token=$RT" \
  "$BASE/api/oauth2/token"
```

响应与 §2.3 相同的五个字段，`refresh_token` 是新的。规则：

- **每次刷新都轮换**：拿到新的一对令牌后，旧的访问令牌立即失效，旧的刷新令牌只剩 30 秒宽限期，要马上换用新的一对。
- 宽限期内用**同一个 User-Agent** 重放旧的刷新令牌，拿到的是同一对新令牌（网络重试是安全的）；超过 30 秒或换了 User-Agent 再用旧的刷新令牌，视为令牌被盗用：整个会话被吊销，返回 `invalid_grant`，用户须重新走 `/sso`。所以第三方后端发请求时要用固定的 User-Agent。
- 访问令牌有效期固定为客户端的 `access_ttl_sec`，不滑动续期；整个会话的绝对上限是首次换码签发会话时的 `loginAt + refresh_ttl_sec`，不是最近一次刷新时间。刷新后访问/刷新令牌的有效期都受剩余寿命限制；到期后 `invalid_grant`，重新走 `/sso`（已记住的授权会自动通过，用户只看到一次跳转）。
- 刷新时不用带 `scope`，新令牌沿用原授权的范围；带了超出原授权的 `scope` → `invalid_scope`。此时轮换已经发生，30 秒内用原刷新令牌（不带 `scope`）重试仍然有效。
- 刷新令牌只能由签发它的客户端使用：别的客户端拿去刷新 → `invalid_grant`，原会话不受影响。

### 2.6 校验令牌（introspect，RFC 7662）

```sh
curl -sS -u "$CLIENT_ID:$CLIENT_SECRET" --data-urlencode "token=$AT" "$BASE/api/oauth2/introspect"
```

```json
{
  "active": true,
  "client_id": "crm",
  "scope": "user.read",
  "token_type": "Bearer",
  "exp": 1790000000,
  "sub": "1",
  "username": "admin"
}
```

- `exp` 是过期时间（Unix 秒）。访问令牌和刷新令牌都可以查；刷新令牌的结果没有 `token_type`；`client_credentials` 令牌没有 `sub` 和 `username`。
- 只对**本客户端**签发的有效令牌返回 `active: true`。别的客户端的令牌、后台会话的令牌、未知、过期或已撤销的令牌一律只返回 `{"active": false}`。
- `token_type_hint` 可以带，但会被忽略。缺少 `token` → 400 `invalid_request`；客户端认证失败 → 401 `invalid_client`。

### 2.7 撤销（revoke，RFC 7009）

```sh
curl -sS -i -u "$CLIENT_ID:$CLIENT_SECRET" --data-urlencode "token=$RT" "$BASE/api/oauth2/revoke"
```

- 响应 200，响应体为空。传访问令牌或刷新令牌都可以，都会结束**整个会话**（两个令牌一起失效）。
- 未知的令牌或别的客户端的令牌也返回 200，但什么都不改变。客户端认证失败 → 401 `invalid_client`。
- 用户在第三方应用里"退出登录"或"解除绑定"时调用它。

## 3. client_credentials（机器令牌）

```sh
curl -sS -u "$CLIENT_ID:$CLIENT_SECRET" --data-urlencode grant_type=client_credentials "$BASE/api/oauth2/token"
```

```json
{
  "access_token": "<access_token>",
  "token_type": "Bearer",
  "expires_in": 1800,
  "scope": "user.read"
}
```

- 只有这四个字段，没有 `refresh_token`；过期后再申请一个。
- `scope` 可选，省略时取客户端登记的全部 scope；超出登记范围 → `invalid_scope`。客户端没有 `client_credentials` 授权 → `unauthorized_client`。
- 令牌不代表任何用户：调 userinfo → 403 `B4003`，调其他需要登录的接口 → 401。v1 里还没有接受机器令牌的业务接口；可以对它做 introspect（结果没有 `sub`）和 revoke。
- 这种会话也出现在「系统监控 → 在线用户」里，但只有 root 能看到和强退。

## 4. 错误

### 4.1 `/token`、`/introspect`、`/revoke` 的错误

错误体是 RFC 6749 §5.2 的原始 JSON，例如：

```json
{ "error": "invalid_grant", "error_description": "Invalid grant: authorization code is invalid" }
```

请按 `error` 分支处理。`error_description` 是 OAuth 库给的英文诊断文字，可能没有（例如 `{"error": "invalid_request"}`），不要解析它。

| `error`                  | HTTP                                                                                                              | 何时出现                                                                                                                                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `invalid_request`        | 400                                                                                                               | 请求体不是表单（如 JSON），或字段是数组、对象；缺少必填参数；兑换时 `redirect_uri` 缺失，或与授权请求里的不逐字相同；introspect、revoke 缺少 `token`                                                                     |
| `invalid_client`         | `/token` 用表单字段认证时 400；用 HTTP Basic 时，以及 introspect、revoke 一律 401，并带 `WWW-Authenticate: Basic` | 没带密钥（用了 PKCE 也一样）、密钥错误、客户端未知、已停用或已删除、标识是 `console` / `mobile`                                                                                                                          |
| `invalid_grant`          | 400                                                                                                               | 授权码不对、过期（300 秒）、已经用过、属于别的客户端，`code_verifier` 不对或缺失；授权后用户改了密码、被停用或被强退；客户端已不再登记这个回调地址；刷新令牌无效、过期、轮换后被重放、属于别的客户端，或授权已到绝对上限 |
| `unauthorized_client`    | 400                                                                                                               | 客户端没有登记这种授权方式                                                                                                                                                                                               |
| `unsupported_grant_type` | 400                                                                                                               | `password`、`implicit` 或未知的 `grant_type`（即使客户端行里写了也不支持）                                                                                                                                               |
| `invalid_scope`          | 400                                                                                                               | `client_credentials` 申请的 scope 超出登记范围；刷新时的 scope 超出原授权                                                                                                                                                |

- 兑换失败（码不对、verifier 不对、`redirect_uri` 不一致）会**作废这个授权码**，只能让用户重新走一遍 `/sso`。
- 全局守卫或内部错误使用本系统错误信封 `{"code", "msg", "data": null, "traceId"}`，不是 RFC JSON：超出限流时 429（`A0429`，见 [§5](#5-限流)），演示模式阻断时 403（`A0431`），Redis 失联/内部错误时 500（`A0500`，`msg` 不含内部细节，凭 `traceId` 查日志）。客户端应先按 HTTP 状态与响应形状区分，再处理 RFC `error`。

### 4.2 回调地址上的错误

第三方回调只会收到两种结果：`?code=…&state=…`（同意），或 `?error=access_denied&state=…`（用户拒绝）。其他错误都不回跳，见下一节。

### 4.3 同意页上的错误

`/sso` 把查询串原样交给 `GET /api/oauth2/authorize` 检查。请求无效时页面停在 `/sso`，显示服务端返回的原因，不跳转。排查接入问题时，可以对照 `/api/oauth2/authorize` 返回的错误码：

| 错误码         | 情形                                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `B4001`（400） | 客户端未知、已停用、是第一方（`console` / `mobile`）或没有授权码授权；`redirect_uri` 不是登记值之一（逐字比对）   |
| `B4002`（400） | `response_type` 不是 `code`；`scope` 为空，或超出客户端登记的范围                                                 |
| `A0401`（400） | 参数格式不对：缺少 `redirect_uri`，缺少 `code_challenge` 或长度不是 43，`code_challenge_method` 缺失或不是 `S256` |
| `A1004`（403） | 当前登录的账号必须先修改密码                                                                                      |

## 5. 限流

| 端点                          | 上限（每个来源 IP） |
| ----------------------------- | ------------------- |
| `POST /api/oauth2/token`      | 600 次/分钟         |
| `POST /api/oauth2/introspect` | 1200 次/分钟        |
| `POST /api/oauth2/revoke`     | 1200 次/分钟        |
| `GET /api/oauth2/authorize`   | 120 次/分钟         |
| `POST /api/oauth2/authorize`  | 120 次/分钟         |

- 超出后返回 429 错误信封（`code: "A0429"`），不是 RFC JSON。
- 按 `req.ip` 计数：部署在反向代理后面时，必须把 `TRUST_PROXY` 设成代理的地址，否则所有第三方共用代理这一个 IP 的额度（见 [deploy.md](deploy.md#oauth2-与单点登录)）。
- 计数存于 Redis，多实例共享同一路由与 IP 的额度，GET/POST authorize 分别计数。Redis 出错时返回 500 `A0500`，不回退内存或放行，见 [共享限流](scale-out.md#共享限流)。
- 第三方后端通常只有一个出口 IP，所以上限按"一个后端的正常流量"定。资源服务器如果每个请求都 introspect，可以按令牌把结果缓存几秒；代价是令牌被撤销后，最多还会被接受这么久。

## 6. 记住授权

- 用户同意时，本次申请的全部 scope 一次记住（自动授权的 scope 不需要记），保留天数由参数 `oauth.consent_ttl_days` 决定（「系统管理 → 参数设置」里的"记住授权天数（0 = 每次询问）"，默认 30）。同意页上没有"记住授权"勾选框。
- 有效期内同一用户再授权同一客户端、且申请的 scope 都已记住或属于自动授权时，`/sso` 不再询问，直接回跳。每次同意都会把有效期续满；每个客户端分开记。
- 参数设为 `0`：不再记录，已经记住的也不再生效，每次都问。
- 删除用户或删除客户端时，相关的授权记录一并作废。v1 没有让用户自己撤回授权的页面；需要时停用或删除客户端，或把参数设为 `0`。
- 同意动作记入动作日志（领域 `oauth.consent`，动词 `grant`，业务 ID 为 `client_id`）；返回结果里的 `redirectTo` 被打码，授权码不会进日志。

## 7. 令牌隔离与会话

第三方令牌和后台的登录会话是同一套会话机制，但能走的路完全分开：

- 第三方令牌（授权码换来的和 `client_credentials` 的）只能调用 `GET /api/oauth2/userinfo`；调后台其他需要登录的接口（如 `/api/iam/users`、`/api/auth/me`）一律 401。
- 后台的 `/api/auth/refresh` 不接受 OAuth 的刷新令牌（401），第三方的会话也不受影响。
- `/api/oauth2/authorize` 只接受后台自己的登录会话，第三方令牌一律 401，所以客户端没法替用户点"同意"。
- `console`、`mobile` 是本系统自己的客户端标识：就算表里有这样命名的第三方行，`/token` 也当它不存在（`invalid_client`）。
- introspect 对后台会话的令牌也只回答 `{"active": false}`。

第三方会话出现在「系统监控 → 在线用户」里（"客户端"一列为它的 `client_id`，可按客户端筛选），强退后令牌立即失效。`client_credentials` 的会话只有 root 能看到和强退；其他有在线用户权限的操作员只能看到用户授权的会话。

令牌在下列情况失效：

| 情况                                  | 结果                                                                             |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| 访问令牌过期                          | 用刷新令牌换新的一对                                                             |
| 授权到达绝对上限（`refresh_ttl_sec`） | `invalid_grant`，重新走 `/sso`                                                   |
| 第三方调用 revoke                     | 整个会话结束                                                                     |
| 旧刷新令牌在宽限期外被重放            | 整个会话结束                                                                     |
| 用户改密码、被停用、被删除，或被强退  | 该用户的全部 OAuth 会话和尚未兑换的授权码一并失效                                |
| 管理员在在线用户页强退某个会话        | 该会话结束                                                                       |
| 客户端被停用或删除                    | 它的全部会话立即结束；之后它的 refresh、introspect、revoke 返回 `invalid_client` |
| 重置客户端密钥                        | **不**影响已签发的令牌；只是旧密钥再也不能认证                                   |

日志：`/token`、`/introspect`、`/revoke` 不记动作日志（没有操作用户）；请求日志按字段名把密钥、授权码和令牌打码。

## 8. 部署

- `/sso` 是前端路由：反向代理对它要做 SPA 回退（返回 `index.html`），否则用户直接打开授权链接会得到 404。见 [deploy.md](deploy.md#oauth2-与单点登录)。
- `/api/oauth2/token`、`/introspect`、`/revoke`、`/userinfo` 由第三方的后端直接调用（服务器到服务器），不需要 CORS；不要让浏览器里的代码调用 `/token`，那样就得把密钥放进浏览器。
- 生产环境的回调地址必须是 https；`http://localhost` / `http://127.0.0.1` 只用于本机调试。
- 限流按来源 IP 计数，反向代理后面要正确设置 `TRUST_PROXY`（见 [§5](#5-限流)）。
- 多实例已使用 Redis 限流存储与 Socket.IO Redis 分片适配器；前置条件和当前限制统一见 [scale-out.md](scale-out.md)。Redis ≥ 7，实例同库同频道前缀、订阅异步就绪；本地文件须共享卷或 S3。不支持连接状态恢复，推送丢失后须刷新/补拉。

## 9. 第三方接入清单

1. 客户端密钥只放在第三方的服务端，不进浏览器、App 或代码仓库；泄露了就去客户端管理里重置。
2. 每次授权请求都生成新的 `code_verifier` 和 `state`；回调时先核对 `state`，再用同一个 `code_verifier` 兑换。
3. 回调地址按登记值逐字使用：授权请求和兑换令牌传的 `redirect_uri` 必须完全一样。
4. 拿到授权码马上兑换（300 秒内，只能用一次；兑换失败的码也会作废）。
5. 刷新令牌加密存在服务端；刷新后立刻换用新的一对令牌；后端发请求用固定的 User-Agent。
6. 刷新返回 `invalid_grant` 时，让用户重新走 `/sso`（已记住的授权会自动通过）。
7. 用 `sub` 关联账号，不要用 `username`；`avatarUrl` 是相对路径时拼上后台的源。
8. 用户在第三方退出登录或解除绑定时，调用 revoke。
9. 按 `error` 处理错误，不要解析 `error_description`；遇到 429 稍后重试。
10. 使用非演示安装走查；核对客户端停用/删除、同标识重新注册、撤销后的授权码及第三方令牌隔离，不能只测试成功换码。

## 10. 上线前自检

- [ ] 在非演示环境用真实注册的机密客户端完成 S256 授权码、userinfo、刷新、introspect 与 revoke；记录各请求形状、HTTP 状态和响应体种类，不记录真实 secret/token。
- [ ] 核对第三方令牌访问后台为 401、机器令牌访问 userinfo 为 403，客户端停用/删除和重建不能继承旧会话/授权码。
- [ ] 演示模式四个 POST 返回 403 `A0431`；按 IP 的 600/1200/1200 及 authorize 各 120 的额度与 Redis 失败边界符合文档。
