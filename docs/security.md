# 安全基线、配置与验证边界

本文列出当前防护、配置责任、测试入口和限制，包括生产凭据标记、存储目标重填、演示写入限制与共享限流。部署命令及完整 SPA CSP 见 [deploy.md](deploy.md)，OAuth 协议见 [oauth2.md](oauth2.md)，流程归属见 [bpm.md](bpm.md)。

测试源码用于核对防护契约；部署方应在自己的隔离环境执行相应检查，并保留结果。静态检查不能代替数据库、浏览器、外部服务与生产部署验证。

## 生产配置与凭据

[EnvSchema](../apps/server/src/core/config/env.schema.ts) 启动时检查配置；`APP_SECRET` 至少 32 字符。`NODE_ENV=production` 时，`APP_SECRET`、`SEED_ADMIN_PASSWORD` 只要包含 `not-for-production`（不区分大小写）就拒绝启动；`db:seed` / `db:migrate` 复用同一检查，在建立数据库连接前以非零状态退出且不输出凭据值。development/test 仍允许夹具。证据：[core-config.spec.ts](../apps/server/test/core/core-config.spec.ts)。这个检查只识别测试标记，不衡量随机性、不排除所有弱密码；部署方仍需提供独立随机密钥与管理员凭据。

数据库/Redis 凭据、`APP_SECRET`、管理员初始密码及微信密钥只进入 git 忽略的 `apps/server/.env.local` 或进程环境。提交的 `.env.example` 是配置样例，不含真实凭据；开发 `.env` 不定义秘密键，空值同样会遮住 `.env.local`。任何秘密都不能放入 `VITE_*`。各服务实例的 `APP_SECRET` 应一致；SecretBox 密钥轮换尚未实现，不能直接更换密钥后承诺旧密文可读。

| 配置                                        | 默认与部署责任                                                  | 证据/限制                                                                                                   |
| ------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `ALLOW_PRIVATE_ENDPOINTS`                   | 默认 `false`，样例保持关闭；仅隔离的本机开发/测试按需启用       | `true` 同时绕过私网地址与端口检查，不是生产内网例外清单；启动配置不会因 production 自动禁止它，部署方须核对 |
| `OUTBOUND_S3_PORTS` / `OUTBOUND_SMTP_PORTS` | 部署者在 env 登记额外端口；管理表单不能修改白名单               | 默认 S3 80/443、SMTP 25/465/587，DNS/实际连接仍执行地址检查                                                 |
| `HOST` / `TRUST_PROXY`                      | 默认绑定 `127.0.0.1`，默认只信 `loopback`；生产只信实际代理地址 | 代理覆盖 XFF，Nest 端口只对代理开放；错误信任任意来源或整个私网会使 IP 限流、验证码绑定和黑名单可绕过       |
| `SWAGGER_ENABLED`                           | 默认 `false`；生产关闭                                          | 文档端点与菜单同时隐藏，但隐藏文档不代替 API 鉴权                                                           |
| `APP_DEMO_MODE`                             | 默认 `false`；公开演示明确设 `true`                             | 按下节精确豁免，所有身份包括 root 都受限制；它允许部分持久写入，不是数据库只读开关                          |

## 演示模式的精确豁免

[DemoModeGuard](../apps/server/src/core/guard/demo-mode.guard.ts) 在 AuthGuard/PermGuard 之前检查真实 HTTP 方法与匹配路由模板。GET、HEAD 通过演示检查后仍受原有登录、权限和数据范围约束；OPTIONS 由路由框架处理或得到 404，不以它推断写接口放行。

当前只有以下 **13 条写路由**通过演示检查，随后仍执行原有验证、限流及属主检查：

| 用途           | 精确方法与路由模板                            |
| -------------- | --------------------------------------------- |
| 登录           | `POST /api/auth/login`                        |
| 登出           | `POST /api/auth/logout`                       |
| 刷新令牌       | `POST /api/auth/refresh`                      |
| 锁屏验密       | `POST /api/auth/verify-password`              |
| 验证码校验     | `POST /api/auth/captcha/check`                |
| 本人语言       | `PUT /api/iam/profile/locale`                 |
| 本人偏好保存   | `PUT /api/iam/profile/prefs/:key`             |
| 本人偏好删除   | `DELETE /api/iam/profile/prefs/:key`          |
| 公告全部已读   | `POST /api/messaging/bulletins/feed/read-all` |
| 公告单条已读   | `POST /api/messaging/bulletins/feed/:id/read` |
| 站内信全部已读 | `POST /api/messaging/inboxes/mine/read-all`   |
| 站内信单条已读 | `POST /api/messaging/inboxes/mine/:id/read`   |
| 本人抄送已读   | `POST /api/wf/ccs/:id/read`                   |

