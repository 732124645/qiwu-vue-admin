# 多实例部署

服务使用 Socket.IO Redis 分片适配器和 Redis 限流存储。多个服务端进程共用状态，跨实例推送、在线人数统计和会话强退由现有 `RealtimeService` / `SessionRevoker` 调用完成。反向代理示例见 [deploy.md](deploy.md)，业务推送与客户端兜底见 [realtime.md](realtime.md)。

## 启动前置条件

- Redis **≥ 7**，支持 `SSUBSCRIBE`、`SPUBLISH`、`PUBSUB SHARDNUMSUB`，并允许既有业务命令以及限流 Lua 使用的 `EVAL`、`TIME`、ZSET、hash、过期和删除命令。现有 `qiwu` 用户的 `qw:*` 键与频道授权覆盖分片适配器；不需要给经典适配器添加模式订阅 ACL。
- 同一部署的实例使用同一 MySQL 库、同一 Redis 服务、同一 `REDIS_DB` 与 `REDIS_KEY_PREFIX`，并使用相同的 `APP_SECRET`、认证配置、种子及应用版本。凭据只放在忽略文件或部署环境中，不放入前端 `VITE_*`。
- 全部实例使用同一个多租户开关 `APP_MULTI_TENANT`。它只在启动时读取，切换时全部实例重启才算完成；新旧取值混跑期间，各实例对同一会话的判定不同（开关关闭的实例会结束非默认租户的会话）。步骤见 [multi-tenancy.md](multi-tenancy.md#开关)。
- 不同部署使用不同 Redis 库号与频道前缀。Pub/Sub 不受 `SELECT` 隔离，频道必须经 `cache-namespaces.ts` 的 `redisChannel` 生成：`qw:socket.io:<REDIS_DB>`、`qw:job:sync:<REDIS_DB>`。同库同前缀即同一个部署，不能共用于独立的开发、预发、生产环境。
- 本地文件存储要求所有实例访问**同一路径的共享卷**，反向代理公开的 `/files/` 也从该卷的 `public/` 读取；私有目录不能公开。跨主机建议使用已有 S3 存储配置。共享卷与 S3 的真实部署访问需部署方验收，两进程测试不证明这些外部存储已配置正确。

每个实例在业务 Redis 连接之外增加两条适配器连接（`worker` 角色也一样：它的推送要经过适配器）；scheduler 还有自己的订阅连接；每个队列处理器另有两条连接（见[任务队列](queue.md)）。部署时为连接数、内存和文件描述符留出容量。

## Socket.IO 与反向代理

`setupApp` 在生产与测试中挂载同一个 `RedisIoAdapter`。它使用 `createShardedAdapter`，当前为 `subscriptionMode: 'dynamic'`：公开房间有独立频道，用户推送只发往订阅了该用户房间的实例。基础订阅与房间订阅异步完成，集成层等待实际监听器就绪；订阅失败拒绝启动，关闭时清理适配器及其连接。若部署验证动态订阅不可用，应先验证同包的 `static` 模式并明确配置、记录结果；当前实现没有静默降级开关。

代理必须向所有实例转发 `/socket.io/` 的 WebSocket Upgrade，使用 HTTP/1.1，传递 `Upgrade` 与 `Connection`，并将读超时设得长于心跳周期。项目只启用 websocket，**不需要粘性会话**；若以后允许 polling，则必须添加粘性会话。`TRUST_PROXY` 只信任实际代理，代理负责重写来自客户端的转发头，否则基于客户端 IP 的限流可被绕过。

`fetchSockets()` 与 `disconnectSockets()` 跨实例工作；`onlineUsers` 按用户去重，人数是发送时快照。分片适配器**不支持连接状态恢复**，不提供消息队列或送达确认。Redis 断连、实例重启和网络故障可能丢失推送；可靠消息先存数据库，用业务序号经 REST 补拉，客户端在重连后刷新并保留轮询。

`onlineUsers` / `fetchSockets()` 会发起跨实例请求，等待受适配器的 `requestsTimeout`（当前 5 秒）约束，只用于统计。实时推送示例用它展示在线人数；业务消息的逐条发送热路径不得调用它。

## 共享限流

`CoreThrottlerModule` 注入已有 node-redis 连接，`RedisThrottlerStorage` 用 Lua 原子更新滚动窗口。键经 `redisKey('throttle', throttlerName, handlerIpDigest, ...)` 构造，属于不可由缓存列表清除的 `throttle:` 命名空间；不存明文令牌、请求体或真实 IP。

每次命中独立过期，计时使用 Redis `TIME`，多个实例的本机时钟差异不会改变窗口。超过阈值进入固定封禁期，封禁期间请求不会延长封禁；到期重新计数。现有 `@RateLimit(limit, ttlMs)` API、框架的 tracker（含 IPv6 归一化）与 `Retry-After` / `X-RateLimit-*` 响应头保持不变。Redis 操作最多等待 5 秒，失败返回既有内部错误 `A0500` / HTTP 500，不降级为内存计数或放行。

活跃 handler/IP 桶的 ZSET 最多存 `limit + 1` 个命中，闲置键自动过期；内存随路由阈值和活跃 IP 数增长。限流及现有锁基于单 Redis 节点，本文不承诺 Redis Cluster 支持。

## 其它共享状态与边界

| 功能             | 当前行为与部署边界                                                                                                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 定时任务         | 每个 `all` / `worker` 实例保留定时器，用既有 Redis 去重、锁和 `job:sync:<REDIS_DB>` 同步，另有周期对账；`api` 实例没有定时器，只发布 `job:sync`。handler 必须响应失锁 `AbortSignal`，不能将 Redis 锁当成业务幂等的替代。                 |
| 任务队列         | 每个 `all` / `worker` 实例都为每个处理器运行一个 worker，同一任务只被一个实例取走，增加实例即增加并发；`api` 实例只添加任务。实例崩溃时它执行中的任务由其他实例重新执行，处理器须幂等。Redis 须为 `noeviction`，见[任务队列](queue.md)。 |
| `RedisLock`      | 多服务实例可共用一个 Redis 节点；Redis 故障转移可能发放重复锁，不保证至多一次。需故障转移保障时另立方案。                                                                                                                                |
| 字典、参数、权限 | 沿用 Redis 版本计数及防竞态逻辑，不增加进程内缓存失效总线。                                                                                                                                                                              |
| 会话与令牌列表   | 现有实现一次 `MGET` 全部活跃会话，再在内存中筛选、分页。实例增加不会消除大规模会话列表的成本。                                                                                                                                           |
| 邮件             | transport 按实例缓存；每次使用前读取数据库并检查 enabled / updatedAt，配置更新后该实例在下一次使用时重建。实例数增加也会增加邮件连接数。                                                                                                 |
| 消息可靠性       | 推送只提示刷新，不替代持久数据与业务补拉；需要可靠执行的后台工作走[任务队列](queue.md)，IM 序号协议尚未实现。                                                                                                                            |

## 进程角色

`APP_ROLE`（启动时读取，默认 `all`）决定一个进程做什么。同一个 HTTP 进程里的后台任务若有同步的 CPU 计算，会让落在这个进程上的请求一起等；把后台工作放到单独的进程即可避开：

| `APP_ROLE`    | HTTP 与 Socket.IO                                     | 定时任务（cron、错过补跑、对账、`job:sync` 订阅）                                                                         | 队列 worker    | 说明                                                                           |
| ------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------ |
| `all`（默认） | 是                                                    | 是                                                                                                                        | 全部           | 与未引入角色时完全相同                                                         |
| `api`         | 是                                                    | 否：任务增改仍发布 `job:sync`；任务页“执行一次”放入平台队列 `scheduler-run`，由 worker 执行（响应仍是 `{ scheduledAt }`） | 无，只添加任务 | 处理器启动时登记的 BullMQ 定时任务也不登记                                     |
| `worker`      | 仍 `listen` 自己的 `PORT`（健康检查；反向代理不转发） | 是                                                                                                                        | 全部           | Socket.IO 服务照常初始化，后台推送经 Redis 适配器到达连在 `api` 实例上的浏览器 |

- **至少要有一个 `all` 或 `worker` 实例**，否则定时任务不再触发、队列任务只进不出、“执行一次”一直排队。应用不检查这一点（只有 `api` 实例的部署不会报错），由部署保证。
- `worker` 实例与其它实例使用同一 MySQL、同一 Redis 服务、同一 `REDIS_DB` 与 `REDIS_KEY_PREFIX`：后台推送（`RealtimeService`：站内信、公告、流程待办、智能助手的流式输出）经 Redis 适配器送到连在 `api` 实例上的 socket；Socket.IO 服务没有初始化的进程里推送会被静默丢弃，所以 `worker` 照样 `listen`。
- 不在任务里执行的工作不随角色移动：提交事务后的通知即时投递在提交它的进程里执行（`notify.dispatch` 兜底），公众号回调后的处理在接收回调的进程里执行。
- PM2 部署的开法见[部署](deploy.md#使用-pm2-部署可选)（`QW_PM2_WORKER_INSTANCES`）。

## 卡顿诊断

同一进程里的 HTTP 请求和定时任务共用一个事件循环，任务做同步重活时，这个进程上的请求会一起变慢。以下观测默认关闭或只读，不改变原有行为：

- **服务监控页**（`GET /api/monitor/server`，需 `monitor.server.browse`）的进程信息带 `eventLoop`：事件循环延迟的 p50、p99、最大值（毫秒，超出正常调度的部分：已减去 20 毫秒的采样间隔，空闲时接近 0）与利用率（0–1），统计的是**响应本次请求的那个实例**自上次被读取以来的数据；cluster 部署下每次刷新可能落到不同实例。`/api/health` 不变。
- **慢请求标记**：`LOG_SLOW_REQUEST_MS` 大于 0 时，响应耗时达到阈值的请求日志行改用 warn，并加上 `"slow":true` 与 `runningJobs`（当时本进程正在执行的定时任务：`taskId`、`handler`、已运行毫秒数 `ms`）。低于阈值或为 0 时日志行与原来相同。
- **事件循环周期日志**：`LOG_EVENT_LOOP_INTERVAL_MS` 大于 0 时每个间隔写一行 `{ eventLoop: { p50, p99, max, utilization }, runningJobs }`（口径同监控页），`max` 达到 `LOG_EVENT_LOOP_WARN_MS`（大于 0）时用 warn。它有自己的采样，不影响监控页的“上次读取以来”。
- **任务日志**（`job_run`）：每次执行记下 `instance`（`主机名:进程号`）与 `loop_max_ms`。后者是这次执行期间**该进程**事件循环的最大延迟（同样是超出正常调度的部分），不一定是这个任务造成的；同一进程里有并行的任务或请求时只能作为参考。被跳过的执行只有 `loop_max_ms` 为空（`instance` 仍记下是哪个进程跳过的）；升级前的旧记录两列都为空。

```sh
# apps/server/.env（或进程环境）：阈值按实际情况取
LOG_SLOW_REQUEST_MS=1000
LOG_EVENT_LOOP_INTERVAL_MS=60000
LOG_EVENT_LOOP_WARN_MS=200

# 事后检索：慢请求及当时同进程在跑的任务（pid 对上 job_run.instance 的进程号）
grep '"slow":true' /srv/qiwu/logs/*.log
```

## 本地验证

在[入门指南第 2 节](getting-started.md#2-空库账号与隔离)的隔离测试库中运行，测试会重置对应的 `*_test` 数据库；不要指向开发库或与其它测试共用同一库与 Redis db：

```sh
pnpm --filter @qiwu/server build
pnpm --filter @qiwu/server test core-throttle-redis
pnpm --filter @qiwu/server test core-multi-instance.e2e
pnpm --filter @qiwu/server test core-app-role.e2e
pnpm --filter @qiwu/server test core-auth.e2e
pnpm verify
```

两实例 spec 只启动编译后的 Nest 应用，各自 `listen(0)`，通过真实 HTTP 登录、推送、强退，验证累计 30 次发送后第 31 次返回 429 `A0429`，并验证一个进程重启后的跨实例推送；最后换成一个 `api` 进程加一个 `worker` 进程，验证经 `api` 进程发起的“执行一次”与每秒的 cron 都只在 `worker` 进程执行（`job_run.instance`），且它的推送到达连在 `api` 进程上的 socket。单进程的角色行为（不开 worker、不装 cron、不补跑、“执行一次”入队）见 `core-app-role.e2e`。启动预算 30 秒，HTTP / socket / 推送等待 5 秒，runner 180 秒硬截止；测试结束或启动失败时关闭 socket、退出子进程，再清理测试状态。频道隔离的纯函数与适配器生命周期测试在 `core-realtime-adapter.spec.ts`，没有向其它 Redis 库写测试键。

这些检查覆盖同机两进程与实际测试 Redis，不代表多主机网络、负载均衡、共享存储、S3、Redis 故障转移或生产容量已经验证。
