import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { DataSource } from 'typeorm'
import { MigrationCaseFence } from '../setup/migrations.js'
import {
  assertMigrationRunSafe,
  clearMigrationRunUnsafe,
  markMigrationRunUnsafe,
  migrationRunUnsafe,
  migrationSafetyFile,
  recoverMigrationRun,
} from '../setup/migration-run-safety.js'

let env: NodeJS.ProcessEnv
beforeEach(() => {
  vi.stubEnv('DB_NAME', `qiwu_fence_${process.pid}_${Math.random().toString(16).slice(2)}_test`)
  env = { ...process.env }
})
afterEach(() => {
  rmSync(migrationSafetyFile(env), { force: true, recursive: true })
  vi.unstubAllEnvs()
})

it('abort waits for the current query and original finally, refuses later SQL, and only then permits recovery', async () => {
  const events: string[] = []
  let release!: () => void
  let entered!: () => void
  const first = new Promise<void>((resolve) => (release = resolve))
  const started = new Promise<void>((resolve) => (entered = resolve))
  const ds = {
    createQueryRunner: () => ({
      query: async (sql: string) => {
        events.push(sql)
        if (sql === 'first') {
          entered()
          await first
          events.push('query finished')
        }
      },
    }),
  } as unknown as Pick<DataSource, 'createQueryRunner'>
  const fence = new MigrationCaseFence(200)
  fence.install(ds)
  const controller = new AbortController()
  fence.begin(controller.signal)
  const work = fence.wrap(async () => {
    try {
      await ds.createQueryRunner().query('first')
      await ds.createQueryRunner().query('must not run')
    } finally {
      await ds.createQueryRunner().query('ROLLBACK')
      events.push('case finished')
    }
  })()
  const failed = work.catch((error) => error)
  await started
  expect(migrationRunUnsafe()).toBe(true)
  controller.abort()
  const drained = fence.drain(true).then(() => events.push('drained'))
  // 即使外部换了当前 signal，旧用例的异步上下文仍只能看到自身已中止的信号。
  fence.begin(new AbortController().signal)
  await delay(10)
  expect(events).toEqual(['first'])
  release()
  expect(await failed).toMatchObject({ name: 'AbortError' })
  await drained
  expect(events).toEqual(['first', 'query finished', 'ROLLBACK', 'case finished', 'drained'])
  expect(fence.unsafe).toBe(true)
  await recoverMigrationRun(async () => {
    events.push('rebuilt')
  })
  expect(events.at(-1)).toBe('rebuilt')
  expect(migrationRunUnsafe()).toBe(false)
})

it('successful cases clear their marker; failed recovery keeps it and other channels remain independent', async () => {
  const fence = new MigrationCaseFence(200)
  fence.begin(new AbortController().signal)
  await fence.wrap(async () => 'ok')()
  await fence.drain(false)
  expect(migrationRunUnsafe()).toBe(false)
  await expect(
    recoverMigrationRun(async () => {
      throw new Error('restore failed')
    }),
  ).rejects.toThrow('restore failed')
  expect(() => assertMigrationRunSafe()).toThrow('unfinished migrations')
  expect(migrationRunUnsafe({ ...env, DB_NAME: `${env.DB_NAME}_other_test` })).toBe(false)
  await recoverMigrationRun(async () => undefined)
  expect(() => assertMigrationRunSafe()).not.toThrow()
})

it('marker read/write failures refuse work instead of treating the channel as clean', async () => {
  mkdirSync(migrationSafetyFile(env))
  expect(() => migrationRunUnsafe()).toThrow('cannot read migration safety marker')
  const restore = vi.fn<() => Promise<void>>(async () => undefined)
  await expect(recoverMigrationRun(restore)).rejects.toThrow(/EISDIR|EPERM/i)
  expect(restore).not.toHaveBeenCalled()
  expect(() => markMigrationRunUnsafe()).toThrow(/EISDIR|EPERM/i)
})

