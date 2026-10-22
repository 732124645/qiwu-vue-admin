// Agent notification settings (see docs/agent.md): the caller's own mail switches per notice kind (the inbox
// always gets them), stored as a personal preference: defaults all off, saved values read back, invalid
// bodies 400, no session 401, no agent.chat.use 403, another tenant's user never sees them; a turn notice
// goes to the inbox and, with the kind's mail switch on, to the mail channel too (a user without an
// address gets a skipped mail record, no error); a turn that stops to wait twice mails once, and not at
// all when Redis cannot record it; a notice carries generic text and the conversation's route, never its
// title. Multi-tenancy on.
import { ConfigService } from '@nestjs/config'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { agentPerms } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { AgentModule } from '../../src/core/agent/agent.module.js'
import type { AgentThread } from '../../src/core/agent/entities/agent-thread.entity.js'
import { AGENT_NOTICE, TurnRunner } from '../../src/core/agent/runtime/turn-runner.js'
import { EnvSchema } from '../../src/core/config/env.schema.js'
import { NotifyChannels, NotifyDispatcher } from '../../src/core/notify/notify.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { logOf } from '../setup/audit.js'
import { bearer, signIn } from '../setup/auth.js'
import { addUser, createTenant, inTenant1, type PeopledTenant } from '../setup/tenants.js'

const PREFIX = 'e2e-agnotify-'
const URL = '/api/agent/notify-settings'
const OFF = { turnDone: { mail: false }, waiting: { mail: false }, automation: { mail: false } }

let app: NestExpressApplication
let ds: DataSource
let member = ''
let reader = ''
let otherMember = ''
let memberId = 0
let readerId = 0
let oddId = 0
let odd = ''
const roleIds: number[] = []
let other: PeopledTenant

const http = () => request(app.getHttpServer())

/** A role of tenant `tenantId` holding `perms`, and a user holding it. */
async function userWith(name: string, perms: string[], tenantId = 1): Promise<number> {
  const { insertId } = await ds.query<{ insertId: number }>(
    "INSERT INTO iam_role (code, name, data_scope, tenant_id) VALUES (?, ?, 'all', ?)",
    [`${PREFIX}${name}`, `${PREFIX}${name}`, tenantId],
  )
  if (tenantId === 1) roleIds.push(Number(insertId))
  await ds.query(
    `INSERT INTO iam_role_menus (role_id, menu_id, tenant_id)
     SELECT ?, id, ? FROM iam_menu WHERE perms IN (?) AND deleted_at IS NULL`,
    [Number(insertId), tenantId, perms],
  )
  return addUser(app, tenantId, `${PREFIX}${name}`, { roleId: Number(insertId) })
}

/** The inbox and mail records a notice left for `userId` under `template`. */
async function records(userId: number, template: string) {
  const inbox = await ds.query<{ n: number }[]>(
    'SELECT COUNT(*) AS n FROM msg_inbox WHERE tenant_id = 1 AND user_id = ? AND template_code = ?',
    [userId, template],
  )
  const mail = await ds.query<{ status: string }[]>(
    'SELECT status FROM msg_mail_record WHERE tenant_id = 1 AND user_id = ? AND template_code = ? ORDER BY id',
    [userId, template],
  )
  return { inbox: Number(inbox[0]?.n), mail: mail.map((r) => r.status) }
}

/** Sends the turn notice `template` for a thread of `userId` (of turn `turnId`), as the runner does. */
function notice(userId: number, template: string, turnId?: number): Promise<void> {
  const thread = { id: 1, userId, title: `${PREFIX}thread` } as unknown as AgentThread
  const runner = app.get(TurnRunner) as unknown as {
    notice(t: AgentThread, template: string, turnId?: number): Promise<void>
  }
  return inTenant1(() => runner.notice(thread, template, turnId))
}

/** Turn ids no real turn has; their once-only marks are removed afterwards. */
const fakeTurns = [990, 991, 992].map((n) => n * 1_000_000 + (Date.now() % 1_000_000))

