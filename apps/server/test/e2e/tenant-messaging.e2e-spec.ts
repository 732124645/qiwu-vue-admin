// Messaging with tenants (see docs/design-notes.md#tenancy), the switch on, between the default tenant
// (A) and tenant B. Bulletins, the readers' feed with its receipts, the inboxes (the admin's and the
// caller's own) and the mail and SMS records stay in their tenant: lists leave the other tenant's rows
// out, its ids are 404 like unknown ones and nothing of it changes; the same title lives in both. A stray
// receipt or message of another tenant naming the caller's ids never counts as the caller's. Templates,
// mail accounts and SMS channels are platform pages (403 to another tenant; their pickers list the same
// platform rows to everyone). An SMS receipt is vouched for by its channel's token: it updates that
// channel's records in whichever tenant they are, never another channel's.
import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import { DEFAULT_TENANT_ID as DEFAULT_TENANT, Err } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { SecretBox } from '../../src/core/crypto/secret-box.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import {
  addRow,
  addUser,
  bootApp,
  createTenant,
  type PeopledTenant,
  signInDirect,
} from '../setup/tenants.js'

const PREFIX = 'tm-e2e-'
/** the title both tenants give a bulletin */
const TITLE = `${PREFIX}maintenance`

let on: NestExpressApplication
let ds: DataSource
let redis: Redis
let B: PeopledTenant
/** a plain user of the default tenant */
let aReader = 0
const tokens = { root: '', aReader: '', bOwner: '', bAlice: '' }
/** the default tenant's rows of this spec, by table (B's go with B.dispose()) */
const mine: Record<string, number[]> = {
  msg_bulletin: [],
  msg_inbox: [],
  msg_mail_record: [],
  msg_sms_record: [],
  msg_sms_channel: [],
}

type Who = keyof typeof tokens
const api = (who: Who, method: 'get' | 'post' | 'put' | 'delete', path: string, body?: object) => {
  const req = request(on.getHttpServer())[method](`/api/messaging${path}`).set(bearer(tokens[who]))
  return body ? req.send(body) : req
}
const expect404 = (res: request.Response) => {
  expect(res.status).toBe(404)
  expect(res.body.code).toBe(Err.NOT_FOUND.code)
}
const ids = (items: { id: number }[]): number[] => items.map((r) => Number(r.id))
const idsOf = (res: request.Response): number[] => ids(res.body.data.items)

/** A row of the default tenant (tracked for cleanup). */
async function inA(table: keyof typeof mine, row: Record<string, unknown>) {
  const id = await addRow(on, DEFAULT_TENANT, table, row)
  mine[table]!.push(id)
  return id
}
const bulletin = (published: boolean, title = TITLE) => ({
  title,
  kind: 'notice',
  body: '<p>x</p>',
  published: published ? 1 : 0,
  published_at: published ? new Date() : null,
})
const message = (userId: number, title = `${PREFIX}hello`) => ({
  user_id: userId,
  template_code: `${PREFIX}inbox`,
  locale: 'en-US',
  category: 'system',
  title,
  body: 'x',
  status: 'delivered',
})
const mail = () => ({
  to_list: JSON.stringify(['someone@example.com']),
  template_code: `${PREFIX}mail`,
  locale: 'en-US',
  subject: 'x',
  body: 'x',
  status: 'sent',
})
const sms = (channelId: number | null, providerMsgId: string | null = null) => ({
  channel_id: channelId,
  template_code: `${PREFIX}sms`,
  mobile: '13900009999',
  body: 'x',
  status: 'sent',
  provider_msg_id: providerMsgId,
})

/** What is stored (raw SQL: no tenant condition). */
const bulletinRows = (ids: number[]) =>
  ds.query(
    'SELECT id, tenant_id, title, body, published, published_at, deleted_at FROM msg_bulletin WHERE id IN (?) ORDER BY id',
    [ids],
  )
