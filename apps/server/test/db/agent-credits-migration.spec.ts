import { DataSource } from 'typeorm'
import type { TestFunction } from 'vitest'
import { dataSourceOptions } from '../../src/db/data-source.js'
import { hardenTenancy } from '../../src/db/tenancy-harden.js'
import {
  MIGRATION_NAMES,
  SOURCE_MIGRATIONS,
  SCRIPT_CASE_MS,
  MigrationCaseFence,
} from '../setup/migrations.js'
import { recoverMigrationRun } from '../setup/migration-run-safety.js'
import { restoreTestSchema } from '../setup/schema.js'

const CREDIT_MIGRATION = MIGRATION_NAMES.find((name) => name.startsWith('AgentCredits'))!
const USER = 9_800_000_001
const DAY = '2000-01-02'
let ds: DataSource
const fence = new MigrationCaseFence()
/** 升级测试也复用长迁移保护，下游增加后续迁移时不重新引入超时污染。 */
const test = (name: string, body: TestFunction, timeout = SCRIPT_CASE_MS) =>
  Reflect.apply(it, undefined, [name, fence.wrap(body), timeout])

/** 连同后来的迁移一起回退，避免下游新增迁移后在不完整结构上测试升级。 */
async function revertCredits() {
  while (
    (await ds.query<{ name: string }[]>('SELECT name FROM meta_migrations')).some(
      (row) => row.name === CREDIT_MIGRATION,
    )
  )
    await ds.undoLastMigration({ transaction: 'each' })
}

/** 只清除本用例的历史日期和用户，保留其他用例的数据。 */
async function clear() {
  await ds.query('DELETE FROM agent_usage WHERE user_id = ? AND day = ?', [USER, DAY])
  await ds.query('DELETE FROM agent_turn WHERE user_id = ?', [USER])
}

beforeAll(async () => {
  if (!CREDIT_MIGRATION) throw new Error('Credit migration missing from source migrations')
  ds = await new DataSource({ ...dataSourceOptions(), migrations: SOURCE_MIGRATIONS }).initialize()
  fence.install(ds)
})

beforeEach((context) => {
  if (fence.unsafe)
    context.skip('a prior migration case failed; the database is rebuilt before continuing')
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

test(
  'preserves old token totals and marks old pricing unknown across tenants',
  async () => {
    await revertCredits()
    for (const tenant of [1, 2]) {
      await ds.query(
        `INSERT INTO agent_usage (tenant_id,user_id,day,model,calls,prompt_tokens,completion_tokens)
       VALUES (?,?,?,'historic-model',3,120,50)`,
        [tenant, USER, DAY],
      )
      await ds.query(
        `INSERT INTO agent_turn (tenant_id,thread_id,user_id,status,prompt_tokens,completion_tokens)
       VALUES (?,999999,?,'completed',120,50)`,
        [tenant, USER],
      )
    }
    await ds.runMigrations({ transaction: 'each' })
    const rows = await ds.query<
      {
        tenant_id: number
        prompt_tokens: number
        completion_tokens: number
        credits: string
        legacy_calls: number
        cache_read_tokens: number | null
      }[]
    >('SELECT * FROM agent_usage WHERE user_id = ? ORDER BY tenant_id', [USER])
    expect(rows).toHaveLength(2)
    for (const row of rows)
      expect(row).toMatchObject({
        prompt_tokens: 120,
        completion_tokens: 50,
        credits: '0.000000',
        legacy_calls: 3,
        cache_read_tokens: null,
      })
    const turns = await ds.query<{ legacy_usage: number }[]>(
      'SELECT legacy_usage FROM agent_turn WHERE user_id = ?',
      [USER],
    )
    expect(turns.map((turn) => turn.legacy_usage)).toEqual([1, 1])
  },
  SCRIPT_CASE_MS,
)

test(
  'separates same-name models by provider and rejects a lossy old-key rollback',
  async () => {
    for (const provider of [101, 102])
      await ds.query(
        `INSERT INTO agent_usage (tenant_id,user_id,day,model,provider_id,calls,prompt_tokens,completion_tokens)
       VALUES (1,?,?,'same-model',?,1,10,5)`,
        [USER, DAY, provider],
      )
    await expect(revertCredits()).rejects.toThrow('Provider-specific usage conflicts')
    const [table] = await ds.query<{ n: number }[]>(
      `SELECT COUNT(*) AS n FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = 'agent_usage_entry'`,
    )
    expect(Number(table!.n)).toBe(1)
    await clear()
    await revertCredits()
    await ds.runMigrations({ transaction: 'each' })
  },
  SCRIPT_CASE_MS,
)

test(
  'keeps case-distinct model identifiers separate and rejects their lossy rollback',
  async () => {
    for (const model of ['case-model', 'Case-Model'])
      await ds.query(
        `INSERT INTO agent_usage (tenant_id,user_id,day,model,provider_id,calls,prompt_tokens,completion_tokens)
       VALUES (1,?,?,?,101,1,10,5)`,
        [USER, DAY, model],
      )
    const rows = await ds.query<{ model: string }[]>(
      'SELECT model FROM agent_usage WHERE user_id = ? AND day = ?',
      [USER, DAY],
    )
    expect(rows).toHaveLength(2)
    await expect(revertCredits()).rejects.toThrow('Provider-specific usage conflicts')
    await clear()
  },
  SCRIPT_CASE_MS,
)

test(
  'stores large turn totals without truncation and refuses an unsafe integer downgrade',
  async () => {
    await ds.query(
      "INSERT INTO agent_turn (tenant_id,thread_id,user_id,status,prompt_tokens,completion_tokens) VALUES (1,999999,?,'completed',2147483648,0)",
      [USER],
    )
    const [turn] = await ds.query<{ prompt_tokens: number }[]>(
      'SELECT prompt_tokens FROM agent_turn WHERE user_id=?',
      [USER],
    )
    expect(Number(turn!.prompt_tokens)).toBe(2147483648)
    await expect(revertCredits()).rejects.toThrow('Turn token totals exceed old integer storage')
    await clear()
  },
  SCRIPT_CASE_MS,
)