beforeAll(async () => {
  const env = { ...process.env, APP_MULTI_TENANT: 'true', APP_AGENT: 'true' }
  const mod = await Test.createTestingModule({ imports: [AppModule, AgentModule] })
    .overrideProvider(ConfigService)
    .useValue(new ConfigService(EnvSchema.parse(env)))
    .compile()
  app = setupApp(mod.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.init()
  ds = app.get<DataSource>(getDataSourceToken())
  memberId = await userWith('member', [agentPerms.chat.use])
  readerId = await addUser(app, 1, `${PREFIX}reader`)
  oddId = await userWith('odd', [agentPerms.chat.use])
  odd = (await signIn(app, `${PREFIX}odd`)).accessToken
  member = (await signIn(app, `${PREFIX}member`)).accessToken
  reader = (await signIn(app, `${PREFIX}reader`)).accessToken
  other = await createTenant(app, { users: true })
  await userWith('b-member', [agentPerms.chat.use], other.id)
  otherMember = (await signIn(app, `${PREFIX}b-member`, {}, other.id)).accessToken
})

afterAll(async () => {
  if (app) {
    // deliveries still running after the commit finish before their records go
    await app.get(NotifyDispatcher).idle()
    await app.get<Redis>(REDIS).unlink(fakeTurns.map((id) => redisKey('agentWaitMail', id)))
  }
  if (ds) {
    const users = [memberId, readerId, oddId].filter(Boolean)
    if (users.length) {
      await ds.query('DELETE FROM msg_inbox WHERE tenant_id = 1 AND user_id IN (?)', [users])
      await ds.query('DELETE FROM msg_mail_record WHERE tenant_id = 1 AND user_id IN (?)', [users])
      await ds.query('DELETE FROM iam_user_pref WHERE tenant_id = 1 AND user_id IN (?)', [users])
      await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [users])
      await ds.query('DELETE FROM iam_user WHERE id IN (?)', [users])
    }
    if (roleIds.length) {
      await ds.query('DELETE FROM iam_role_menus WHERE role_id IN (?)', [roleIds])
      await ds.query('DELETE FROM iam_role WHERE id IN (?)', [roleIds])
    }
  }
  await other?.dispose()
  await app?.close()
})

describe('notify settings', () => {
  it('defaults to inbox only, saves the mail switches and reads them back', async () => {
    const first = await http().get(URL).set(bearer(member))
    expect(first.status).toBe(200)
    expect(first.body.data).toEqual(OFF)

    const on = { ...OFF, turnDone: { mail: true } }
    const saved = await http().put(URL).set(bearer(member)).send(on)
    expect(saved.status).toBe(200)
    expect(saved.body.data).toEqual(on)
    expect((await http().get(URL).set(bearer(member))).body.data).toEqual(on)
    const log = await logOf(ds, String(saved.headers['x-request-id']))
    expect(log).toMatchObject({ domain: 'agent.notify', verb: 'modify', ok: 1 })
  })

  it('rejects an invalid body, no session and a user without agent.chat.use', async () => {
    expect((await http().put(URL).set(bearer(member)).send({ turnDone: true })).status).toBe(400)
    expect(
      (
        await http()
          .put(URL)
          .set(bearer(member))
          .send({ ...OFF, waiting: { mail: 'yes' } })
      ).status,
    ).toBe(400)
    expect((await http().get(URL)).status).toBe(401)
    expect((await http().put(URL).send(OFF)).status).toBe(401)
    expect((await http().get(URL).set(bearer(reader))).status).toBe(403)
    expect((await http().put(URL).set(bearer(reader)).send(OFF)).status).toBe(403)
  })

  it("keeps each tenant's users apart", async () => {
    await http()
      .put(URL)
      .set(bearer(member))
      .send({ ...OFF, waiting: { mail: true } })
    expect((await http().get(URL).set(bearer(otherMember))).body.data).toEqual(OFF)
    const mine = { ...OFF, automation: { mail: true } }
    expect((await http().put(URL).set(bearer(otherMember)).send(mine)).status).toBe(200)
    expect((await http().get(URL).set(bearer(otherMember))).body.data).toEqual(mine)
    expect((await http().get(URL).set(bearer(member))).body.data).toEqual({
      ...OFF,
      waiting: { mail: true },
    })
  })

  it('falls back to the defaults for a stored value of an unknown shape', async () => {
    await ds.query(
      "INSERT INTO iam_user_pref (user_id, pref_key, value, tenant_id) VALUES (?, 'agent.notify', ?, 1)",
      [oddId, JSON.stringify({ waiting: true, turnDone: { mail: 'yes' } })],
    )
    expect((await http().get(URL).set(bearer(odd))).body.data).toEqual(OFF)
    await notice(oddId, AGENT_NOTICE.waiting)
    expect(await records(oddId, AGENT_NOTICE.waiting)).toEqual({ inbox: 1, mail: [] })
  })
})

