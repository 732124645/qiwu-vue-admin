# 多实例部署

服务使用 Socket.IO Redis 分片适配器和 Redis 限流存储。多个服务端进程共用状态，跨实例推送、在线人数统计和会话强退由现有 `RealtimeService` / `SessionRevoker` 调用完成。反向代理示例见 [deploy.md](deploy.md)，业务推送与客户端兜底见 [realtime.md](realtime.md)。

## 启动前置条件

- Redis **≥ 7**，支持 `SSUBSCRIBE`、`SPUBLISH`、`PUBSUB SHARDNUMSUB`，并允许既有业务命令以及限流 Lua 使用的 `EVAL`、`TIME`、ZSET、hash、过期和删除命令。现有 `qiwu` 用户的 `qw:*` 键与频道授权覆盖分片适配器；不需要给经典适配器添加模式订阅 ACL。
- 同一部署的实例使用同一 MySQL 库、同一 Redis 服务、同一 `REDIS_DB` 与 `REDIS_KEY_PREFIX`，并使用相同的 `APP_SECRET`、认证配置、种子及应用版本。凭据只放在忽略文件或部署环境中，不放入前端 `VITE_*`。
- 不同部署使用不同 Redis 库号与频道前缀。Pub/Sub 不受 `SELECT` 隔离，频道必须经 `cache-namespaces.ts` 的 `redisChannel` 生成：`qw:socket.io:<REDIS_DB>`、`qw:job:sync:<REDIS_DB>`。同库同前缀即同一个部署，不能共用于独立的开发、预发、生产环境。
- 本地文件存储要求所有实例访问**同一路径的共享卷**，反向代理公开的 `/files/` 也从该卷的 `public/` 读取；私有目录不能公开。跨主机建议使用已有 S3 存储配置。共享卷与 S3 的真实部署访问需部署方验收，两进程测试不证明这些外部存储已配置正确。

每个实例在业务 Redis 连接之外增加两条适配器连接；scheduler 还有自己的订阅连接。部署时为连接数、内存和文件描述符留出容量。

## Socket.IO 与反向代理

`setupApp` 在生产与测试中挂载同一个 `RedisIoAdapter`。它使用 `createShardedAdapter`，当前为 `subscriptionMode: 'dynamic'`：公开房间有独立频道，用户推送只发往订阅了该用户房间的实例。基础订阅与房间订阅异步完成，集成层等待实际监听器就绪；订阅失败拒绝启动，关闭时清理适配器及其连接。若部署验证动态订阅不可用，应先验证同包的 `static` 模式并明确配置、记录结果；当前实现没有静默降级开关。

代理必须向所有实例转发 `/socket.io/` 的 WebSocket Upgrade，使用 HTTP/1.1，传递 `Upgrade` 与 `Connection`，并将读超时设得长于心跳周期。项目只启用 websocket，**不需要粘性会话**；若以后允许 polling，则必须添加粘性会话。`TRUST_PROXY` 只信任实际代理，代理负责重写来自客户端的转发头，否则基于客户端 IP 的限流可被绕过。

`fetchSockets()` 与 `disconnectSockets()` 跨实例工作；`onlineUsers` 按用户去重，人数是发送时快照。分片适配器**不支持连接状态恢复**，不提供消息队列或送达确认。Redis 断连、实例重启和网络故障可能丢失推送；可靠消息先存数据库，用业务序号经 REST 补拉，客户端在重连后刷新并保留轮询。

`onlineUsers` / `fetchSockets()` 会发起跨实例请求，等待受适配器的 `requestsTimeout`（当前 5 秒）约束，只用于统计。实时推送示例用它展示在线人数；业务消息的逐条发送热路径不得调用它。

## 共享限流

`CoreThrottlerModule` 注入已有 node-redis 连接，`RedisThrottlerStorage` 用 Lua 原子更新滚动窗口。键经 `redisKey('throttle', throttlerName, handlerIpDigest, ...)` 构造，属于不可由缓存监控清除的 `throttle:` 命名空间；不存明文令牌、请求体或真实 IP。

每次命中独立过期，计时使用 Redis `TIME`，多个实例的本机时钟差异不会改变窗口。超过阈值进入固定封禁期，封禁期间请求不会延长封禁；到期重新计数。现有 `@RateLimit(limit, ttlMs)` API、框架的 tracker（含 IPv6 归一化）与 `Retry-After` / `X-RateLimit-*` 响应头保持不变。Redis 操作最多等待 5 秒，失败返回既有内部错误 `A0500` / HTTP 500，不降级为内存计数或放行。

活跃 handler/IP 桶的 ZSET 最多存 `limit + 1` 个命中，闲置键自动过期；内存随路由阈值和活跃 IP 数增长。限流及现有锁基于单 Redis 节点，本文不承诺 Redis Cluster 支持。

## 其它共享状态与边界

| 功能             | 当前行为与部署边界                                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 定时任务         | 每实例保留定时器，用既有 Redis 去重、锁和 `job:sync:<REDIS_DB>` 同步，另有周期对账。handler 必须响应失锁 `AbortSignal`，不能将 Redis 锁当成业务幂等的替代。 |
| `RedisLock`      | 多服务实例可共用一个 Redis 节点；Redis 故障转移可能发放重复锁，不保证至多一次。需故障转移保障时另立方案。                                                   |
| 字典、参数、权限 | 沿用 Redis 版本计数及防竞态逻辑，不增加进程内缓存失效总线。                                                                                                 |
| 会话与令牌列表   | 现有实现一次 `MGET` 全部活跃会话，再在内存中筛选、分页。实例增加不会消除大规模会话列表的成本。                                                              |
| 邮件             | transport 按实例缓存；每次使用前读取数据库并检查 enabled / updatedAt，配置更新后该实例在下一次使用时重建。实例数增加也会增加邮件连接数。                    |
| 消息可靠性       | 推送只提示刷新，不替代持久数据与业务补拉；未实现离线队列或 IM 序号协议。                                                                                    |

## 本地验证

在[入门指南第 2 节](getting-started.md#2-空库账号与隔离)的隔离测试库中运行，测试会重置对应的 `*_test` 数据库；不要指向开发库或与其它测试共用同一库与 Redis db：

```sh
pnpm --filter @qiwu/server build
pnpm --filter @qiwu/server test core-throttle-redis
pnpm --filter @qiwu/server test core-multi-instance.e2e
pnpm --filter @qiwu/server test core-auth.e2e
pnpm verify
```

两实例 spec 只启动编译后的 Nest 应用，各自 `listen(0)`，通过真实 HTTP 登录、推送、强退，验证累计 30 次发送后第 31 次返回 429 `A0429`，并验证一个进程重启后的跨实例推送。启动预算 30 秒，HTTP / socket / 推送等待 5 秒，runner 180 秒硬截止；测试结束或启动失败时关闭 socket、退出子进程，再清理测试状态。频道隔离的纯函数与适配器生命周期测试在 `core-realtime-adapter.spec.ts`，没有向其它 Redis 库写测试键。

这些检查覆盖同机两进程与实际测试 Redis，不代表多主机网络、负载均衡、共享存储、S3、Redis 故障转移或生产容量已经验证。
