// The conversation-mode migration: the plan switch becomes the `plan` mode, the retired trust mode asks,
// per-record trust is cleared, the `review` tool policy becomes `ask` (local and external tools), the
// retired trust parameter goes; down() brings the plan switch back. The migration is the newest one, so
// reverting it reverts nothing after it; every case runs all migrations again afterwards.
import { DataSource } from 'typeorm'
import { dataSourceOptions } from '../../src/db/data-source.js'
import { hardenTenancy } from '../../src/db/tenancy-harden.js'
import { AgentModes20261027210907 } from '../../src/db/migrations/20261027210907-agent-modes.js'
import {
  SOURCE_MIGRATIONS,
  SCRIPT_CASE_MS,
  MigrationCaseFence,
  migrationTests,
} from '../setup/migrations.js'
import { recoverMigrationRun } from '../setup/migration-run-safety.js'
import { restoreTestSchema } from '../setup/schema.js'

const USER = 9_800_000_003
const TOOL = 'test.modes.write'
const SERVER = 'e2e-modes-srv'
const migration = new AgentModes20261027210907()
const fence = new MigrationCaseFence()
const test = migrationTests(it, fence)
let ds: DataSource

/** 只清理本用例自己建的行。 */
async function clear() {
  await ds.query('DELETE FROM agent_thread WHERE user_id = ?', [USER])
  await ds.query('DELETE FROM agent_profile WHERE owner_user_id = ?', [USER])
  await ds.query('DELETE FROM cfg_mcp_tool WHERE name = ?', [TOOL])
  await ds.query(
    'DELETE t FROM agent_mcp_tool t JOIN agent_mcp_server s ON s.id = t.server_id WHERE s.name = ?',
    [SERVER],
  )
  await ds.query('DELETE FROM agent_mcp_server WHERE name = ?', [SERVER])
}

/** 撤回到本迁移之前（它是最新的一个，之后没有别的迁移要一起撤回）。 */
async function undoModes() {
  while (
    (await ds.query<{ name: string }[]>('SELECT name FROM meta_migrations')).some(
      (row) => row.name === migration.name,
    )
  )
    await ds.undoLastMigration({ transaction: 'each' })
}

const threads = () =>
  ds.query<{ title: string; approval_mode: string; trusted: unknown }[]>(
    'SELECT title, approval_mode, trusted FROM agent_thread WHERE user_id = ? ORDER BY id',
    [USER],
  )