describe('turn notices', () => {
  it('always go to the inbox and to mail only for the kinds switched on', async () => {
    await ds.query('UPDATE iam_user SET email = NULL WHERE id = ?', [memberId])
    // waiting on, turn done off
    await http()
      .put(URL)
      .set(bearer(member))
      .send({ ...OFF, waiting: { mail: true } })

    await notice(memberId, AGENT_NOTICE.completed)
    expect(await records(memberId, AGENT_NOTICE.completed)).toEqual({ inbox: 1, mail: [] })

    // no address: the mail record is skipped, the inbox message still goes
    await notice(memberId, AGENT_NOTICE.waiting)
    expect(await records(memberId, AGENT_NOTICE.waiting)).toEqual({
      inbox: 1,
      mail: ['skipped'],
    })

    await ds.query('UPDATE iam_user SET email = ? WHERE id = ?', [
      `${PREFIX}member@example.com`,
      memberId,
    ])
    await notice(memberId, AGENT_NOTICE.waiting)
    const after = await records(memberId, AGENT_NOTICE.waiting)
    expect(after.inbox).toBe(2)
    expect(after.mail).toHaveLength(2)
    expect(after.mail[1]).not.toBe('skipped')

    // a user who never saved settings: inbox only
    await notice(readerId, AGENT_NOTICE.waiting)
    expect(await records(readerId, AGENT_NOTICE.waiting)).toEqual({ inbox: 1, mail: [] })

    // the conversation's title never leaves in a notice: generic text and the conversation's route only
    const sentTexts = [
      ...(await ds.query<{ text: string }[]>(
        "SELECT CONCAT_WS('|', title, body, params) AS text FROM msg_inbox WHERE tenant_id = 1 AND user_id = ?",
        [memberId],
      )),
      ...(await ds.query<{ text: string }[]>(
        "SELECT CONCAT_WS('|', subject, body, params) AS text FROM msg_mail_record WHERE tenant_id = 1 AND user_id = ?",
        [memberId],
      )),
    ].map((r) => r.text)
    expect(sentTexts).toHaveLength(5)
    for (const text of sentTexts) {
      expect(text).not.toContain(`${PREFIX}thread`)
      expect(text).toContain('/agent/chat?thread=1')
    }
  })

  it('fills {title} of a template installed earlier with the conversation number, never its title', async () => {
    const tpl = 'SELECT id, title, body FROM msg_inbox_template WHERE code = ?'
    const saved = await ds.query<{ id: number; title: string; body: string }[]>(tpl, [
      AGENT_NOTICE.completed,
    ])
    expect(saved.length).toBeGreaterThan(0)
    await ds.query(
      "UPDATE msg_inbox_template SET title = 'Done: {title}', body = 'The chat {title} is done.' WHERE code = ?",
      [AGENT_NOTICE.completed],
    )
    try {
      await notice(readerId, AGENT_NOTICE.completed)
      const [last] = await ds.query<{ title: string; body: string }[]>(
        'SELECT title, body FROM msg_inbox WHERE tenant_id = 1 AND user_id = ? AND template_code = ? ORDER BY id DESC LIMIT 1',
        [readerId, AGENT_NOTICE.completed],
      )
      expect(last).toEqual({ title: 'Done: #1', body: 'The chat #1 is done.' })
    } finally {
      for (const row of saved)
        await ds.query('UPDATE msg_inbox_template SET title = ?, body = ? WHERE id = ?', [
          row.title,
          row.body,
          row.id,
        ])
    }
  })

  it('mail one "waiting" notice per turn, and none when Redis fails', async () => {
    // member: waiting mail on, an address set (previous case)
    const before = await records(memberId, AGENT_NOTICE.waiting)
    await notice(memberId, AGENT_NOTICE.waiting, fakeTurns[0])
    await notice(memberId, AGENT_NOTICE.waiting, fakeTurns[0])
    const twice = await records(memberId, AGENT_NOTICE.waiting)
    expect(twice.inbox - before.inbox).toBe(2)
    expect(twice.mail.length - before.mail.length).toBe(1)

    // the once-only mark cannot be set: inbox only, never a possible duplicate mail
    const redis = app.get<Redis>(REDIS)
    const set = vi.spyOn(redis, 'set').mockRejectedValueOnce(new Error('redis down'))
    try {
      await notice(memberId, AGENT_NOTICE.waiting, fakeTurns[1])
    } finally {
      set.mockRestore()
    }
    const failed = await records(memberId, AGENT_NOTICE.waiting)
    expect(failed.inbox - twice.inbox).toBe(1)
    expect(failed.mail).toHaveLength(twice.mail.length)
  })

  it('never hold the turn up while a mail is delivered', async () => {
    const mail = app.get(NotifyChannels).get('mail')!
    let delivered = 0
    const slow = vi.spyOn(mail, 'deliver').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 3000))
      delivered++
    })
    try {
      const before = await records(memberId, AGENT_NOTICE.waiting)
      const started = Date.now()
      await notice(memberId, AGENT_NOTICE.waiting, fakeTurns[2])
      expect(Date.now() - started).toBeLessThan(1500)
      const now = await records(memberId, AGENT_NOTICE.waiting)
      expect(now.inbox - before.inbox).toBe(1)
      expect(now.mail.length - before.mail.length).toBe(1)
      expect(delivered).toBe(0)
      // the delivery runs after the commit and is waited for on shutdown
      await app.get(NotifyDispatcher).idle()
      expect(delivered).toBe(1)
    } finally {
      slow.mockRestore()
    }
  }, 15_000)
})