const receiptsOf = (userId: number) =>
  ds.query<{ bulletin_id: number; tenant_id: number }[]>(
    'SELECT bulletin_id, tenant_id FROM msg_bulletin_receipt WHERE user_id = ? AND deleted_at IS NULL ORDER BY bulletin_id',
    [userId],
  )
const readAt = async (inboxId: number) =>
  (
    await ds.query<{ read_at: Date | null }[]>('SELECT read_at FROM msg_inbox WHERE id = ?', [
      inboxId,
    ])
  )[0]!.read_at

beforeAll(async () => {
  on = await bootApp({ multiTenant: true })
  ds = on.get<DataSource>(getDataSourceToken())
  redis = on.get(REDIS)
  await cleanRedis(redis)
  B = await createTenant(on, { users: true })
  aReader = await addUser(on, DEFAULT_TENANT, `${PREFIX}reader`)
  tokens.root = (await signIn(on)).accessToken
  tokens.aReader = (await signInDirect(on, aReader))!.accessToken
  tokens.bOwner = (await signInDirect(on, B.ownerId))!.accessToken
  tokens.bAlice = (await signInDirect(on, B.users.alice))!.accessToken
})

afterAll(async () => {
  if (ds) {
    await B?.dispose()
    if (mine.msg_bulletin!.length)
      await ds.query('DELETE FROM msg_bulletin_receipt WHERE bulletin_id IN (?)', [
        mine.msg_bulletin,
      ])
    if (aReader) {
      await ds.query('DELETE FROM msg_bulletin_receipt WHERE user_id = ?', [aReader])
      await ds.query('DELETE FROM iam_user WHERE id = ?', [aReader])
    }
    for (const [table, ids] of Object.entries(mine))
      if (ids.length) await ds.query(`DELETE FROM ${table} WHERE id IN (?)`, [ids])
  }
  if (redis) await cleanRedis(redis)
  await on?.close()
})