it('a real Vitest run blocks afterAll and later files after a stuck migration; a successful rebuild enables the next run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qw-fence-run-'))
  const helper = fileURLToPath(new URL('../setup/migrations.ts', import.meta.url))
  const safety = fileURLToPath(new URL('../setup/migration-run-safety.ts', import.meta.url))
  const nodeApi = new URL('../../node_modules/vitest/dist/node.js', import.meta.url).href
  const binary = fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url))
  const after = join(dir, 'after.flag'),
    later = join(dir, 'later.flag')
  const setup = join(dir, 'safety.ts'),
    config = join(dir, 'vitest.config.mjs')
  writeFileSync(
    setup,
    `import { assertMigrationRunSafe } from ${JSON.stringify(safety)}; assertMigrationRunSafe();`,
  )
  writeFileSync(
    join(dir, '01-fatal.spec.ts'),
    `
import { writeFileSync } from 'node:fs';
import { MigrationCaseFence } from ${JSON.stringify(helper)};
afterAll(() => writeFileSync(${JSON.stringify(after)}, 'must not recover'));
const fence = new MigrationCaseFence(20);
const ds = {createQueryRunner: () => ({query: () => new Promise(() => {})})};
fence.install(ds);
beforeEach(({ signal }) => fence.begin(signal));
afterEach(async ({ signal }) => await fence.drain(signal.aborted), 200);
it('in-flight SQL never returns', fence.wrap(async () => await ds.createQueryRunner().query('fake SQL')), 10);
`,
  )
  writeFileSync(
    join(dir, '02-later.spec.ts'),
    `import { writeFileSync } from 'node:fs'; it('later SQL path', () => writeFileSync(${JSON.stringify(later)}, 'must not execute'));`,
  )
  const run = (guard: boolean, onlyLater = false) => {
    writeFileSync(
      config,
      `import { BaseSequencer } from ${JSON.stringify(nodeApi)};
class Order extends BaseSequencer { sort(files) { return files.sort((a,b) => a.moduleId.localeCompare(b.moduleId)) } }
export default {ssr:{resolve:{conditions:['source']}},test:{globals:true,globalSetup:[],setupFiles:${JSON.stringify(guard ? [setup] : [])},include:[${JSON.stringify(join(dir, onlyLater ? '02-later.spec.ts' : '*.spec.ts'))}],fileParallelism:false,maxWorkers:1,pool:'forks',sequence:{sequencer:Order},testTimeout:20000}};
`,
    )
    return spawnSync(process.execPath, [binary, 'run', '--config', config], {
      encoding: 'utf8',
      timeout: 30_000,
      env,
    })
  }
  try {
    const baseline = run(false)
    expect(baseline.status).not.toBe(0)
    expect(existsSync(after)).toBe(false)
    expect(existsSync(later)).toBe(true)
    clearMigrationRunUnsafe(env)
    rmSync(later)
    const protectedRun = run(true)
    expect(protectedRun.status).not.toBe(0)
    expect(protectedRun.error).toBeUndefined()
    expect(`${protectedRun.stdout}${protectedRun.stderr}`).toContain('stopping this worker')
    expect(existsSync(after)).toBe(false)
    expect(existsSync(later)).toBe(false)
    expect(migrationRunUnsafe(env)).toBe(true)
    await expect(
      recoverMigrationRun(async () => {
        throw new Error('rebuild failed')
      }, env),
    ).rejects.toThrow('rebuild failed')
    expect(migrationRunUnsafe(env)).toBe(true)
    await recoverMigrationRun(async () => undefined, env)
    const next = run(true, true)
    expect(next.status).toBe(0)
    expect(existsSync(later)).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 100_000)

it('plain and parameterized registrations fence actual Vitest timeouts before every SQL step', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qw-fence-registrations-'))
  const helper = fileURLToPath(new URL('../setup/migrations.ts', import.meta.url))
  const safety = fileURLToPath(new URL('../setup/migration-run-safety.ts', import.meta.url))
  const binary = fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url))
  const spec = join(dir, 'registration.spec.ts'),
    config = join(dir, 'vitest.config.mjs'),
    resultFile = join(dir, 'events.json')
  const run = (wrapped: boolean, parameterized: boolean) => {
    writeFileSync(
      spec,
      `
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { MigrationCaseFence, migrationTests } from ${JSON.stringify(helper)};
import { migrationRunUnsafe, recoverMigrationRun } from ${JSON.stringify(safety)};
const events = [];
const fence = new MigrationCaseFence(200);
const ds = {createQueryRunner: () => ({query: async sql => {
 events.push(sql);
 if (sql.startsWith('first:')) { events.push('marked:' + migrationRunUnsafe()); await delay(70); events.push('query finished'); }
}})};
fence.install(ds);
const nativeIt = globalThis.it;
const it = ${wrapped ? 'migrationTests(nativeIt, fence)' : 'nativeIt'};
beforeEach(({signal}) => fence.begin(signal));
afterEach(async ({signal}) => { await fence.drain(signal.aborted); events.push('drained'); }, 500);
afterAll(async () => {
 await recoverMigrationRun(async () => events.push('recovered'));
 await delay(100);
 writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(events));
}, 500);
const body = async label => {
 const q = ds.createQueryRunner();
 try { await q.query('first:' + label); await q.query('late DDL'); }
 finally { await q.query('ROLLBACK'); events.push('finally finished'); }
};
${parameterized ? "it.each(['row'])('parameter %s', async label => await body(label), 10);" : "it('plain callback', async () => await body('plain'), 10);"}
`,
    )
    writeFileSync(
      config,
      `export default {ssr:{resolve:{conditions:['source']}},test:{globals:true,globalSetup:[],setupFiles:[],include:[${JSON.stringify(spec)}],fileParallelism:false,pool:'forks'}};`,
    )
    const result = spawnSync(process.execPath, [binary, 'run', '--config', config], {
      encoding: 'utf8',
      timeout: 20_000,
      env,
    })
    expect(result.status).not.toBe(0)
    expect(result.error).toBeUndefined()
    expect(`${result.stdout}${result.stderr}`).toContain('timed out')
    return JSON.parse(readFileSync(resultFile, 'utf8')) as string[]
  }
  try {
    for (const parameterized of [false, true]) {
      const before = run(false, parameterized)
      expect(before).toContain('marked:false')
      expect(before).toContain('late DDL')
      expect(before.indexOf('recovered')).toBeLessThan(before.indexOf('query finished'))
      const after = run(true, parameterized)
      expect(after).toContain(parameterized ? 'first:row' : 'first:plain')
      expect(after).toContain('marked:true')
      expect(after).not.toContain('late DDL')
      expect(after.indexOf('query finished')).toBeLessThan(after.indexOf('finally finished'))
      expect(after.indexOf('finally finished')).toBeLessThan(after.indexOf('drained'))
      expect(after.indexOf('drained')).toBeLessThan(after.indexOf('recovered'))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 100_000)
