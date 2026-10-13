import { DataSource } from 'typeorm'
import {
  allTenants,
  DEFAULT_TENANT_ID,
  TenantContextMissing,
  withTenant,
} from '../../src/core/context/tenant.js'
import {
  expireClaims,
  fillTemplate,
  NOTIFY_CLAIM_TIMEOUT_MS,
  NOTIFY_MAX_ATTEMPTS,
  Notifier,
  NotifyChannels,
  NotifyDispatcher,
  type NotifyChannel,
  type NotifyDraft,
  type NotifyTemplate,
} from '../../src/core/notify/notify.js'
import { dataSourceOptions } from '../../src/db/data-source.js'
import { addRow, addUser, createTenant, type TestTenant } from '../setup/tenants.js'

describe('fillTemplate', () => {
  it('replaces known and repeated names, leaving unknown names intact', () => {
    expect(fillTemplate('{a}/{a}/{x}', { a: 'yes' })).toBe('yes/yes/{x}')
  })

  it('escapes substituted HTML values only when requested', () => {
    const text = '<i>{a}</i>'
    const values = { a: `<b>&"'` }
    expect(fillTemplate(text, values)).toBe(`<i><b>&"'</i>`)
    expect(fillTemplate(text, values, true)).toBe('<i>&lt;b&gt;&amp;&quot;&#39;</i>')
  })

  it('keeps replacement-string specials literal and never expands a replacement again', () => {
    expect(fillTemplate('{a}/{b}', { a: '$&/$1/{b}', b: 'done' })).toBe('$&/$1/{b}/done')
  })

  it('does not treat inherited property names as supplied values', () => {
    expect(fillTemplate('{constructor}', {})).toBe('{constructor}')
  })
})

describe('NotifyChannels', () => {
  it('registers, looks up and lists channels; rejects a duplicate code', () => {
    const registry = new NotifyChannels()
    const inbox = { code: 'inbox' } as NotifyChannel
    const mail = { code: 'mail' } as NotifyChannel
    expect(registry.get('inbox')).toBeUndefined()
    expect(registry.all()).toEqual([])
    registry.register(inbox)
    registry.register(mail)
    expect(registry.get('inbox')).toBe(inbox)
    expect(registry.get('sms')).toBeUndefined()
    expect(registry.all()).toEqual([inbox, mail])
    expect(() => registry.register({ code: 'inbox' } as NotifyChannel)).toThrow(
      /already registered/,
    )
    expect(registry.all()).toEqual([inbox, mail])
  })
})

describe('NotifyDispatcher', () => {
  it('delivers rows sequentially within a channel while channels run together', async () => {
    const starts: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const channels = new NotifyChannels()
    channels.register({
      code: 'inbox',
      deliver: async (id: number) => {
        starts.push(`inbox:${id}`)
        if (id === 1) await gate
      },
    } as NotifyChannel)
    channels.register({
      code: 'mail',
      deliver: async (id: number) => {
        starts.push(`mail:${id}`)
      },
    } as NotifyChannel)
    const flushed = new NotifyDispatcher(channels).flush({ inbox: [1, 2], mail: [3] })
    expect(starts).toEqual(['inbox:1', 'mail:3'])
    release()
    await flushed
    expect(starts).toEqual(['inbox:1', 'mail:3', 'inbox:2'])
  })
})