其它写路由返回 HTTP 403、`A0431` 错误信封，包括注册、短信、改密/头像、上传、代码生成写入、任务执行、审批动作、`POST /api/demo/realtime/send` 和 OAuth 的 `POST /api/oauth2/{authorize,token,introspect,revoke}`。`@Public()`、`@SkipActionLog()`、路径前缀或 root 身份都不能豁免；新写路由默认拒绝。要演示 OAuth，请用非演示安装。WebSocket 握手仍鉴权，服务器仍可推送；当前没有客户端入站 `@SubscribeMessage` 业务处理器。

证据：[demo-mode.e2e-spec.ts](../apps/server/test/e2e/demo-mode.e2e-spec.ts) 遍历全部已注册控制器并核对精确清单、无元数据/前后缀/请求头绕过，以及本人偏好、已读、登录、cookie、限流与 Socket。演示种子只对新插入的指定演示账号跳过首次改密，不修改既有账号，也不在守卫里清空会话密码标志；`seed-idempotent.spec.ts` 覆盖这一边界。

## 威胁、防护与测试入口

每行的测试需在与开发/演示隔离的测试环境运行；测试加载器会重置对应测试数据库。

| 威胁           | 当前防护与配置                                                                                                                                                  | 测试证据入口                                                                                                                                     | 限制/接入责任                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| SQL 注入       | 参数化值、排序/标识符白名单，架构检查拦截 SQL 拼接；不提供粘贴 DDL 建表接口                                                                                     | `scripts/arch/no-sql-concat.mjs`；认证安全回归矩阵的非法排序/SQL 文本；`data-scope.e2e`、`iam-user.e2e`                                          | 新 raw SQL 仍需逐句检查参数与软删除条件，不能只依赖扫描                                                                  |
| IDOR           | `scopedQb`、`lockScopedIds`、`assertWritableScope`；文件/工作流/收件箱独立归属检查；会话列表与强退按范围，保护 root                                             | 认证安全回归矩阵、`data-scope.e2e`、`session.e2e`、`wf-detail.e2e`、`wf-decide.e2e`、`storage.e2e`、`messaging-inbox.e2e`                        | 范围外一般 404；存储私有下载保留 403 契约。新项目的子资源、引用和批量动作都要接入检查，见 [data-scope.md](data-scope.md) |
| XSS            | Vue 转义；富文本在服务端和显示前清洗，`v-html` 有白名单；站内信纯文本、邮件预览 sandbox；表单 schema 双端深度白名单                                             | 输入安全回归矩阵、`core-sanitize`、shared `form-schema.spec.ts`、web `code-viewer.spec.ts`；浏览器 `login.spec.ts`、`menu-page.spec.ts` 核对 CSP | SPA CSP 唯一来源为 `apps/web/csp.ts`；正式反代必须下发完整策略。Element Plus 需要内联样式，外链 iframe 仍须评估目标      |
| 令牌混用       | 第一方 `console/mobile` 与第三方隔离；第三方仅可进入标 `@OAuthScope` 的端点，机器令牌无用户 principal                                                           | `oauth2.e2e`、认证安全回归矩阵、`core-realtime.e2e`                                                                                              | 第三方用户令牌还需 `user.read`；机器令牌调用 userinfo 为 403，后台与 Socket 拒绝第三方令牌                               |
| SSRF           | 出站地址/端口守卫在保存和实际连接时检查；DNS 解析后连接检查过的 IP，保留原域名 SNI；拒绝私网、回环、链路本地、CGNAT、元数据段、IPv6 映射；DNS/连接静默预算 5 秒 | `core-net-guard`、`storage-s3-client`、输入安全回归矩阵的 DNS/SMTP/S3 路由用例                                                                   | `ALLOW_PRIVATE_ENDPOINTS=true` 会关闭地址和端口限制；不做 UI 参数。5 秒是网络等待预算，不是整项批量业务的 SLA            |
| CSRF           | access 走 Authorization 头；控制台 refresh 使用 HttpOnly、SameSite=Strict、限定 Path 的 cookie，并检查 Origin                                                   | `core-auth.e2e`、认证安全回归矩阵、`demo-mode.e2e`                                                                                               | 移动端 refresh 走 body 且只接受 mobile 会话；代理 Proto/Host 必须可信，CORS 不能替代 Origin 检查                         |
| 暴力破解       | IP 限流；登录失败用户名/IP 分桶，锁用户名+IP 对；未知账号假哈希；当前密码校验共享用户计数、达阈值撤销；验证码单次绑定 scene/IP，OTP 有尝试与发送上限            | `core-auth.e2e`、`profile.e2e`、`captcha.e2e`、`sms.e2e`、认证安全回归矩阵                                                                       | 依赖正确的 TRUST_PROXY；限流只约束登记的路由，不代替网络层容量防护                                                       |
| 同出口多人限流 | 当前 `@RateLimit` 按 IP，Redis 存储共享额度                                                                                                                     | `core-throttle-redis`、`core-multi-instance.e2e`；[scale-out.md](scale-out.md#共享限流)                                                          | 同出口用户会共享额度。按 principal 计数以及聊天/设备阈值计划中，v1 未实现                                                |
| 重复提交       | 前端 loading/禁用；创建类接口 `@Idempotent` 用 Redis SET NX，3 秒；失败按随机持有者令牌比较后删除                                                               | `core-idempotent.e2e`                                                                                                                            | 过期后可再次提交；不能代替数据库唯一性、业务幂等或支付/任务去重                                                          |
| 敏感数据       | 密码 bcrypt，UTF-8 ≤72 字节；token/客户端 secret 存哈希；SecretBox 用 AES-256-GCM + HKDF；日志打码、secret 参数掩码、响应 VO strip                              | `core-secret-box`、`core-token`、`core-logger.e2e`、`core-action-log.e2e`、`core-envelope.e2e`、认证安全回归矩阵                                 | 密钥轮换未实现；掩码不代替凭据保管。storage 改目标重填规则见下节                                                         |
| 任意代码执行   | 无 eval/new Function/vm；任务 handler 白名单；BPM 条件结构化；生成器标识符校验/转义；表单拒绝函数与行为键                                                       | `scripts/arch/no-eval.mjs`、lint、shared `form-schema.spec.ts`、输入安全回归矩阵                                                                 | 自定义 handler 是项目代码，须按权限和事务合同审查，不能把客户端 schema 或 XML 当可执行代码                               |
| XML 解析       | BPMN ≤80 KiB（UTF-8 字节）、拒 DOCTYPE/ENTITY，严格解析且 warning 即错；已知结构/引用白名单，拒表达式/外来扩展，入库规范化                                      | `wf-bpmn-xml`、`wf-bpmn-convert`、`wf-bpmn-model.e2e`、输入安全回归矩阵                                                                          | 全局请求体仍为 100 KB；BPMN 仅结构化子集。许可标志的视觉验收另见 [workflow-bpmn.md](workflow-bpmn.md#bpmnio-水印义务)    |
| 上传           | 魔数、类型/大小白名单、随机名、防穿越；直传确认原子比对属主再消费 grant，Range GET 复检并核对 ETag                                                              | `storage.e2e`、输入安全回归矩阵                                                                                                                  | 只公开 public 目录；private 通过鉴权下载。外部 S3/共享卷及反代 alias 由部署方验收，不把本机 mock 当实网成功              |
| Excel          | 危险前缀 `= + - @ \t \r` 以文本转义；导入默认 ≤10 MB/5000 行/100 列，拒宏和外链                                                                                 | `core-excel`、输入安全回归矩阵                                                                                                                   | 导入限额可配置，升高前须评估资源；接入自定义导出也要走安全工具                                                           |
| 头部           | API helmet；当前 API 按同源接入，`CORS_ORIGIN` 用于 refresh/Socket 的 Origin 许可；SPA 与 public 文件由反代下发 CSP/nosniff                                     | 输入安全回归矩阵的文件头；web `login.spec.ts`、`menu-page.spec.ts` 的 CSP；[deploy.md](deploy.md)                                                | 测试响应头不证明实际生产代理配置正确；Docker/compose 支持计划中                                                          |
| 供应链         | 提交 lockfile；release-age 1440 分钟、strict、明确例外与 allowBuilds；license/originality 检查；生产依赖审计                                                    | `pnpm audit --prod --audit-level high`、`pnpm license:check`、`pnpm originality:check`                                                           | 扫描是执行时的快照，不能保证未来无漏洞；升级依赖与例外须同步核对许可与安全公告                                           |
| 越权修改超管   | root 用户/角色保护，非 root 不得授予 root；授予角色还核对权限和范围子集                                                                                         | `iam-user.e2e`、`iam-role.e2e`、认证安全回归矩阵                                                                                                 | 不能靠菜单隐藏阻止授权；管理员的每个新动作也要使用 GrantPolicy                                                           |
| 开放重定向     | 登录 redirect 只接受单个 `/` 起始的站内路径，拒双斜杠、反斜杠、控制字符与异源；OAuth 回调注册校验、使用时逐字匹配                                               | web `router-guard.spec.ts`、`oauth-client.e2e`、`oauth2.e2e`、认证安全回归矩阵                                                                   | OAuth state 由第三方回调校验；服务端不验证调用者自己保管的 state                                                         |
| 会话           | 改密/重置/停用/删除/强退等统一撤销，包含 OAuth 授权码、宽限条目与 OTP；refresh 轮换/重放检测、绝对寿命；服务端强制密码标志与 permVersion                        | `core-auth.e2e`、`core-token`、`auth-extra.e2e`、`iam-user.e2e`、认证安全回归矩阵                                                                | 本人改密/改手机号按契约保留当前会话；第三方 access 不滑动，refresh 不延长绝对上限，见 [oauth2.md](oauth2.md)             |

表中的"认证安全回归矩阵"和"输入安全回归矩阵"是服务端专项回归用例，位于[安全测试目录](../apps/server/test/security/)。底层与 browser spec 分别位于 `apps/server/test/{core,e2e,storage,workflow}`、`packages/shared/src/platform/formkit`、`apps/web/{src/__tests__,e2e}`；表中其余名字均为完整 spec stem。

## 存储目标变更必须重填密钥

更新 S3 配置时，服务在事务锁定行后比较 `endpoint`、`bucket`、`accessKey`。只要其中一项改变，就不能用缺失、空白或掩码 `secretKey` 保留旧凭据；否则 HTTP 422、`C1010`，整次更新不写入，也不对新目标发起外部调用。显式提交新明文后用 SecretBox 加密保存；目标不变时可以保留旧密文。`region`、`forcePathStyle` 不属于本次绑定字段。

源码：[config.service.ts](../apps/server/src/modules/platform/storage/config/config.service.ts)；证据：[storage-config.e2e-spec.ts](../apps/server/test/e2e/storage-config.e2e-spec.ts) 和输入安全回归矩阵，包含三字段、双语错误、旧密文与整行不变、权限/范围及并发锁定读取。邮件配置沿用既有目标变更重填规则；缓存 transport 每次使用前重新检查配置与 SSRF，不因缓存跳过守卫。

## Redis 与多实例失败边界

服务已接入 `RedisThrottlerStorage`，用 Lua/Redis TIME 原子维护各路由/IP 的滚动窗口；Redis 操作最多等待 5 秒，失败返回 HTTP 500、`A0500`，不回退进程内计数，也不放行。认证、会话与幂等依赖 Redis，同样不能在失联时自行新增绕过路径。已建立的 Socket 推送可能丢失，不能把 HTTP 拒绝请求的策略理解为消息可靠性保证。

Socket.IO 使用 Redis 分片适配器，须等待真实异步订阅就绪，订阅失败拒绝启动。部署至少 Redis 7，实例共用相同库号、频道前缀及 APP_SECRET；本地文件共享卷或 S3。其连接状态恢复不支持，可靠消息按业务序号通过 REST 补拉。`RedisLock` 仍只支持单 Redis 节点、会话列表一次 MGET 后内存分页、邮件 transport 按实例缓存；完整条件和测试边界以 [scale-out.md](scale-out.md) 与 [realtime.md](realtime.md) 为准。

## 部署前自检清单

- [ ] 按威胁矩阵核对配置与回归用例，在隔离环境执行检查并记录版本、环境、结果与日志。
- [ ] 核对 production 测试标记拒绝、SSRF bypass 关闭、存储改目标不重填为 422 且不写入、演示模式的精确豁免清单与 OAuth/实时发送阻断。
- [ ] 核对真实代理的 XFF/Host/Proto、CSP、Swagger 关闭、private 文件不可直链；单独验证外部 S3/SMTP、共享卷与多主机部署。
- [ ] 检查 bpmn.io 标志、运行生产依赖审计与完整本地检查，记录未通过项及处理结果。
