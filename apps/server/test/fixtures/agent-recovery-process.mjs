// Bounded child used by the restart integration test: real compiled Nest services, no fake leases.
import 'reflect-metadata'
import { refusal } from '../../../../scripts/gen-check-golden.mjs'
import { z } from 'zod'
import { getDataSourceToken } from '@nestjs/typeorm'
import { McpRegistry } from '../../dist/core/mcp/mcp-registry.js'
import { NestFactory } from '@nestjs/core'
import { AppModule } from '../../dist/app.module.js'
import { QueueService } from '../../dist/core/queue/queue.service.js'
import { withTenant } from '../../dist/core/context/tenant.js'
import { TurnRunner } from '../../dist/core/agent/runtime/turn-runner.js'

if (process.env.NODE_ENV !== 'test' || !process.env.DB_NAME?.endsWith('_test'))
  throw new Error('Recovery child requires the active registered test channel')
const refused = refusal(process.env)
if (refused) throw new Error(`Recovery child: ${refused}`)
const app = await NestFactory.createApplicationContext(AppModule, { logger: false })
app.enableShutdownHooks()
await Promise.all(
  app
    .get(QueueService)
    .workers()
    .map((worker) => worker.pause(true)),
)
app.get(McpRegistry).add(
  {
    name: 'test.recovery.write',
    title: 'Change a fixture record',
    description: 'Changes one record',
    kind: 'write',
    perm: null,
    input: z.object({ id: z.number().int().positive() }),
  },
  async ({ id }) => {
    // 独立提交后故意停在回传结果之前，进程强杀必须被判为副作用不明。
    await app
      .get(getDataSourceToken())
      .query(
        'UPDATE agent_thread SET summary_seq = summary_seq + 1 WHERE id = ? AND tenant_id = 1',
        [id],
      )
    await new Promise(() => {})
  },
)
process.on('message', (message) => {
  if (message?.command === 'shutdown') {
    // Windows 的测试走同一 Nest 关闭生命周期；不能把强制终止当作 POSIX 信号排空。
    void app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    )
    return
  }
  if (message?.command !== 'run') return
  void withTenant(1, () => app.get(TurnRunner).run(message.turnId)).then(
    () => process.send?.({ type: 'finished', turnId: message.turnId }),
    (error) => process.send?.({ type: 'failed', name: error?.name, message: error?.message }),
  )
})
process.send?.({ type: 'ready' })