describe('bulletins', () => {
  let aPub = 0
  let aDraft = 0
  let bPub = 0
  let bDraft = 0

  beforeAll(async () => {
    aPub = await inA('msg_bulletin', bulletin(true))
    aDraft = await inA('msg_bulletin', bulletin(false))
  })

  it('B writes under the default tenant’s title into B only (a tenantId in the body changes nothing); each list holds its own tenant’s', async () => {
    const add = async (title: string) =>
      (
        await api('bOwner', 'post', '/bulletins', {
          title,
          kind: 'notice',
          body: '<p>b</p>',
          tenantId: DEFAULT_TENANT,
        }).expect(201)
      ).body.data.id as number
    bPub = await add(TITLE)
    bDraft = await add(`${PREFIX}draft`)
    await api('bOwner', 'put', `/bulletins/${bPub}/published`, { published: true }).expect(200)
    expect(
      (await bulletinRows([bPub, bDraft])).map((r: { tenant_id: number }) => Number(r.tenant_id)),
    ).toEqual([B.id, B.id])

    const list = async (who: Who) =>
      idsOf(await api(who, 'get', '/bulletins').query({ title: PREFIX, sort: 'id' }).expect(200))
    expect(await list('bOwner')).toEqual([bPub, bDraft])
    expect(await list('root')).toEqual([aPub, aDraft])
  })

  it('another tenant’s bulletin is 404 to get, edit, publish, delete, batch delete and its receipts; nothing changes', async () => {
    const before = await bulletinRows([aPub, aDraft, bPub, bDraft])
    const edit = { title: 'taken over', kind: 'notice', body: '<p>t</p>' }
    const cases: [Who, number, number][] = [
      ['bOwner', aPub, bDraft],
      ['root', bPub, aDraft],
    ]
    for (const [who, other, own] of cases) {
      expect404(await api(who, 'get', `/bulletins/${other}`))
      expect404(await api(who, 'put', `/bulletins/${other}`, edit))
      expect404(await api(who, 'put', `/bulletins/${other}/published`, { published: false }))
      expect404(await api(who, 'get', `/bulletins/${other}/receipts`))
      expect404(await api(who, 'delete', `/bulletins/${other}`))
      // all or none: the caller's own id beside it is not deleted either
      expect404(await api(who, 'post', '/bulletins/batch-delete', { ids: [own, other] }))
    }
    expect404(await api('bOwner', 'put', `/bulletins/${aDraft}/published`, { published: true }))
    expect(await bulletinRows([aPub, aDraft, bPub, bDraft])).toEqual(before)
  })

  it('the readers’ feed: the caller’s tenant’s published ones only; another tenant’s is 404 to open and to read; read-all reads in the caller’s tenant only', async () => {
    const feed = async (who: Who) =>
      (await api(who, 'get', '/bulletins/feed').expect(200)).body.data
    const b = await feed('bAlice')
    expect(ids(b.items)).toContain(bPub)
    expect(ids(b.items)).not.toContain(aPub)
    // every published bulletin of B is in the feed: the unread count is B's alone
    const [{ n }] = await ds.query<{ n: number }[]>(
      'SELECT COUNT(*) AS n FROM msg_bulletin WHERE tenant_id = ? AND published = 1 AND deleted_at IS NULL',
      [B.id],
    )
    expect(b.unread).toBe(Number(n))
    const a = await feed('aReader')
    expect(ids(a.items)).toContain(aPub)
    expect(ids(a.items)).not.toContain(bPub)

    expect404(await api('bAlice', 'get', `/bulletins/feed/${aPub}`))
    expect404(await api('bAlice', 'post', `/bulletins/feed/${aPub}/read`))
    expect404(await api('aReader', 'get', `/bulletins/feed/${bPub}`))
    expect404(await api('aReader', 'post', `/bulletins/feed/${bPub}/read`))
    expect(await receiptsOf(B.users.alice)).toEqual([])
    expect(await receiptsOf(aReader)).toEqual([])

    expect((await api('bAlice', 'post', '/bulletins/feed/read-all').expect(200)).body.data).toEqual(
      { unread: 0 },
    )
    const read = await receiptsOf(B.users.alice)
    expect(read.map((r) => Number(r.bulletin_id))).toContain(bPub)
    expect(read.map((r) => Number(r.bulletin_id))).not.toContain(aPub)
    expect(new Set(read.map((r) => Number(r.tenant_id)))).toEqual(new Set([B.id]))
    expect((await feed('aReader')).unread).toBe(a.unread)
    expect(await receiptsOf(aReader)).toEqual([])
  })

  it('a receipt of another tenant naming the caller and a bulletin of theirs is not the caller’s: unread, not listed as read', async () => {
    // after the read-all above: from here on nobody reads this one (its receipt key is taken)
    const stray = await addRow(on, B.id, 'msg_bulletin', bulletin(true, `${PREFIX}stray`))
    await addRow(on, DEFAULT_TENANT, 'msg_bulletin_receipt', {
      bulletin_id: stray,
      user_id: B.users.alice,
    })
    try {
      const res = (await api('bAlice', 'get', '/bulletins/feed').expect(200)).body.data
      expect(res.items.find((i: { id: number }) => i.id === stray)).toMatchObject({ read: false })
      expect(res.unread).toBe(1)
      expect(
        (await api('bAlice', 'get', `/bulletins/feed/${stray}`).expect(200)).body.data.read,
      ).toBe(false)
    } finally {
      await ds.query('DELETE FROM msg_bulletin_receipt WHERE bulletin_id = ? AND tenant_id = ?', [
        stray,
        DEFAULT_TENANT,
      ])
    }
  })

  it('the receipts list joins the receipts of the bulletin’s tenant only', async () => {
    // a receipt of B naming the default tenant's bulletin and user
    await addRow(on, B.id, 'msg_bulletin_receipt', { bulletin_id: aPub, user_id: aReader })
    const res = await api('root', 'get', `/bulletins/${aPub}/receipts`).expect(200)
    expect(res.body.data).toEqual({ items: [], total: 0 })
  })
})

