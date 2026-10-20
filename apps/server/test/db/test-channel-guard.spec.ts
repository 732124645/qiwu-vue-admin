// The server test run's channel guard (test/setup/test-channel.ts): globalSetup resets only a registered
// test database / Redis db pair, so a checkout pointing at its own database but another run's Redis db
// (or the reverse) stops before anything is dropped or flushed, and so does a second run on a database
// this run holds; releasing the lock after MySQL dropped its connection does not fail the run.
import { DataSource } from 'typeorm'
import { dataSourceOptions } from '../../src/db/data-source.js'
import { assertTestChannel, holdTestRun } from '../setup/test-channel.js'

const pairs = [
  ['qiwu_test', '15'],
  ['qiwu_alt_test', '7'],
]

it('accepts a registered pair, refuses a mixed or missing one with the allowed pairs named', async () => {
  await expect(assertTestChannel({ DB_NAME: 'qiwu_test', REDIS_DB: '15' }, pairs)).resolves.toBe(
    undefined,
  )
  await expect(assertTestChannel({ DB_NAME: 'qiwu_alt_test', REDIS_DB: '7' }, pairs)).resolves.toBe(
    undefined,
  )
  for (const env of [
    { DB_NAME: 'qiwu_alt_test', REDIS_DB: '15' },
    { DB_NAME: 'qiwu_test', REDIS_DB: '7' },
    { DB_NAME: 'qiwu_test' },
  ])
    await expect(assertTestChannel(env, pairs)).rejects.toThrow(
      /allowed DB_NAME\/REDIS_DB pairs: \(qiwu_test, 15\), \(qiwu_alt_test, 7\).*\.env\.test\.local/,
    )
})

it('this run itself is on a registered pair (the default one or a listed lane)', async () => {
  await expect(assertTestChannel(process.env)).resolves.toBeUndefined()
})

it('a second run on the database this run holds is refused; another database is free', async () => {
  const ds = await new DataSource(dataSourceOptions()).initialize()
  try {
    // globalSetup of this very run holds the lock on its own connection
    await expect(holdTestRun(ds)).rejects.toThrow(
      `another run is using the database '${process.env.DB_NAME}'`,
    )
    const release = await holdTestRun(ds, 'qiwu_unused_test')
    await expect(holdTestRun(ds, 'qiwu_unused_test')).rejects.toThrow('qiwu_unused_test')
    await release()
    await (
      await holdTestRun(ds, 'qiwu_unused_test')
    )()
    // MySQL dropped the lock's idle connection during a long run: releasing still succeeds, the lock is gone
    const lost = await holdTestRun(ds, 'qiwu_unused_test')
    const [{ owner }] = await ds.query('SELECT IS_USED_LOCK(?) AS owner', [
      'qw:test-run:qiwu_unused_test',
    ])
    await ds.query('KILL ?', [Number(owner)])
    await expect(lost()).resolves.toBeUndefined()
    await (
      await holdTestRun(ds, 'qiwu_unused_test')
    )()
  } finally {
    await ds.destroy()
  }
})
