# 任务队列

任务队列用来把不必在请求里做完的工作交给后台执行：消息扇出、离线推送的重试、耗时的导出与计算。它基于 [BullMQ](https://docs.bullmq.io/)，直接用应用已有的 Redis，不需要另外部署消息服务（原因见[设计说明](design-notes.md#queue)）。任务至少执行一次：失败按退避重试，进程崩溃时执行中的任务会被其他实例重新取走，所以处理器必须可以安全地重复执行（幂等）。

现有的通知发件箱与定时任务不走队列，保持原样。

## 组成

| 部分                                            | 位置                                 | 作用                                                                                |
| ----------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------- |
| `CoreQueueModule`                               | `core/queue/queue.module.ts`         | 全局模块，已在 `app.module.ts` 注册；连接、键前缀、默认任务选项、启动检查、优雅关闭 |
| `registerQueue({ name, platform? })`            | `core/queue/queue-registry.ts`       | 在拥有该队列的模块里声明队列                                                        |
| `QueueService.add(queue, name, payload, opts?)` | `core/queue/queue.service.ts`        | 添加任务，自动记下当前租户                                                          |
| `TenantJobProcessor`                            | `core/queue/tenant-job.processor.ts` | 处理器基类：在任务所属租户里执行 `handle`                                           |

连接：队列直接使用共享的 node-redis 客户端（`REDIS`）；每个处理器（worker）由 BullMQ 复制出两条自己的连接用于阻塞读取，复制出的连接与原客户端是同一服务器、同一 ACL 用户、同一库号，没有第二套配置。键都在 `qw:queue:<队列名>:…` 下（`cache-namespaces.ts` 的 `queue` 命名空间，缓存列表里可以看到，但不可清理、值不显示）。

## 添加队列与处理器

队列名用小写短横线（`biz-report`），全应用唯一，它是 Redis 键的一部分。在模块里声明队列并提供处理器：

```ts
// apps/server/src/modules/biz/report/report.module.ts
import { Module } from '@nestjs/common'
import { registerQueue } from '../../../core/queue/queue-registry.js'
import { ReportProcessor } from './report.processor.js'
import { ReportService } from './report.service.js'

@Module({
  imports: [registerQueue({ name: 'biz-report' })],
  providers: [ReportService, ReportProcessor],
})
export class ReportModule {}
```

处理器继承 `TenantJobProcessor`，用 `@Processor('<队列名>')` 标记，只实现 `handle`：

```ts
// apps/server/src/modules/biz/report/report.processor.ts
import { Processor } from '@nestjs/bullmq'
import type { Job } from 'bullmq'
import { type QueuedJob, TenantJobProcessor } from '../../../core/queue/tenant-job.processor.js'
import { ReportService } from './report.service.js'

export interface ReportJob {
  reportId: number
}

@Processor('biz-report')
export class ReportProcessor extends TenantJobProcessor<ReportJob> {
  constructor(private readonly reports: ReportService) {
    super()
  }

  // 已在添加任务时的租户里运行：ORM 自动带租户条件
  protected async handle({ reportId }: ReportJob, job: Job<QueuedJob<ReportJob>>) {
    await this.reports.build(reportId)
    return { attempt: job.attemptsMade + 1 }
  }
}
```

在服务里添加任务：

```ts
constructor(private readonly queues: QueueService) {}

async requestBuild(reportId: number) {
  // 同一租户里同一 jobId 的任务还在队列里（含保留的已完成、已失败任务）时不会再次入队
  await this.queues.add('biz-report', 'build', { reportId }, { jobId: `report-${reportId}` })
}
```

在事务里改了数据再添加任务时，**等事务提交后再添加**：任务可能在提交之前就被取走执行，读到的还是旧数据或根本读不到新行。`@Transactional()` 方法里不要直接调 `add`，把它放在事务方法返回之后。

一个队列装着所有租户的任务。租户队列里的自定义 `jobId` 与 `deduplication.id` 由 `add` 存为 `t<租户 id>-<你给的 id>`（返回的 `job.id` 就是它），两个租户用同一个 id 互不影响；按 id 查任务时用返回的 `job.id`。空字符串不算自定义 id，由 BullMQ 自动编号。自定义 id 含 `:` 时必须恰好两个（BullMQ 的规则）；BullMQ 不接受纯数字的自定义 id，租户队列里加了前缀后不再是纯数字，平台级队列里不加前缀，仍不能用纯数字。

任务数据只放 id 等少量字段，处理时再从数据库读取；不要放密码、令牌等秘密（Redis 里是明文，监控页虽然遮蔽带秘密名称的字段，也只是兜底）。

## 租户规则

- `QueueService.add` 把当前上下文的 `tenantId()` 写进任务数据（`{ tenantId, payload }`）。上下文里没有租户（或在 `allTenants` 里）时抛出 `TenantContextMissing`，任务不会入队。后台代码要为某一行添加任务时，先用 `withTenant(行的租户, …)` 包住，并按[多租户规则](multi-tenancy.md)加 `qw:cross-tenant` 理由。
- `TenantJobProcessor` 为每个任务开一个新的上下文（新的追踪 id，不继承任何租户），再在 `withTenant(任务的租户, …)` 里调用 `handle`。
- 任务数据里没有合法租户（缺失、0、非整数、伪造的 `null`）时立即失败、不重试，`handle` 不会执行。
- 租户停用或到期后，它已经入队的任务仍在该租户里执行（与通知发件箱相同）；处理器需要时自行检查租户状态。
- 只处理平台表的任务可以声明平台级队列：`registerQueue({ name: 'platform-sync', platform: true })`。添加时不记租户（`tenantId: null`），处理时没有租户上下文，碰租户表会抛错。

## 重试与保留

默认任务选项（`QUEUE_JOB_DEFAULTS`）：

| 选项               | 默认值           | 含义                                     |
| ------------------ | ---------------- | ---------------------------------------- |
| `attempts`         | 3                | 最多执行 3 次                            |
| `backoff`          | 指数，5 秒       | 第二次在 5 秒后，第三次再过 10 秒        |
| `removeOnComplete` | 保留最近 1000 个 | 更早完成的任务在新任务完成时删除         |
| `removeOnFail`     | 保留最近 5000 个 | 失败任务保留更多，便于在监控页排查和重试 |

`handle` 抛出的错误使这一次失败并按上表重试；明确不该再试的错误抛出 BullMQ 的 `UnrecoverableError`，任务立即进入失败。每次添加时可用第四个参数覆盖：`attempts`、`backoff`、`delay`（延迟执行）、`priority`、`jobId`（去重）等，见 BullMQ 文档。

## 哪些实例运行处理器

默认（`APP_ROLE=all`）应用的每个实例启动时都会为本应用里的每个处理器开一个 worker，同一任务只会被其中一个实例取走；增加实例即增加并发。`APP_ROLE=api` 的实例不开任何 worker（启动的任何时刻都不领任务），只添加任务（`QueueService.add`、`queues()` 照常可用），处理器在启动时登记的 BullMQ 定时任务（智能体的清理、记忆提炼、自动化）也留给开 worker 的实例；`APP_ROLE=worker` 的实例与 `all` 一样开全部 worker。至少要有一个 `all` 或 `worker` 实例，否则任务只进不出；角色说明见[多实例部署](scale-out.md#进程角色)。关闭应用时，worker 在第一阶段（`onModuleDestroy`）停止取新任务并等当前任务执行完，之后其他服务才做各自的关闭工作（定时任务、通知发件箱、Socket.IO），最后关闭 Redis 与数据库连接，所以执行中的任务仍可使用这些服务。多实例的其他前提见[多实例部署](scale-out.md)。

## 队列监控页

系统监控 → 队列监控（`monitor-queue`）：列出本应用注册的全部队列及其等待、优先、执行中、延迟、失败、完成数量与暂停状态；点数量或“查看任务”打开任务抽屉，按状态（失败、完成、延迟、等待、优先、执行中）分页查看任务 id、名称、租户、尝试次数、失败原因、时间与数据。带秘密名称的字段显示为 `***`，这些字段的值出现在失败原因或其他字段里时同样遮蔽，数据最多 500 个字符。失败任务可以重试（尝试次数与退避从头开始），不在执行中的任务可以删除；执行中的任务只读。

- 权限：`monitor.queue.browse`（查看）、`monitor.queue.retry`（重试）、`monitor.queue.remove`（删除），重试与删除记操作日志（`monitor.queue`，`retry` / `remove`）。
- 平台页面：任务数据可能属于任何租户，多租户开关打开时只有平台 root 能打开；演示模式下重试与删除被拦截。
- 接口：`GET /api/monitor/queues`、`GET /api/monitor/queues/:name/jobs?state=failed|completed|delayed|waiting|prioritized|active`、`POST /api/monitor/queues/:name/jobs/:id/retry`、`DELETE /api/monitor/queues/:name/jobs/:id`；未知队列或任务 404，重试未失败的任务、删除执行中的任务（包括检查之后刚被取走的）409。

## Redis 要求

- **`maxmemory-policy` 必须是 `noeviction`**。其他策略在内存不足时会淘汰键，排队中的任务会悄悄丢失。应用启动时读取 `INFO memory`，策略不是 `noeviction` 时记一条警告（不阻止启动）。部署说明见[部署](deploy.md)。
- 应用的 Redis 用户只需 `qw:*` 键与频道授权，另需只读的 `INFO`：BullMQ 每条连接建立时读取 Redis 版本，启动检查读取淘汰策略（Redis 监控页本来也需要它）。BullMQ 用到的其余命令（Lua 脚本、`BZPOPMIN` 阻塞读取、`CLIENT SETNAME`、普通读写）都在现有授权之内，测试即在受限 ACL 用户（`~qw:* &qw:* +@all -@dangerous +info`）下运行。
- 每个 worker 多占两条 Redis 连接，部署时为连接数留出容量。