describe('inboxes', () => {
  let aMsg = 0
  let bMsg = 0
  /** B's message naming the default tenant's user */
  let bToA = 0
  /** a message of the default tenant naming B's alice */
  let stray = 0

  beforeAll(async () => {
    aMsg = await inA('msg_inbox', message(aReader))
    bMsg = await addRow(on, B.id, 'msg_inbox', message(B.users.alice))
    bToA = await addRow(on, B.id, 'msg_inbox', message(aReader, `${PREFIX}to-a`))
    stray = await inA('msg_inbox', message(B.users.alice, `${PREFIX}stray`))
  })

  it('the admin list and get: the caller’s tenant only, also filtered by another tenant’s user; a recipient of another tenant is not named', async () => {
    const list = async (who: Who, query: object = {}) =>
      idsOf(
        await api(who, 'get', '/inboxes')
          .query({ ...query, pageSize: 200, sort: '-id' })
          .expect(200),
      )
    const b = await list('bOwner')
    expect(b).toEqual(expect.arrayContaining([bMsg, bToA]))
    expect(b).not.toContain(aMsg)
    expect(b).not.toContain(stray)
    expect(await list('bOwner', { userId: B.users.alice })).toEqual([bMsg])
    expect(await list('root', { userId: B.users.alice })).toEqual([stray])
    expect(await list('root', { userId: aReader })).toEqual([aMsg])
    expect404(await api('bOwner', 'get', `/inboxes/${aMsg}`))
    expect404(await api('root', 'get', `/inboxes/${bMsg}`))
    const got = await api('bOwner', 'get', `/inboxes/${bToA}`).expect(200)
    expect(got.body.data.recipientName).toBeNull()
  })

  it('my inbox: another tenant’s messages are not listed, counted, opened or read, whomever they name', async () => {
    const mineList = idsOf(await api('bAlice', 'get', '/inboxes/mine').expect(200))
    expect(mineList).toEqual([bMsg])
    expect((await api('bAlice', 'get', '/inboxes/mine/unread').expect(200)).body.data).toEqual({
      unread: 1,
    })
    for (const other of [aMsg, stray]) {
      expect404(await api('bAlice', 'get', `/inboxes/mine/${other}`))
      expect404(await api('bAlice', 'post', `/inboxes/mine/${other}/read`))
    }
    expect404(await api('aReader', 'get', `/inboxes/mine/${bToA}`))
    expect404(await api('aReader', 'post', `/inboxes/mine/${bToA}/read`))
    expect((await api('bAlice', 'post', '/inboxes/mine/read-all').expect(200)).body.data).toEqual({
      unread: 0,
    })
    expect(await readAt(bMsg)).not.toBeNull()
    for (const other of [aMsg, stray, bToA]) expect(await readAt(other)).toBeNull()
    expect((await api('aReader', 'get', '/inboxes/mine/unread').expect(200)).body.data).toEqual({
      unread: 1,
    })
  })
})

describe('mail and SMS records', () => {
  it.each([
    ['mail-records', 'msg_mail_record', mail],
    ['sms-records', 'msg_sms_record', () => sms(null)],
  ] as const)('%s: each tenant lists and gets its own only', async (path, table, row) => {
    const a = await inA(table, row())
    const b = await addRow(on, B.id, table, row())
    const list = async (who: Who) =>
      idsOf(await api(who, 'get', `/${path}`).query({ pageSize: 200, sort: '-id' }).expect(200))
    expect(await list('bOwner')).toContain(b)
    expect(await list('bOwner')).not.toContain(a)
    expect(await list('root')).toContain(a)
    expect(await list('root')).not.toContain(b)
    expect404(await api('bOwner', 'get', `/${path}/${a}`))
    expect404(await api('root', 'get', `/${path}/${b}`))
  })
})

