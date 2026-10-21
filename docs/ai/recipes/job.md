# 配方：队列任务与定时任务

## 适用场景

- **队列任务**：请求里触发、不必当场做完的工作（生成报表、批量通知、调用慢的外部接口）。基于 BullMQ，用应用已有的 Redis；任务在添加它的租户里执行，失败自动重试。
- **定时任务**：按 cron 周期执行的工作（清理、同步、提醒）。管理员在“定时任务”页面配置周期、开关与参数，代码只提供处理器。

两种任务都**至少执行一次**，处理器必须可以安全地重复执行（幂等）。

## 步骤

### 队列任务

1. **声明队列。** 队列名小写短横线、全应用唯一（如 `crm-report`）。在拥有它的模块里 `imports: [registerQueue({ name: 'crm-report' })]`（`apps/server/src/core/queue/queue-registry.ts`）。
2. **写处理器。** 继承 `TenantJobProcessor`（`apps/server/src/core/queue/tenant-job.processor.ts`），用 `@Processor('crm-report')` 标记，只实现 `handle`；把处理器加进模块的 `providers`。`handle` 已在任务所属租户里运行，ORM 自动带租户条件。完整示例见[任务队列：添加队列与处理器](../../queue.md#添加队列与处理器)。
3. **添加任务。** 注入 `QueueService`（`apps/server/src/core/queue/queue.service.ts`），调用 `add(queue, name, payload, opts?)`：

   ```ts
   await this.queues.add('crm-report', 'build', { reportId }, { jobId: `report-${reportId}` })
   ```

   - 任务数据只放 id 等少量字段，处理时再从库里读；不放密码、令牌。
   - 在事务里改了数据：**等事务提交后再添加**，不要在 `@Transactional()` 方法里直接调用 `add`。
   - 需要去重时给 `jobId`；`add` 自动加租户前缀，不同租户的同名 id 互不影响。
   - 后台代码（没有请求租户）为某一行添加任务时，先用 `withTenant(行的租户, …)` 包住并写 `qw:cross-tenant <理由>`，见[手写 SQL 与租户](tenant-sql.md)。

4. **不该重试的错误**抛 BullMQ 的 `UnrecoverableError`；其他错误按默认 3 次、指数退避重试。
5. **只处理平台表的工作**可声明平台级队列 `registerQueue({ name, platform: true })`，它的任务不带租户。

### 定时任务

1. **写处理器方法。** 在模块的某个 provider 上用 `@JobHandler(name, paramsSchema?)`（`apps/server/src/core/scheduler/job-handler.ts`）标记方法 `(params, ctx: JobContext) => Promise<unknown>`。名称小写点分且全应用唯一（如 `crm.customer.recalc`）；参数用 zod schema 声明，每次保存与执行前校验，默认值填进新建任务。
2. **自己选租户。** 调度器调用处理器时**没有租户上下文**。按租户处理数据时，在 `allTenants` 下只扫描可用租户的行，再对每一行 `withTenant(行的租户, …)`，一个租户失败只记录、不影响其余租户；两处都写 `qw:cross-tenant <理由>`。参照 `apps/server/src/modules/workflow/runtime/wf-remind.ts`。
3. **响应中止。** 在步骤之间检查 `ctx.signal`（超时或停机时中止），把它传给 fetch 与定时器；用 `ctx.log(line)` 写执行日志，返回值作为本次执行的结果文本。
4. **建任务。** 管理员在“定时任务”页面新建任务并从下拉框选处理器。要随种子预置时，参照 `apps/server/src/db/seeds/scheduler/scheduler.seed.ts` 的 `TASKS`，在项目种子里 `upsert(q, 'job_task', { handler, name }, {}, { cron, misfire, timeout_ms, … })`：cron 带秒（6 段，如 `0 30 3 * * *`），只在首次插入时写，之后归管理员；任务名用 `seed.task.*` 词条键，中英文写进 `packages/shared/src/i18n/zh-CN/seed.json` 与 `packages/shared/src/i18n/en-US/seed.json`（模板文件，升级时可能冲突，见[升级模板版本](../../upgrade.md#3-常见冲突与处理)）。

## 完成检查

```sh
pnpm --filter @qiwu/server test <你的 spec 文件名去掉 -spec.ts>
pnpm ai:map
pnpm verify
```

定时任务测试直接调用处理器方法；队列处理器的 `handle` 是 `protected`，测试调用公开的 `process(job)`，`job` 至少带 `data: { tenantId, payload }`、`id` 与 `queueName`，它在 `tenantId` 的租户里调用 `handle`。覆盖重复执行与多个租户；队列行为的写法参照 `apps/server/src/core/queue/job-queue.spec.ts`。在“队列监控”“调度日志”页面能看到任务与执行结果。

## 常见错误

- 在事务提交前添加任务：任务被取走时读不到新数据。
- 在没有租户的上下文里（定时任务处理器、`allTenants` 内）调用 `QueueService.add`：抛出 `TenantContextMissing`，先 `withTenant`。
- 定时任务处理器里直接查租户表：没有租户上下文，ORM 拒绝；按第 2 步选租户。
- 扫描出所有租户的行再跳过停用租户：有条数上限的批次会被停用租户的积压占满，在 SQL 里只取可用租户。
- 任务数据里放秘密：Redis 里是明文。
- 处理器不幂等：重试或实例崩溃后重复执行产生重复数据。
- Redis 的 `maxmemory-policy` 不是 `noeviction`：内存不足时排队的任务被悄悄淘汰，见[任务队列：Redis 要求](../../queue.md#redis-要求)。

细节：[任务队列](../../queue.md)、[多租户：编写租户感知的项目代码](../../multi-tenancy.md#编写租户感知的项目代码)。
