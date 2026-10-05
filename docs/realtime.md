# 实时推送（Socket.IO）开发说明

> 如何在业务模块里从服务端推送、在页面里订阅。部署时反向代理的要求见 [deploy.md](deploy.md#实时推送socketio)。

## 概览

- 每个已登录的浏览器标签页一条 Socket.IO 连接（路径 `/socket.io`，只用 websocket 传输）。连接由 `apps/web/src/core/realtime/socket.ts` 的 `startRealtime()`（`main.ts` 启动时调用一次）统一管理：出现访问令牌即连接，令牌更换即用新令牌重连，登出即关闭。业务代码从不自己调用 `io()`。
- 只有服务端 → 浏览器一个方向：网关 `apps/server/src/core/realtime/realtime.gateway.ts` 没有入站处理器，浏览器只监听。
- 所有推送走同一个 Socket.IO 事件 `REALTIME_EVENT`（`'message'`），内容是信封 `RealtimeMessage` `{ type, payload }`，前端按 `type` 分发。契约只在 `packages/shared/src/common/realtime.ts` 定义一处，服务端与前端共用同一组类型。
- 握手通过后，socket 由服务端加入三个房间：`user:{id}`、`sid:{sid}`、`type:{userType}`（`realtime.service.ts` 的 `rooms`）。客户端无法选择或加入其他房间。

## 服务端：`RealtimeService`

`CoreRealtimeModule` 是全局模块：任何 service 直接在构造函数里注入 `RealtimeService`，不用 import 模块。

| 方法                        | 送达                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `toUser(userId, msg)`       | 该用户所有已连接的标签页（房间 `user:{id}`）                                         |
| `toUsers(userIds, msg)`     | 多个用户；同一 socket 只收到一次；空数组什么都不发                                   |
| `toUserType(userType, msg)` | 某一用户类型的全部 socket（房间 `type:{userType}`）                                  |
| `broadcast(msg)`            | 所有已登录的 socket                                                                  |
| `onlineUsers(userIds?)`     | 整个部署中有 socket 的不同用户数（在给定 id 中，或全部）；在发送前调用即得"送达人数" |

现有用法：站内信投递后 `toUser(userId, { type: RT.notifyNew, payload: { id, title } })`（`inbox.channel.ts`），公告发布 / 撤回 / 删除后 `broadcast({ type: RT.notifyBulletin, payload: { action, ids } })`（`bulletin.service.ts`），示例页 `toUsers` / `broadcast`（`modules/demo/realtime/realtime.service.ts`），流程动作在最外层事务提交后 `toUsers(…, { type: RT.wfTask, payload: { instanceId } })`（`modules/workflow/runtime/wf-notify.ts`，调用方外层还有事务时也等到那次提交）。信封按 `type` 做类型检查：`payload` 必须符合 `RealtimePayloads[type]`。

规则：

- **提交之后再推**：在事务提交之后调用（`withTransaction(...)` 返回之后，或像站内信那样在状态写入之后），不要在事务内部推送；否则接收方可能按推送去读，却读到尚未提交或已回滚的数据。
- **推送是提示，不是数据通道**：只带标识和显示所需的最少字段，接收方需要详情时经 HTTP 接口按自己的权限与数据范围读取。例如 `notify:bulletin` 只带 `{ action, ids }`，不带公告正文。
- **收件人由服务端决定**：`toUser(s)` 的 id 由服务端按权限与数据范围算出，不要直接采用请求体里的 id。示例页的"指定用户 / 角色"经 `scopedQb` 只取调用者 `iam_user` 数据范围内的启用用户，范围外的静默排除；"全员"另需 `demo.realtime.broadcast`。`broadcast` 会送到每个已登录用户（包括没有相关权限的人），只用于人人都能读的内容。
- **即发即弃**：方法同步返回，不等待也不确认送达；不在线的用户收不到，之后也不补发。必须送达的内容先落库（如站内信 `msg_inbox`），推送只负责"有新内容"的提醒。
- 网关就绪之前（CLI、种子、迁移脚本）所有方法都是空操作，调用方不用判断。
- `endSessions` 只供 `SessionRevoker` 使用（断开被结束会话的 socket，强退时先推 `session:kicked`），业务代码不要调用。

## 事件命名与共享契约

新增一种推送，以假想的"订单已发货"为例：

1. 在 `packages/shared/src/common/realtime.ts` 的 `RT` 里加常量（注释写明谁发、发给谁、何时发），在 `RealtimePayloads` 里加同名键的载荷类型，然后 `pnpm --filter @qiwu/shared build`（server 读 shared 的构建产物，web 直接读源码；`pnpm dev` 的 `tsc -w` 会自动重建）：

   ```ts
   export const RT = {
     // …
     /** an order of the recipient shipped (biz/order), after the shipping transaction commits */
     orderShipped: 'order:shipped',
   } as const

   export interface RealtimePayloads {
     // …
     'order:shipped': { id: number; no: string }
   }
   ```

2. 服务端注入 `RealtimeService`，提交之后推送：

   ```ts
   @Injectable()
   export class OrderService extends BaseCrudService<Order> {
     constructor(
       txHost: TransactionHost<TransactionalAdapterTypeOrm>,
       private readonly realtime: RealtimeService,
     ) {
       super(txHost, Order)
     }

     async ship(id: number) {
       const order = await this.txHost.withTransaction(() => this.markShipped(id))
       this.realtime.toUser(order.ownerId, {
         type: RT.orderShipped,
         payload: { id: order.id, no: order.no },
       })
     }
   }
   ```

3. 前端在页面里订阅（下一节），载荷类型同样来自 `RealtimePayloads`。

命名与载荷约定：

- 类型名 `<domain>:<event>`，全小写，多个词用 `-` 连接；`domain` 是事件所涉业务或资源的简短名称（现有 `session`、`notify`、`demo`），不必与权限域相同（`session:kicked` 属 `iam`，`notify:*` 属 `messaging`）；新增前先查 `RT`，不要与已有前缀冲突。
- 一个类型只表达一种含义、一种载荷形状；要改形状就换新类型，不复用旧名。
- 载荷只用 JSON 值：数字、字符串、布尔、数组、对象；时间用 ISO 8601 字符串，不传 `Date`。不放 HTML、令牌或其他机密。
- 不新增 Socket.IO 事件名：一切都走 `REALTIME_EVENT`。`REALTIME_UNAUTHORIZED` / `REALTIME_FORBIDDEN_ORIGIN` 是握手被拒时 `connect_error` 的消息，不是推送类型。

现有类型：

| 类型              | 载荷                               | 发给                                                                                   |
| ----------------- | ---------------------------------- | -------------------------------------------------------------------------------------- |
| `session:kicked`  | `{ sid }`                          | 被管理员强退的会话，随后断开                                                           |
| `notify:new`      | `{ id, title }`                    | 站内信的收件人（`user:{id}`）                                                          |
| `notify:bulletin` | `{ action, ids }`                  | 所有已登录的 socket                                                                    |
| `demo:message`    | `{ from: { id, name }, text, at }` | 示例页选定的用户 / 角色成员 / 全员                                                     |
| `wf:task`         | `{ instanceId }`                   | 待办有变化的用户（分配、办理、取消等），流程动作的事务提交后推送；前端刷新待办数与列表 |

## 前端：`onRealtime` 订阅

```ts
import { shallowRef } from 'vue'
import { RT, type RealtimePayloads } from '@qiwu/shared'
import { onRealtime } from '@/core/realtime/socket'

const log = shallowRef<RealtimePayloads['demo:message'][]>([])
// 在 <script setup> 中调用：组件卸载时自动退订
onRealtime(RT.demoMessage, (m) => {
  log.value = [m, ...log.value].slice(0, 100)
})
```

- 在组件 `setup`（或任一 effect scope）中调用时，scope 结束即自动退订。在 scope 之外（store、模块顶层）调用，须保存返回的 `off()` 并在不再需要时调用，否则处理器一直留着。
- keep-alive 的页面切走标签时只是失活，订阅仍在（示例页的接收日志因此在切换标签后不丢）；关闭标签才卸载。失活时不该处理的，用 `onActivated` / `onDeactivated` 自己开关。
- 处理器要短小且不抛异常：同一类型的处理器依次同步调用，一个抛错会让后面的收不到。需要重新加载时 `void load()`，请求错误交给请求层提示。
- 连接状态：`realtimeStatus`（`'up' | 'reconnecting' | 'down'`）用于显示（示例页的连接徽标）；`realtimeUp`（布尔）用于决定是否需要轮询兜底。

## 断线、重连与兜底

| 情况                                              | 客户端行为                                                                                      | `realtimeStatus`             |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------- |
| 网络中断、浏览器离线、服务端重启                  | Socket.IO 自动重连（约 1 s 起、最长 5 s 的退避）；每次重连握手都读取当前的访问令牌与语言        | `reconnecting`，连上后 `up`  |
| 握手被拒 `unauthorized`（断线期间访问令牌已过期） | 刷新一次令牌，新令牌触发重连；刷新失败则停在 `down`，下一次 HTTP 请求时由请求层提示"会话已过期" | `reconnecting` → `up`/`down` |
| 握手被拒 `forbidden_origin`                       | 不重试                                                                                          | `down`                       |
| 服务端断开（强退、会话结束、会话绝对过期）        | 不重试；强退时先收到 `session:kicked`，随即清除登录状态并跳到登录页                             | `down`                       |
| 令牌刷新（含另一个标签页登录了别的会话）          | 关闭旧 socket，用新令牌连接                                                                     | `reconnecting` → `up`        |
| 登出                                              | 关闭                                                                                            | `down`                       |

断线期间的推送会丢失，没有队列也不回放。所以每一种推送都要有"重新读取"的路径，界面不能只靠推送保持正确。通知铃（`NotifyBell.vue`）是标准做法：socket 重新连上（`watch(realtimeUp, (up) => up && void notify.load())`）、窗口获得焦点、打开下拉时重新加载，socket 断开期间（页面可见时）每 60 s 轮询一次。新增依赖推送的界面照此处理；示例页的接收日志是例外，它本来就只显示连接期间收到的消息。

## 移动端（uni-app）

移动端（`mobile/`）连同一个网关、用同一份契约，规则与上面一致，只是写法不同：

- **一条代码路径**：官方 `socket.io-client` 加自写的传输类 `UniSocketTransport`（`mobile/src/core/realtime.ts`）。它继承 socket.io-client 导出的 `WebSocket` 传输，只重写 `createSocket`，改用 `uni.connectSocket`，所以 H5、微信小程序、App 走同一套代码，H5 的 Playwright 也就测到了这条路径。调用 `uni.connectSocket` 时一定要带 `fail` 回调：不带任何回调时 uni 返回 Promise 而不是 SocketTask；`fail` 也把小程序"域名不在合法列表"之类的早期失败转成 socket 错误，交给 Socket.IO 退避重连。
- **地址**：H5 连页面自己的源（开发服务器与 `vite preview` 的 `/socket.io` 代理）。代理必须写成对象形式 `{ target, ws: true }`：字符串简写会改写 `Host`，服务端的 Origin 检查随即判为外站（`forbidden_origin`）。小程序与 App 连 `VITE_API_BASE` 的源（`https://…` → `wss://…/socket.io/`）。
- **何时连、何时断**：应用回到前台（`App.vue` 的 `onShow`，冷启动也算）和 Tab 页 `onShow` 时 `startRealtime()`（有会话才连，已有 socket 时不重复建）；应用进入后台（`App.vue` 的 `onHide`）断开，回到前台重连并补拉；登录与登出时 `stopRealtime()`，新用户不会沿用上一位的 socket。小程序打开选图、订阅消息等系统弹窗时也会触发 `onHide`，回来后重连一次，无害。握手用当前的访问令牌（`request.ts` 的 `currentAccessToken()`）与语言。启动后的第一次握手没有访问令牌（它只放在内存里），被拒 `unauthorized` 后刷新一次令牌再连；刷新后仍被拒，或 `forbidden_origin`，就不再连，由轮询兜底。
- **推送做什么**：`wf:task`、`notify:new` → 重新拉取待办数与未读数（`useCountsStore().load()`，工作台的最新待办随之刷新）；`session:kicked` → 结束会话、回登录页并提示原因；`notify:bulletin` 不处理（消息页每次显示都会重新加载）。连上时也拉一次，补上断线期间的变化。
- **轮询兜底**：Tab 页每 60 s 调一次 `pollCounts()`，只在 socket 没连上（`realtimeUp` 为 false）时才真的请求。所以 socket 连不上时，角标仍在 60 秒内刷新。
- **小程序禁用 `Function`**：engine.io-client 的 `globals.js` 在模块加载时求值 `self ?? window ?? Function("return this")()`。小程序既没有 `self` 也没有 `window`，又禁止 `Function`/`eval`。`mobile/vite.config.ts` 的预处理插件把它换成 `mobile/src/core/eio-globals.ts`（导出与原文件逐个对应，单测 `mobile-realtime.spec.ts` 比对），`mobile/scripts/mp-size.mjs` 在 `build:mp-weixin` 之后检查产物：出现 `Function("return this")`、`require("ws")` 或 `xmlhttprequest-ssl` 就失败。同一配置里 `socket.io-client` 别名到它的真实目录：uni 强制 `preserveSymlinks`，从 pnpm 的符号链接位置找不到它自己的依赖。
- **测试**：单测 `mobile/src/__tests__/mobile-realtime.spec.ts`（真实的 socket.io-client 跑在伪造的 SocketTask 上，由用例逐帧扮演服务端）；Playwright `mobile/e2e/mobile-push.spec.ts`（H5 经预览代理连真实服务端：新待办与站内信 2 秒内刷新角标，强退 2 秒内回到登录页；在没有 Tab 栏的页面冷启动后连上，切到后台即断开，回到前台 2 秒内重连）；`mobile-home.spec.ts` 的轮询用例先用 `page.routeWebSocket` 挡掉 socket，专测兜底。

## 安全规则

- **握手鉴权**：每次连接和重连都校验 `auth.token` 属于一个活跃的第一方会话（`console`、移动端 `mobile`）（与 `AuthGuard` 同一个 `TokenService`），否则 `connect_error` `unauthorized`；OAuth2 客户端令牌连不上。socket 最迟在会话的 `absoluteExpAt` 断开；改密、停用、删除用户、强退等经 `SessionRevoker` 结束会话时，同时断开它的 socket。
- **Origin 检查**：浏览器发起的握手，`Origin` 必须是本站自己的源或 `CORS_ORIGIN` 中的一个，否则 `connect_error` `forbidden_origin`（防跨站 WebSocket 劫持）。没有 `Origin` 的非浏览器客户端仍须有效令牌。
- **只出不进**：网关没有 `@SubscribeMessage` 处理器，入站帧上限 16 KB（`maxHttpBufferSize`）。浏览器要向服务端发东西，一律走普通 HTTP 接口（`@RequirePerm`、zod 校验、`@ActionLog`、限流，示例页的发送即如此），不要在网关里加处理器绕开这些守卫。
- **权限在发送时判定**：推送不再经过接收方的权限守卫，只能把接收方本来就能读到的内容推给他（按权限与数据范围挑选收件人；只带 id，让接收方经 HTTP 读取）。
- **载荷不当 HTML 渲染**：载荷可能含有用户输入（示例页原样转发用户写的文本），前端只用插值 `{{ }}` 或 `textContent` 显示，绝不用 `v-html` / `innerHTML`，也不拼进 `href` 或 URL。需要富文本时只推 id，经 HTTP 取回用 `core/sanitize.ts` 清洗过的内容。Playwright `realtime-demo.spec.ts` 断言推送的 `<b>…</b>` 按原文显示、不会变成元素。

## 多实例部署

服务端在统一的 `setupApp` 入口挂载 `@socket.io/redis-adapter` 的分片适配器（`createShardedAdapter`，`subscriptionMode: 'dynamic'`），生产与测试使用同一入口。`toUser` / `toUsers` / `toUserType` / `broadcast` 跨实例送达；`onlineUsers` 通过 `fetchSockets()` 统计整个部署中不同的在线用户；`SessionRevoker` 先推 `session:kicked` 再跨实例断开被结束会话的连接。人数是发送时的在线快照，不是客户端确认收到了消息。

部署前按 [scale-out.md](scale-out.md) 核对配置：Redis ≥ 7；所有实例连接同一 MySQL 库、同一 Redis 服务与 `REDIS_DB`，使用相同的 `REDIS_KEY_PREFIX`。频道由 `redisChannel` 构造为 `qw:socket.io:<REDIS_DB>`，定时任务同步频道为 `qw:job:sync:<REDIS_DB>`。Pub/Sub 不按 Redis 库隔离，所以不同部署必须使用不同的库号和频道前缀；不能让两个独立环境组成一个集群。

每个实例另开两条 Redis 连接供适配器发布、订阅，业务命令继续用原连接。启动等待实际订阅完成，失败则拒绝启动并清理连接；动态用户、会话、类型房间也等订阅就绪。分片适配器使用 `SSUBSCRIBE` / `SPUBLISH` / `PUBSUB SHARDNUMSUB`，现有 `qw:*` 频道 ACL 已覆盖，不需要经典适配器的 `PSUBSCRIBE` 模式授权。当前只用 websocket，无需粘性会话；以后启用 polling 则必须配置粘性会话。

分片适配器不支持连接状态恢复，也不持久化消息。Redis 或网络故障期间不能保证跨实例交付，重连不回放漏掉的推送；可靠消息必须先落库，按业务序号通过 REST 补拉，界面保留重连刷新和轮询兜底。两实例验收见 `test/e2e/core-multi-instance.e2e-spec.ts`，其中包含单实例进程重启后重新订阅的回归。

## 示例页与测试

`APP_DEMO_MODE=true` 时，`POST /api/demo/realtime/send` 返回 403 `A0431`；演示访客不能向所有在线访客发消息。已有业务通知和只出不进的 WebSocket 网关仍沿用各自权限与发送规则。

"系统工具 → 生成示例 → 实时推送示例"（`/demo/realtime`）把上面的内容串起来：

| 部分   | 位置                                                                                                                                                                                                                                                                                                                                         |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 契约   | `RT.demoMessage` 与载荷（`packages/shared/src/common/realtime.ts`）；发送请求体与 `demoRealtimePerms`（`packages/shared/src/demo/realtime.schema.ts`）                                                                                                                                                                                       |
| 服务端 | `apps/server/src/modules/demo/realtime/`：`POST /api/demo/realtime/send`（`demo.realtime.send`，全员另需 `demo.realtime.broadcast`；`@ActionLog`、`@Idempotent`、限流），经 `RealtimeService` 推送并返回 `{ delivered }`                                                                                                                     |
| 前端   | `apps/web/src/views/demo/realtime/index.vue`：连接徽标（`realtimeStatus`）、发送表单、接收日志（`onRealtime`，纯文本，最多 100 条）                                                                                                                                                                                                          |
| 测试   | 服务端 `test/e2e/core-realtime.e2e-spec.ts`（握手、Origin、房间、断开）与 `demo-realtime.e2e-spec.ts`（`test/setup/socket.ts` 的 `socket.io-client` 助手连上后收推送）；前端单测 `realtime-socket.spec.ts`、`demo-realtime.spec.ts`（mock `@/core/realtime/socket`）；Playwright `realtime-demo.spec.ts`（两个浏览器上下文收发、离线后恢复） |