describe('the platform pages', () => {
  it('templates, mail accounts and SMS channels refuse another tenant (403) on every route; their pickers list the platform rows to all', async () => {
    const routes: ['get' | 'post' | 'put' | 'delete', string][] = [
      ['get', ''],
      ['get', '/1'],
      ['post', ''],
      ['put', '/1'],
      ['put', '/1/enabled'],
      ['post', '/1/test'],
      ['delete', '/1'],
      ['post', '/batch-delete'],
    ]
    for (const page of [
      'inbox-templates',
      'mail-templates',
      'sms-templates',
      'mail-accounts',
      'sms-channels',
    ])
      for (const [method, path] of routes)
        expect([
          page,
          method,
          path,
          (await api('bOwner', method, `/${page}${path}`, method === 'get' ? undefined : {}))
            .status,
        ]).toEqual([page, method, path, 403])
    for (const page of ['mail-accounts', 'sms-channels']) {
      const b = await api('bOwner', 'get', `/${page}/options`).expect(200)
      const a = await api('root', 'get', `/${page}/options`).expect(200)
      expect(b.body.data).toEqual(a.body.data)
    }
  })
})

describe('SMS receipts', () => {
  const secrets = { one: `${PREFIX}receipt-one`, two: `${PREFIX}receipt-two` }
  const channels = { one: 0, two: 0 }
  const receipt = (channel: number, token: string, items: object[]) =>
    request(on.getHttpServer())
      .post(`/api/messaging/sms/receipt/${channel}`)
      .query({ token })
      .send(items)
  const status = async (ids: number[]) =>
    (
      await ds.query<{ id: number; receipt_status: string | null }[]>(
        'SELECT id, receipt_status FROM msg_sms_record WHERE id IN (?) ORDER BY id',
        [ids],
      )
    ).map((r) => [Number(r.id), r.receipt_status])

  beforeAll(async () => {
    for (const key of ['one', 'two'] as const) {
      const { insertId } = await ds.query<{ insertId: number }>(
        `INSERT INTO msg_sms_channel (driver, name, enabled, receipt_secret_enc) VALUES ('debug', ?, 1, ?)`,
        [`${PREFIX}${key}`, on.get(SecretBox).encrypt(secrets[key])],
      )
      channels[key] = Number(insertId)
      mine.msg_sms_channel!.push(channels[key])
    }
  })

  it('a receipt updates the record of tenant B', async () => {
    const b = await addRow(on, B.id, 'msg_sms_record', sms(channels.one, `${PREFIX}b1`))
    await receipt(channels.one, secrets.one, [
      { providerMsgId: `${PREFIX}b1`, status: 'delivered' },
    ]).expect(200)
    expect(await status([b])).toEqual([[b, 'delivered']])
  })

  it('one batch updates the records of both tenants in it', async () => {
    const a = await inA('msg_sms_record', sms(channels.one, `${PREFIX}a2`))
    const b = await addRow(on, B.id, 'msg_sms_record', sms(channels.one, `${PREFIX}b2`))
    await receipt(channels.one, secrets.one, [
      { providerMsgId: `${PREFIX}a2`, status: 'failed' },
      { providerMsgId: `${PREFIX}b2`, status: 'delivered' },
    ]).expect(200)
    expect(await status([a, b])).toEqual([
      [a, 'failed'],
      [b, 'delivered'],
    ])
  })

  it('another channel’s receipt (its token right) under the same provider message id leaves these records alone', async () => {
    const shared = `${PREFIX}shared`
    const a = await inA('msg_sms_record', sms(channels.one, shared))
    const b = await addRow(on, B.id, 'msg_sms_record', sms(channels.one, shared))
    const its = await addRow(on, B.id, 'msg_sms_record', sms(channels.two, shared))
    // the first channel's token does not open the second one
    expect404(
      await receipt(channels.two, secrets.one, [{ providerMsgId: shared, status: 'failed' }]),
    )
    await receipt(channels.two, secrets.two, [
      { providerMsgId: shared, status: 'delivered' },
    ]).expect(200)
    expect(await status([a, b, its])).toEqual([
      [a, null],
      [b, null],
      [its, 'delivered'],
    ])
  })
})
