import { DataSource } from 'typeorm'
import { dataSourceOptions } from '../../src/db/data-source.js'
import { hardenTenancy } from '../../src/db/tenancy-harden.js'
import { AgentRecovery20261026233227 } from '../../src/db/migrations/20261026233227-agent-recovery.js'
import {
  SOURCE_MIGRATIONS,
  SCRIPT_CASE_MS,
  MigrationCaseFence,
  migrationTests,
} from '../setup/migrations.js'
import { recoverMigrationRun } from '../setup/migration-run-safety.js'
import { restoreTestSchema } from '../setup/schema.js'

const USER = 9_800_000_002
const migration = new AgentRecovery20261026233227()
const fence = new MigrationCaseFence()
const test = migrationTests(it, fence)
let ds: DataSource

/** 清理本用例自己创建的投递和调用，不释放其他会话的永久去重事实。 */
async function clear() {
  for (const table of ['agent_message_receipt', 'agent_usage_entry', 'agent_thread']) {
    // arch-allow: sql-concat fixed test table names; tenant: the fixture owns USER across its two tenant samples
    await ds.query(`DELETE FROM ${table} WHERE user_id = ?`, [USER])
  }
}
beforeAll(async () => {
  ds = await new DataSource({ ...dataSourceOptions(), migrations: SOURCE_MIGRATIONS }).initialize()
  fence.install(ds)
})
beforeEach((context) => {
  if (fence.unsafe) context.skip('database is rebuilt after a failed migration case')
  fence.begin(context.signal)
})
afterEach(async ({ task, signal }) => {
  await fence.drain(task.result?.state === 'fail' || signal.aborted)
  await recoverMigrationRun(async () => {
    if (fence.unsafe) {
      await ds.dropDatabase()
      await restoreTestSchema(ds)
    } else {
      await ds.runMigrations({ transaction: 'each' })
      await clear()
      await hardenTenancy(ds)
    }
  })
}, SCRIPT_CASE_MS)
afterAll(async () => {
  await ds?.destroy()
})

test('backfills historical calls without inventing pending requests or changing billed usage', async () => {
  while (
    (await ds.query<{ name: string }[]>('SELECT name FROM meta_migrations')).some(
      (row) => row.name === migration.name,
    )
  )
    await ds.undoLastMigration({ transaction: 'each' })
  for (const tenant of [1, 2])
    await ds.query(
      `INSERT INTO agent_usage_entry
      (tenant_id,user_id,provider_id,provider_name,model,usage_json,credits,usage_reported,created_at)
      VALUES (?,?,101,'Historic provider','historic-model',?,3.500000,1,'2000-01-02 23:59:59.123')`,
      [tenant, USER, JSON.stringify({ inputTokens: 10, outputTokens: 2 })],
    )
  await ds.runMigrations({ transaction: 'each' })
  const rows = await ds.query<
    {
      status: string
      usage_day: string
      credits: string
      lease_until: Date | null
      settled_at: Date
      created_at: Date
      usage_reported: number
    }[]
  >('SELECT * FROM agent_usage_entry WHERE user_id = ? ORDER BY tenant_id', [USER])
  expect(rows).toHaveLength(2)
  for (const row of rows) {
    expect(row).toMatchObject({
      status: 'complete',
      usage_day: '2000-01-02',
      credits: '3.500000',
      usage_reported: 1,
      lease_until: null,
    })
    expect(row.settled_at).toEqual(row.created_at)
  }
})

test('keeps deleted client identities unique and refuses rollback before durable facts are removed', async () => {
  const q = ds.createQueryRunner()
  try {
    for (const values of [
      { tenant: 1, flag: 1, draft: null },
      { tenant: 2, flag: 0, draft: '00000000-0000-4000-8000-000000000001' },
    ]) {
      await ds.query(
        "INSERT INTO agent_thread (tenant_id,user_id,title,recovery_required,client_draft_id,deleted_at) VALUES (?,?,'Migration fixture',?,?,NOW(3))",
        [values.tenant, USER, values.flag, values.draft],
      )
      await expect(migration.down(q)).rejects.toThrow('require reconciliation before rollback')
      await clear()
    }
    const draft = '00000000-0000-4000-8000-000000000001'
    await ds.query(
      "INSERT INTO agent_thread (tenant_id,user_id,title,client_draft_id,deleted_at) VALUES (2,?,'Deleted draft',?,NOW(3))",
      [USER, draft],
    )
    await expect(
      ds.query(
        "INSERT INTO agent_thread (tenant_id,user_id,title,client_draft_id) VALUES (2,?,'Duplicate draft',?)",
        [USER, draft],
      ),
    ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' })
    await clear()
    await ds.query(
      `INSERT INTO agent_usage_entry
      (tenant_id,user_id,provider_id,provider_name,model,status) VALUES (2,?,101,'Pending provider','pending-model','pending')`,
      [USER],
    )
    await expect(migration.down(q)).rejects.toThrow('require reconciliation before rollback')
    await clear()
    const client = '00000000-0000-4000-8000-000000000002'
    const values = [2, USER, client, 'a'.repeat(64)]
    await ds.query(
      `INSERT INTO agent_message_receipt
      (tenant_id,user_id,thread_id,client_message_id,request_hash,item_id,accepted_turn_id,deleted_at)
      VALUES (?,?,1,?,?,1,1,NOW(3))`,
      values,
    )
    await expect(
      ds.query(
        `INSERT INTO agent_message_receipt
      (tenant_id,user_id,thread_id,client_message_id,request_hash,item_id,accepted_turn_id)
      VALUES (?,?,2,?,?,2,2)`,
        values,
      ),
    ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' })
    await expect(migration.down(q)).rejects.toThrow('require reconciliation before rollback')
    expect(
      await ds.query('SELECT id FROM agent_message_receipt WHERE user_id = ?', [USER]),
    ).toHaveLength(1)
  } finally {
    await q.release()
  }
})
