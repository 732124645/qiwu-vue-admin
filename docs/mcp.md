# 智能体接入（MCP）

栖梧可以作为 [Model Context Protocol](https://modelcontextprotocol.io/)（MCP）服务端，让智能体以某个用户的身份调用后台能力。模板只提供底座与四个示例工具；项目自己的工具按[下文的写法](#给自己的模块加工具)添加。协议实现使用官方 SDK `@modelcontextprotocol/sdk`（MIT）。

协议回归见 [mcp-core.e2e-spec.ts](../apps/server/test/e2e/mcp-core.e2e-spec.ts)，认证见 [mcp-auth.e2e-spec.ts](../apps/server/test/e2e/mcp-auth.e2e-spec.ts)，护栏见 [mcp-guard.e2e-spec.ts](../apps/server/test/e2e/mcp-guard.e2e-spec.ts)，示例工具见 [mcp-tools.e2e-spec.ts](../apps/server/test/e2e/mcp-tools.e2e-spec.ts)，用 SDK 自带客户端端到端连接见 [mcp-client.e2e-spec.ts](../apps/server/test/e2e/mcp-client.e2e-spec.ts)，开关关闭见 [mcp-switch.e2e-spec.ts](../apps/server/test/e2e/mcp-switch.e2e-spec.ts)。

## 启用

两层开关：

| 开关                     | 位置                                         | 作用                                                                                                                                                                      |
| ------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_MCP`                | 服务端环境变量，默认 `false`                 | 只在启动时读取，切换须全部实例重启。关闭时模块不加载：`/api/mcp`、`/.well-known/oauth-*` 与全部管理接口回 404，工具不注册，侧栏与角色授权树不显示“MCP 工具”“访问令牌”两页 |
| `mcp.paused`（系统参数） | 系统参数页，默认 `false`，**只有 root 能改** | 运行中的急停：为 `true` 时所有 `tools/call` 立即回“已暂停”（`tools/list` 照常、令牌保留），改回 `false` 即恢复；经参数缓存失效对所有实例生效                              |

更细的控制：平台页“MCP 工具”可以整体停用某个工具（对所有租户与令牌生效；每个实例缓存停用列表 5 秒，保存的那个实例立即生效），任何令牌都可以随时吊销。

表 `iam_access_token`（个人访问令牌）与 `cfg_mcp_tool`（工具停用记录）始终由迁移创建，打开开关不需要额外迁移。反向代理还要转发发现文档，见 [deploy.md](deploy.md#智能体接入mcp)。

## 端点与协议

| 端点                                                  | 说明                                                                                                                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/mcp`                                       | MCP Streamable HTTP，无状态（不发 `Mcp-Session-Id`），应答为 JSON；只声明 tools 能力：`initialize`、`tools/list`、`tools/call`（及协议自带的 `ping`） |
| `GET /api/mcp`、`DELETE /api/mcp`                     | 405：无状态服务不提供 SSE 推送流，也没有会话可删                                                                                                      |
| `GET /.well-known/oauth-protected-resource[/api/mcp]` | 受保护资源元数据（RFC 9728）                                                                                                                          |
| `GET /.well-known/oauth-authorization-server`         | 授权服务器元数据（RFC 8414），指向本站的 `/sso` 同意页与 `/api/oauth2/token`                                                                          |

资源、提示词、采样、补全都不提供，`resources/list` 等回 JSON-RPC `-32601`。JSON-RPC 批量请求（一个 POST 里的数组）回 400 与 `-32600`：当前协议版本已取消批量，每个请求只处理一条消息。协议处理中的意外错误只回 `-32603 Internal error`，详情只进服务端日志。请求头 `Accept` 须同时含 `application/json` 与 `text/event-stream`（SDK 客户端自动发送）。浏览器发来的请求若 `Origin` 不是本站或 `CORS_ORIGIN` 中的源，回 403（防 DNS 重绑定）。

身份与租户只来自校验过的令牌，不读任何请求头选择租户。

## 认证

两种令牌都按**令牌所属用户本人**的权限点、数据权限与租户运行，与该用户在控制台操作时相同；角色或菜单授权变化立即生效。平台人员“进入租户”的状态不经 MCP 使用：控制台会话不是 MCP 令牌，平台人员的个人令牌始终在其本人租户里运行。root 与受保护用户的规则不变（root 的令牌拥有 root 的全部权限，请谨慎签发）。

没有令牌或令牌无效（未知、过期、已吊销、用户停用等）时回 401，并带：

```http
WWW-Authenticate: Bearer resource_metadata="https://qiwu.example.com/.well-known/oauth-protected-resource/api/mcp", scope="mcp"
```

### 个人访问令牌

用户在个人中心“访问令牌”里自建（`POST /api/mcp/my-tokens`），必须再输入一次当前密码（连续输错与锁屏验密同一计数，达到阈值结束该用户全部会话）：

- 令牌形如 `qwmcp_` + 43 位随机字符，**只在创建时显示一次**；库里只存 SHA-256 摘要和末 4 位。
- 可选有效期 1–90 天，不填为不过期；每个用户最多保留 20 个有效令牌（计数与插入在锁住用户行的同一事务里，并发新建也不会越过上限）。
- 可勾选允许的工具，候选来自 `GET /api/mcp/my-tools`（本人此刻能用的工具）；不选为全部工具，**以后新增的工具也自动包含**；写入类工具还须勾选“允许写入”，不允许写入时只能用只读工具。列出了写入类工具却不允许写入的令牌建不出来（403 `B7003`）。
- 验密之前先读用户的凭据版本，令牌写入后再比较：期间用户被改密、重置或停用（其令牌已被吊销）时，刚建的令牌被删掉并回 409 `A0490`，与登录签发会话的做法相同。
- 令牌写入后还会重新读一次租户：期间租户被停用或已到期（停用时该租户的令牌已被吊销）时同样删掉并回 409，令牌不会在租户重新启用后复活。
- 本人随时吊销；租户管理员（`mcp.token.browse` / `mcp.token.revoke`）可查看并吊销本租户全部令牌。吊销立即生效且不可恢复。
- 以下情况令牌永久失效，与会话吊销同一机制：用户停用、删除、修改或重置密码、管理员强制下线该用户、密码试错锁定；租户停用或到期时间提前到当前之前。即使 `APP_MCP` 当时关着也同样吊销。换手机号、解绑微信不影响令牌。

### OAuth2

复用现有 [OAuth2 提供方](oauth2.md)（授权码 + PKCE S256，仅机密客户端）。管理员在“OAuth2 客户端”页登记智能体的后端，勾选范围：

| 范围        | 作用                                                                      |
| ----------- | ------------------------------------------------------------------------- |
| `mcp`       | 令牌的受众是 MCP 资源：只有带它的令牌被 `/api/mcp` 接受，只能调用只读工具 |
| `mcp.write` | 与 `mcp` 一起：还可以调用写入类工具                                       |

第三方令牌在其余管理接口上照旧 401；控制台会话与 `client_credentials` 令牌（不代表任何用户）都不能调用 MCP。授权请求与令牌请求可带 RFC 8707 的 `resource` 参数：发了就必须是本站的 MCP 端点 URL（`https://<本站>/api/mcp`，以请求到达的域名计，租户绑定的域名各自是一个资源），且申请的范围含 `mcp`，否则授权请求回 400 `B4002`、令牌请求回 `invalid_target`。

不支持动态客户端注册，也不服务公开客户端（没有客户端密钥的 PKCE 客户端）。多数桌面智能体客户端依赖这两项完成 OAuth，对它们请使用个人访问令牌。

## 客户端配置示例

任何支持 Streamable HTTP 传输与自定义请求头的 MCP 客户端都可以连接，以个人访问令牌为例。常见的 JSON 配置格式：

```json
{
  "mcpServers": {
    "qiwu": {
      "type": "http",
      "url": "https://qiwu.example.com/api/mcp",
      "headers": { "Authorization": "Bearer qwmcp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }
    }
  }
}
```

用 curl 检查（macOS / POSIX 终端）：

```sh
curl -sS https://qiwu.example.com/api/mcp \
  -H "Authorization: Bearer $QW_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"iam.me.get","arguments":{}}}'
```

在自己的程序里用 SDK 客户端：

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const client = new Client({ name: 'my-agent', version: '1.0.0' })
await client.connect(
  new StreamableHTTPClientTransport(new URL('https://qiwu.example.com/api/mcp'), {
    requestInit: { headers: { Authorization: `Bearer ${process.env.QW_TOKEN}` } },
  }),
)
const { tools } = await client.listTools()
const me = await client.callTool({ name: 'iam.me.get', arguments: {} })
await client.close()
```

## 示例工具

| 工具               | 类型 | 权限点             | 说明                                                                                     |
| ------------------ | ---- | ------------------ | ---------------------------------------------------------------------------------------- |
| `iam.me.get`       | 只读 | 无（任何登录用户） | 令牌所属用户本人：用户名、姓名、部门、角色、岗位、语言                                   |
| `iam.user.search`  | 只读 | `iam.user.browse`  | 按关键字、部门、状态查用户，每页最多 50 条；与用户列表同一查询，数据权限与手机号遮蔽一致 |
| `cfg.dict.options` | 只读 | 无（任何登录用户） | 一个已启用字典的选项，标签按请求语言（`Accept-Language`，否则用户的语言）                |
| `demo.book.create` | 写入 | `demo.book.create` | 示例图书新建一本：与新增接口同一服务，部门数据权限、唯一性、创建人与页面新建一致         |

管理页面优先展示当前语言的工具名称、用途与权限名称，协议工具标识仍作为辅助信息保留。中文工具说明只改变页面展示，不改变客户端的工具标识、权限码或执行规则；未知扩展工具保留原文。

`tools/list` 只列调用者此刻能用的工具：工具启用、令牌允许、写入许可与权限点都满足（套餐与平台权限点的规则见下文）。

## 给自己的模块加工具

工具就是一个 provider 的方法加 `@McpTool`。方法像控制器一样在调用者的租户、权限与数据权限下运行（CLS 里的 principal），所以直接调用模块已有的服务即可：权限点检查、限流、超时、输出裁剪与操作日志由底座统一做。

以一个项目模块 `crm/customer` 为例（`customerPerms` 在 `packages/shared/src/crm/customer.schema.ts`，`CustomerService` 是生成器生成的服务）：

```ts
// apps/server/src/modules/crm/customer/customer.mcp-tools.ts
import { Injectable } from '@nestjs/common'
import { customerPerms } from '@qiwu/shared'
import { z } from 'zod'
import { McpTool } from '../../../core/mcp/mcp-tool.js'
import { CustomerService } from './customer.service.js'

const findInput = z.object({
  name: z.string().trim().max(64).optional().describe('part of the customer name'),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(50).default(20),
})

const findOutput = z.object({
  total: z.number().int(),
  items: z.array(z.object({ id: z.number().int(), name: z.string(), level: z.string() })),
})

@Injectable()
export class CustomerMcpTools {
  constructor(private readonly customers: CustomerService) {}

  /** 按名称查客户：与客户列表同一查询，数据权限一致。 */
  @McpTool({
    name: 'crm.customer.search',
    title: 'Search customers',
    description:
      'Finds customers the caller may see by part of their name; one page with the total.',
    perm: customerPerms.browse,
    kind: 'read',
    input: findInput,
    output: findOutput,
  })
  async search(input: z.output<typeof findInput>) {
    const { items, total } = await this.customers.page({ ...input })
    return { total, items }
  }
}
```

再把 `CustomerMcpTools` 加进该模块的 `providers`（生成的模块文件会被生成器覆盖时，像 `apps/server/src/modules/demo/book/book.mcp-tools.ts` 那样单独建一个小模块，再在 `modules/project.module.ts` 里注册）。启动即注册，不需要迁移或菜单。

声明规则（启动时检查，任何一条不满足都拒绝启动）：

- `name` 全局唯一，写成 `<domain>.<resource>.<verb>`，小写字母、数字与连字符，最长 96 个字符。
- `perm` 必须是共享包某个 `*Perms` 常量里的权限点；只有任何登录用户都能读的数据（本人资料、字典标签）才写 `null`。
- `input` 是 zod 对象 schema：调用前校验（失败时工具回 `A0401` 并列出字段），同时生成给智能体的 JSON Schema，所以请给字段写 `.describe()`。
- `output` 可选，也是 zod 对象 schema：结果按它解析（多余字段被丢掉，免得把内部字段交给智能体）并作为结构化内容返回；不符合时按内部错误处理。
- `kind: 'write'` 的工具只对明确允许写入的令牌开放；会改数据的工具一律声明为写入类。
- `timeoutMs` 可选，默认 30 秒，最长 120 秒。
- `sensitive` 可选：名称普通但值可能是秘密的参数名（如 `note`），在操作日志里任意深度遮蔽为 `***`，同路由上的 `@Sensitive`；名称像密钥的参数本来就遮蔽。
- `feature` 可选：工具所属的顶层菜单组（路由名，如 `workflow`）。租户套餐不含该组时，该租户的用户用不了这个工具，同 `@RequireFeature`。

租户与套餐：带 `perm` 的工具随租户套餐收窄（别的租户的用户只持有套餐里的权限点）。`perm: null` 的工具**不受套餐限制**，所有租户的用户都能用；只想给某些套餐用时声明 `feature`。挂在平台页权限点上（菜单在 `PLATFORM_ONLY_ROUTES` 下）的工具只给默认租户的用户，同 `@PlatformOnly()`，别的租户调用回 `A0430`。

工具里抛出的业务错误（`BizError`、404、409 等）按请求语言翻译后作为工具错误返回；其他异常只回 `A0500`，详情只进服务端日志。

## 护栏与审计

`tools/call` 依次检查，任何一步不通过都作为工具错误（`isError: true`，文本为 `{"code","message"}`）返回，未知工具是 JSON-RPC `-32602`：

1. 每个令牌每分钟 60 次（所有实例合计，复用现有限流存储）→ `A0429`；此外 `POST /api/mcp` 按来源 IP 每分钟 600 次
2. `mcp.paused` 急停 → `B7010`
3. 原始参数嵌套超过 32 层或 JSON 超过 16 KiB → `A0401`（不校验、不运行）
4. 工具已在平台页停用 → `B7011`
5. 令牌未列出该工具 → `B7012`；写入类工具而令牌不允许写入 → `B7003`
6. 调用者没有工具的权限点、套餐不含工具的 `feature`，或别的租户调用平台权限点上的工具 → `A0430`
7. 参数校验 → `A0401`
8. 在时限内运行 → 超时 `B7014`
9. 输出裁剪：按输出 schema 解析，名称像密钥的字段（任何位置含 `pass`、`pwd`、`otp`、`verifier`、`ticket`、`token`、`secret`、`apiKey`、`privateKey`、`credential`，或以 `accessKey`、`sessionKey`、`signingKey`、`encryptionKey`、`appKey` 结尾…）一律遮蔽为 `***`，超过 64 KiB → `B7013`。这条规则比日志脱敏窄：单独的 `code`、`key` 不遮蔽（字典编码、业务键正是智能体要的）

每次调用（包括被拒的）记一条操作日志：模块 `mcp.tool`、动作 `call`（“智能体调用”）、业务 id 为工具名；参数里有 `agent: true`、凭据类型（`access-token` / `oauth`）与 id、参数摘要（以 `APP_SECRET` 派生的密钥做 HMAC-SHA256：相同调用摘要相同，读日志的人却无法靠穷举还原被遮蔽的密码等参数）与脱敏截断后的参数；写入类工具成功时也记结果。参数在任何检查之前就按上面的深度与大小序列化并求摘要，所以日志行不会因参数无法序列化而丢失；超限的调用记一行不含原始参数（摘要为 null）的拒绝。限流拒绝每个令牌每分钟只记第一次（限流在急停之前，急停期间的重试也一样），免得被拒的调用刷满日志。工具内部调用的服务不再另记操作日志，被修改的数据行照常记创建人 / 修改人为令牌所属用户。

写入类工具超时：智能体立即收到 `B7014`，但已开始的工作无法中断，可能随后提交。这种调用的日志行在后台等工具真正结束（最多 5 分钟）后才写，参数里带 `timedOut: true`：工具最终成功则记为成功并带结果（数据已写入），失败记实际的错误，5 分钟仍未结束记超时。智能体收到超时后应先查询再决定是否重试。只读工具超时照常立即记为失败。

## 管理接口

给前端页面用的接口（类型与 schema 见共享包 `packages/shared/src/platform/mcp/mcp.schema.ts`）：

| 方法与路径                           | 权限                        | 说明                                             |
| ------------------------------------ | --------------------------- | ------------------------------------------------ |
| `GET /api/mcp/tools`                 | `mcp.tool.browse`（平台页） | 已注册工具：名称、标题、说明、类型、权限点、启用 |
| `PUT /api/mcp/tools/:name/enabled`   | `mcp.tool.modify`（平台页） | 整体停用 / 启用一个工具                          |
| `GET /api/mcp/my-tools`              | 登录即可（本人）            | 本人此刻能用的工具（启用且有权限），建令牌时挑选 |
| `GET /api/mcp/my-tokens`             | 登录即可（本人）            | 本人的令牌（含已吊销、已过期），不含令牌本身     |
| `POST /api/mcp/my-tokens`            | 登录即可（本人）            | 新建，需当前密码；应答里的 `token` 只此一次      |
| `POST /api/mcp/my-tokens/:id/revoke` | 登录即可（本人）            | 吊销本人的令牌                                   |
| `GET /api/mcp/tokens`                | `mcp.token.browse`          | 本租户全部令牌（分页，可按用户、名称、状态筛选） |
| `POST /api/mcp/tokens/:id/revoke`    | `mcp.token.revoke`          | 吊销本租户的令牌                                 |

`APP_MCP` 关闭时这些接口都是 404，前端据此隐藏个人中心的访问令牌页签。

## 已知上限

- 超时只结束等待并回错误，已经开始的数据库操作无法中断；写入类工具应保持单次短事务（其日志按实际结果补记，见上文）。
- 无状态服务：没有服务端推送（`notifications/tools/list_changed` 等），工具列表变化后由客户端重新 `tools/list`。
- 不支持动态客户端注册与公开客户端；OAuth 只服务能保管客户端密钥的后端。
- 参数与结果按键名脱敏：名称里含 `key`、`token`、`pass` 等词的字段在操作日志里显示为 `***`（例如 `keyword`），这是有意的保守规则。
- 演示模式（`APP_DEMO_MODE=true`）拦截 `POST /api/mcp`，与其他写接口一样。
- 令牌的权限随用户当前权限变化；租户套餐收窄后，令牌能用的带权限点的工具也随之收窄，`perm: null` 的工具只在声明了 `feature` 时随套餐收窄。