// The raw SQL of notify.ts against the test database, with a second tenant B (createTenant): send() looks
// its recipients up in the caller's tenant; expireClaims (a table name spliced in) fails the lost claims
// of every tenant, whichever tenant calls it.
describe('notify.ts with two tenants', () => {
  const CODE = 'core-notify-tenants'
  let ds: DataSource
  let B: TestTenant
  let aUser = 0
  let bUser = 0
  /** the default tenant's rows of this block, by table (B's go with B.dispose()) */
  const mine: Record<string, number[]> = { msg_inbox: [], msg_mail_record: [] }

  beforeAll(async () => {
    ds = await new DataSource(dataSourceOptions()).initialize()
    B = await createTenant(ds)
    aUser = await addUser(ds, DEFAULT_TENANT_ID, CODE)
    bUser = await addUser(ds, B.id, CODE)
  })

  afterAll(async () => {
    if (!ds?.isInitialized) return
    await B?.dispose()
    // table names of this block
    for (const [table, ids] of Object.entries(mine))
      if (ids.length) await ds.query(`DELETE FROM ${table} WHERE id IN (?)`, [ids])
    if (aUser) await ds.query('DELETE FROM iam_user WHERE id = ?', [aUser])
    await ds.destroy()
  })

  it("send() names the users of the caller's tenant only; across all tenants it names none (throws)", async () => {
    const seen: (number | null)[] = []
    const channels = new NotifyChannels()
    channels.register({
      code: 'inbox',
      templates: async () => [{ id: 1, code: CODE, locale: 'en-US' }],
      write: async ({ recipient }: NotifyDraft<NotifyTemplate>) => {
        seen.push(recipient.userId)
        return null
      },
    } as unknown as NotifyChannel)
    const notifier = new Notifier(
      { tx: ds.manager, isTransactionActive: () => false } as never,
      channels,
      new NotifyDispatcher(channels),
      {} as never,
      {} as never,
      { get: async () => null } as never,
    )
    const send = () => notifier.send({ template: CODE, to: [aUser, bUser] })
    await withTenant(DEFAULT_TENANT_ID, send)
    expect(seen.splice(0)).toEqual([aUser])
    await withTenant(B.id, send)
    expect(seen.splice(0)).toEqual([bUser])
    await expect(allTenants(send)).rejects.toThrow(TenantContextMissing)
    expect(seen).toEqual([])
  })

  it.each([
    ['msg_inbox', false],
    ['msg_mail_record', true],
  ] as const)(
    'expireClaims over %s fails the lost claims of both tenants, called from one of them',
    async (table, withError) => {
      const stale = new Date(Date.now() - NOTIFY_CLAIM_TIMEOUT_MS - 1000)
      const row = (attempts: number, claimedAt: Date) => ({
        ...(table === 'msg_inbox'
          ? { user_id: aUser, category: 'system', title: CODE }
          : { to_list: JSON.stringify(['someone@example.invalid']), subject: CODE }),
        template_code: CODE,
        locale: 'en-US',
        body: CODE,
        status: 'sending',
        attempts,
        claimed_at: claimedAt,
      })
      const lostA = await addRow(ds, DEFAULT_TENANT_ID, table, row(NOTIFY_MAX_ATTEMPTS, stale))
      mine[table]!.push(lostA)
      const lostB = await addRow(ds, B.id, table, row(NOTIFY_MAX_ATTEMPTS, stale))
      // a live claim, and a lost one with an attempt left (a delivery claims it again): both stay
      const liveB = await addRow(ds, B.id, table, row(NOTIFY_MAX_ATTEMPTS, new Date()))
      const retryB = await addRow(ds, B.id, table, row(1, stale))
      await withTenant(DEFAULT_TENANT_ID, () => expireClaims(ds.manager, table, withError))
      const rows = await ds.query<{ id: number; status: string; error?: string | null }[]>(
        // table names of this block; both tenants' rows by id
        `SELECT id, status${withError ? ', error' : ''} FROM ${table} WHERE id IN (?) ORDER BY id`,
        [[lostA, lostB, liveB, retryB]],
      )
      const failed = withError ? { status: 'failed', error: 'interrupted' } : { status: 'failed' }
      const sending = withError ? { status: 'sending', error: null } : { status: 'sending' }
      expect(rows.map(({ id, ...rest }) => [Number(id), rest])).toEqual([
        [lostA, failed],
        [lostB, failed],
        [liveB, sending],
        [retryB, sending],
      ])
    },
  )
})