beforeAll(async () => {
  ds = await new DataSource({ ...dataSourceOptions(), migrations: SOURCE_MIGRATIONS }).initialize()
  fence.install(ds)
})
beforeEach((context) => {
  if (fence.unsafe)
    context.skip('database is rebuilt after a migration case that may have left it half migrated')
  fence.begin(context.signal)
})
afterEach(async () => {
  await fence.drain()
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

test('turns the plan switch into the plan mode, trust into ask, review into ask; drops the trust param', async () => {
  await undoModes()
  for (const [tenant, title, mode, plan, trusted] of [
    [1, 'plan', 'ask', 1, null],
    [2, 'plan-review', 'auto_review', 1, null],
    [1, 'read-only', 'read_only', 1, null],
    [2, 'trust', 'trust', 0, JSON.stringify(['5#demo.customer.update|id:1'])],
    [1, 'ask', 'ask', 0, JSON.stringify(['6#demo.book.create|id:2'])],
  ] as const)
    await ds.query(
      'INSERT INTO agent_thread (tenant_id, user_id, title, approval_mode, plan_mode, trusted) VALUES (?, ?, ?, ?, ?, ?)',
      [tenant, USER, title, mode, plan, trusted],
    )
  await ds.query(
    "INSERT INTO agent_profile (tenant_id, owner_user_id, name, approval_mode) VALUES (2, ?, 'trusting', 'trust')",
    [USER],
  )
  await ds.query("INSERT INTO cfg_mcp_tool (name, enabled, agent_policy) VALUES (?, 1, 'review')", [
    TOOL,
  ])
  await ds.query(
    "INSERT INTO agent_mcp_server (name, url, auth_kind, enabled) VALUES (?, 'https://mcp.example.com/mcp', 'none', 1)",
    [SERVER],
  )
  const [server] = await ds.query<{ id: number }[]>(
    'SELECT id FROM agent_mcp_server WHERE name = ?',
    [SERVER],
  )
  await ds.query(
    "INSERT INTO agent_mcp_tool (server_id, name, enabled, policy) VALUES (?, 'w', 1, 'review')",
    [server!.id],
  )
  await ds.query("DELETE FROM cfg_param WHERE param_key = 'agent.trust_mode'")
  await ds.query(
    "INSERT INTO cfg_param (param_key, param_value, name) VALUES ('agent.trust_mode', 'false', 'trust')",
  )

  await ds.runMigrations({ transaction: 'each' })

  expect((await threads()).map((t) => [t.title, t.approval_mode, t.trusted])).toEqual([
    ['plan', 'plan', null],
    ['plan-review', 'plan', null],
    ['read-only', 'read_only', null],
    ['trust', 'ask', null],
    // per-record trust never becomes a whole-tool allowance
    ['ask', 'ask', null],
  ])
  const columns = await ds.query<{ c: number }[]>(
    "SELECT COUNT(*) AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'agent_thread' AND column_name = 'plan_mode'",
  )
  expect(Number(columns[0]!.c)).toBe(0)
  expect(
    await ds.query('SELECT approval_mode FROM agent_profile WHERE owner_user_id = ?', [USER]),
  ).toEqual([{ approval_mode: 'ask' }])
  expect(await ds.query('SELECT agent_policy FROM cfg_mcp_tool WHERE name = ?', [TOOL])).toEqual([
    { agent_policy: 'ask' },
  ])
  expect(
    await ds.query('SELECT policy FROM agent_mcp_tool WHERE server_id = ?', [server!.id]),
  ).toEqual([{ policy: 'ask' }])
  expect(await ds.query("SELECT id FROM cfg_param WHERE param_key = 'agent.trust_mode'")).toEqual(
    [],
  )
})

test('down() brings the plan switch back, turns plan profiles and human-only policies into ask', async () => {
  await ds.query(
    "INSERT INTO agent_thread (tenant_id, user_id, title, approval_mode, trusted) VALUES (1, ?, 'plan', 'plan', ?), (2, ?, 'ask', 'ask', ?)",
    [USER, JSON.stringify(['5#demo.book.create']), USER, JSON.stringify(['6#demo.book.create'])],
  )
  await ds.query("INSERT INTO cfg_mcp_tool (name, enabled, agent_policy) VALUES (?, 1, 'human')", [
    TOOL,
  ])
  await ds.query(
    "INSERT INTO agent_profile (tenant_id, owner_user_id, name, approval_mode) VALUES (1, ?, 'planning', 'plan')",
    [USER],
  )
  await undoModes()
  const rows = await ds.query<
    { title: string; approval_mode: string; plan_mode: number; trusted: unknown }[]
  >(
    'SELECT title, approval_mode, plan_mode, trusted FROM agent_thread WHERE user_id = ? ORDER BY id',
    [USER],
  )
  expect(rows.map((r) => [r.title, r.approval_mode, Number(r.plan_mode), r.trusted])).toEqual([
    ['plan', 'ask', 1, null],
    ['ask', 'ask', 0, null],
  ])
  expect(await ds.query('SELECT agent_policy FROM cfg_mcp_tool WHERE name = ?', [TOOL])).toEqual([
    { agent_policy: 'ask' },
  ])
  // the old code knows no plan mode on a profile either
  expect(
    await ds.query('SELECT approval_mode FROM agent_profile WHERE owner_user_id = ?', [USER]),
  ).toEqual([{ approval_mode: 'ask' }])
})
