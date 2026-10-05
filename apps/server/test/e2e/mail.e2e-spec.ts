import { createServer, type Server } from 'node:net'
import type { AddressInfo } from 'node:net'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, mailAccountPerms } from '@qiwu/shared'
import nodemailer, { type Transporter } from 'nodemailer'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { vi } from 'vitest'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { AppConfigService } from '../../src/core/config/config.module.js'
import { SecretBox } from '../../src/core/crypto/secret-box.js'
import { NotifyChannels } from '../../src/core/notify/notify.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { findId, insertRow } from '../../src/db/seeds/upsert.js'
import { MailTransports } from '../../src/modules/platform/messaging/mail-account/mail-transports.js'
import { MailChannel } from '../../src/modules/platform/messaging/mail-template/mail-channel.js'
import { MailTemplate } from '../../src/modules/platform/messaging/mail-template/mail-template.entity.js'
import { TransactionHost } from '@nestjs-cls/transactional'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const URL = '/api/messaging/mail-accounts'
const PREFIX = 'mail-e2e-'
let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let box: SecretBox
let transports: MailTransports
let smtp: Server
let port: number
let connections = 0
const seen: string[] = []
let lastId: number
let lastTemplateId: number
let lastRecordId: number
let roleId: number
let userId: number
let admin: string
let reader: string
let seq = 0

const body = (over: object = {}) => ({
  name: `${PREFIX}${++seq}`,
  address: 'sender@example.com',
  username: 'mailer',
  password: 'right-secret',
  host: '127.0.0.1',
  port,
  security: 'none',
  ...over,
})
const call = (method: 'get' | 'post' | 'put', path = '', payload?: object, token = admin) => {
  const req = request(app.getHttpServer())[method](`${URL}${path}`).set(bearer(token))
  return payload ? req.send(payload) : req
}
const add = async (payload: object) => (await call('post', '', payload).expect(201)).body.data
const test = (id: number, token = admin) => call('post', `/${id}/test`, undefined, token)

async function strict<T>(fn: () => Promise<T>, extra: Record<string, unknown> = {}): Promise<T> {
  const cfg = app.get(AppConfigService)
  const get = cfg.get.bind(cfg)
  const values: Record<string, unknown> = { ALLOW_PRIVATE_ENDPOINTS: false, ...extra }
  const spy = vi
    .spyOn(cfg, 'get')
    .mockImplementation(((key: string) =>
      key in values ? values[key] : get(key as never)) as typeof cfg.get)
  try {
    return await fn()
  } finally {
    spy.mockRestore()
  }
}

beforeAll(async () => {
  smtp = createServer((socket) => {
    connections++
    socket.setEncoding('utf8')
    socket.write('220 fake.example ESMTP\r\n')
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      for (let end; (end = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, end).trim()
        buffer = buffer.slice(end + 1)
        if (/^EHLO /i.test(line)) socket.write('250-fake.example\r\n250 AUTH PLAIN LOGIN\r\n')
        else if (/^AUTH PLAIN /i.test(line)) {
          const decoded = Buffer.from(line.slice(11), 'base64').toString('utf8')
          seen.push(decoded)
          socket.write(
            decoded === '\0mailer\0right-secret'
              ? '235 2.7.0 OK\r\n'
              : '535 5.7.8 Bad credentials\r\n',
          )
        } else if (/^QUIT/i.test(line)) socket.end('221 Bye\r\n')
        else socket.write('500 Unknown\r\n')
      }
    })
  })
  await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve))
  port = (smtp.address() as AddressInfo).port
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  box = app.get(SecretBox)
  transports = app.get(MailTransports)
  await cleanRedis(redis)
  lastId = Number((await ds.query('SELECT COALESCE(MAX(id), 0) AS n FROM msg_mail_account'))[0].n)
  lastTemplateId = Number(
    (await ds.query('SELECT COALESCE(MAX(id), 0) AS n FROM msg_mail_template'))[0].n,
  )
  lastRecordId = Number(
    (await ds.query('SELECT COALESCE(MAX(id), 0) AS n FROM msg_mail_record'))[0].n,
  )
  roleId = await insertRow(ds.manager, 'iam_role', {
    code: `${PREFIX}reader`,
    name: `${PREFIX}reader`,
    data_scope: 'all',
  })
  const browse = await findId(ds.manager, 'iam_menu', { perms: mailAccountPerms.browse })
  await ds.query('INSERT INTO iam_role_menus (role_id, menu_id) VALUES (?, ?)', [roleId, browse])
  userId = await insertRow(ds.manager, 'iam_user', {
    username: `${PREFIX}reader`,
    display_name: 'Reader',
    password_hash: 'not-used',
    password_changed_at: new Date(),
  })
  await ds.query('INSERT INTO iam_user_roles (user_id, role_id) VALUES (?, ?)', [userId, roleId])
  admin = (await signIn(app)).accessToken
  reader = (await signIn(app, `${PREFIX}reader`)).accessToken
})

afterAll(async () => {
  if (ds) {
    await ds.query('DELETE FROM msg_mail_record WHERE id > ?', [lastRecordId])
    await ds.query('DELETE FROM msg_mail_template WHERE id > ?', [lastTemplateId])
    await ds.query('DELETE FROM msg_mail_account WHERE id > ?', [lastId])
    await ds.query('DELETE FROM iam_user_roles WHERE user_id = ?', [userId])
    await ds.query('DELETE FROM iam_user WHERE id = ?', [userId])
    await ds.query('DELETE FROM iam_role_menus WHERE role_id = ?', [roleId])
    await ds.query('DELETE FROM iam_role WHERE id = ?', [roleId])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
  await new Promise<void>((resolve) => smtp.close(() => resolve()))
})

describe('mail account', () => {
  it('requires a new password when changing a password-protected SMTP connection', async () => {
    const row = await add(body())
    const raw = async () =>
      (
        await ds.query(
          'SELECT host, port, username, security, password_enc FROM msg_mail_account WHERE id = ?',
          [row.id],
        )
      )[0]
    const original = await raw()
    expect(box.decrypt(original.password_enc)).toBe('right-secret')
    for (const change of [
      { host: 'smtp.attacker.example.com' },
      { port: port === 587 ? 465 : 587 },
      { username: 'other-user' },
      { security: 'ssl' },
    ]) {
      const res = await call('put', `/${row.id}`, change).expect(422)
      expect(res.body.code).toBe(Err.MAIL_PASSWORD_REQUIRED.code)
      expect(await raw()).toEqual(original)
    }

    await call('put', `/${row.id}`, {
      host: 'smtp.attacker.example.com',
      password: 'new-secret',
    }).expect(200)
    expect((await raw()).host).toBe('smtp.attacker.example.com')
    expect(box.decrypt((await raw()).password_enc)).toBe('new-secret')
    const updated = await raw()
    await call('put', `/${row.id}`, {
      host: updated.host,
      port: updated.port,
      username: updated.username,
      security: updated.security,
      password: '',
    }).expect(200)
    expect((await raw()).password_enc).toBe(updated.password_enc)

    const noPassword = await add(body({ password: '' }))
    await call('put', `/${noPassword.id}`, { host: 'smtp.other.example.com' }).expect(200)
    expect((await call('get', `/${noPassword.id}`).expect(200)).body.data.host).toBe(
      'smtp.other.example.com',
    )
    expect(
      (await ds.query('SELECT password_enc FROM msg_mail_account WHERE id = ?', [noPassword.id]))[0]
        .password_enc,
    ).toBeNull()
  })

  it('account password is boxed, write-only, kept on blank edit, replaced on new password', async () => {
    const created = await add(body())
    expect(JSON.stringify(created)).not.toContain('right-secret')
    expect(created).not.toHaveProperty('passwordEnc')
    const raw = async () =>
      (await ds.query('SELECT password_enc FROM msg_mail_account WHERE id = ?', [created.id]))[0]
        .password_enc as string
    const first = await raw()
    expect(first).toMatch(/^v1:/)
    expect(box.decrypt(first)).toBe('right-secret')
    expect(JSON.stringify((await call('get', `/${created.id}`).expect(200)).body)).not.toContain(
      first,
    )
    expect(JSON.stringify((await call('get').expect(200)).body)).not.toContain(first)
    await call('put', `/${created.id}`, { name: created.name, password: '' }).expect(200)
    expect(await raw()).toBe(first)
    await call('put', `/${created.id}`, { password: 'next-secret' }).expect(200)
    expect(box.decrypt(await raw())).toBe('next-secret')
  })

  it('account test uses decrypted SMTP credentials and returns only ok on failure', async () => {
    const correct = await add(body())
    expect((await test(correct.id).expect(200)).body.data).toEqual({ ok: true })
    expect(seen).toContain('\0mailer\0right-secret')
    const wrong = await add(body({ password: 'wrong-secret' }))
    const result = await test(wrong.id).expect(200)
    expect(result.body.data).toEqual({ ok: false })
    expect(JSON.stringify(result.body)).not.toMatch(/535|Bad credentials|wrong-secret/)
  })

  it('account strict mode refuses local/private hosts and unregistered ports on save and update', async () => {
    await strict(async () => {
      for (const host of ['127.0.0.1', '10.0.0.1', 'localhost']) {
        const res = await call('post', '', body({ host, port: 465 })).expect(422)
        expect(res.body.code).toBe(Err.MAIL_HOST_REFUSED.code)
      }
      const res = await call('post', '', body({ host: 'smtp.example.com', port: 2525 })).expect(422)
      expect(res.body.code).toBe(Err.MAIL_HOST_REFUSED.code)
    })
    const row = await add(body())
    await strict(async () => {
      const res = await call('put', `/${row.id}`, { host: '10.0.0.1' }).expect(422)
      expect(res.body.code).toBe(Err.MAIL_HOST_REFUSED.code)
    })
    expect((await call('get', `/${row.id}`).expect(200)).body.data.host).toBe('127.0.0.1')
  })

  it('account strict connect guard refuses a stored local target before dialing', async () => {
    const row = await add(body({ host: 'smtp.example.com' }))
    await ds.query('UPDATE msg_mail_account SET host = ? WHERE id = ?', ['127.0.0.1', row.id])
    const before = connections
    await strict(
      async () => {
        const res = await test(row.id).expect(200)
        expect(res.body.data).toEqual({ ok: false })
      },
      { OUTBOUND_SMTP_PORTS: [port] },
    )
    expect(connections).toBe(before)
  })

  it('account disabled rows do not open a connection', async () => {
    const row = await add(body())
    await call('put', `/${row.id}/enabled`, { enabled: false }).expect(200)
    const before = connections
    expect((await test(row.id).expect(200)).body.data).toEqual({ ok: false })
    expect(connections).toBe(before)
  })

  it('account transport is cached by id and updated_at; old transport closes', async () => {
    const row = await add(body())
    const create = vi.spyOn(
      Object.getPrototypeOf(transports) as { create: (options: object) => Transporter },
      'create',
    )
    try {
      await test(row.id).expect(200)
      await test(row.id).expect(200)
      expect(create).toHaveBeenCalledTimes(1)
      const close = vi.spyOn(create.mock.results[0]!.value, 'close')
      await new Promise((resolve) => setTimeout(resolve, 5))
      await call('put', `/${row.id}`, { name: `${row.name}-edited` }).expect(200)
      await test(row.id).expect(200)
      expect(create).toHaveBeenCalledTimes(2)
      expect(close).toHaveBeenCalledOnce()
    } finally {
      create.mockRestore()
    }
  })

  it('account test requires modify and returns 404 for an unknown id', async () => {
    const row = await add(body())
    expect((await test(row.id, reader)).status).toBe(403)
    expect((await test(999_999)).status).toBe(404)
  })
})

describe('mail send', () => {
  const TEMPLATE_URL = '/api/messaging/mail-templates'
  let transport: Transporter
  let sendMail: ReturnType<typeof vi.spyOn>
  let createTransport: ReturnType<typeof vi.spyOn>
  let channel: MailChannel
  let accountId: number

  const templateBody = (code: string, over: object = {}) => ({
    code,
    locale: 'en-US',
    name: code,
    accountId,
    senderLabel: 'Team',
    subject: 'Hello {name}',
    body: '<p>Hello {name}</p>',
    ...over,
  })
  const addTemplate = async (payload: object) =>
    (
      await request(app.getHttpServer())
        .post(TEMPLATE_URL)
        .set(bearer(admin))
        .send(payload)
        .expect(201)
    ).body.data as MailTemplate
  const sendTest = (id: number, payload: object, token = admin) =>
    request(app.getHttpServer()).post(`${TEMPLATE_URL}/${id}/test`).set(bearer(token)).send(payload)
  const record = async (id: number) =>
    (await ds.query('SELECT * FROM msg_mail_record WHERE id = ?', [id]))[0] as Record<
      string,
      unknown
    >

  beforeEach(async () => {
    transport = nodemailer.createTransport({ jsonTransport: true })
    sendMail = vi.spyOn(transport, 'sendMail')
    createTransport = vi
      .spyOn(
        Object.getPrototypeOf(transports) as { create: (options: object) => Transporter },
        'create',
      )
      .mockReturnValue(transport)
    channel = app.get(NotifyChannels).get('mail') as MailChannel
    accountId = (await add(body({ username: '', password: '' }))).id
  })

  afterEach(() => {
    createTransport.mockRestore()
    sendMail.mockRestore()
  })

  it('send sanitizes create and update, renders the stored locale and escapes body values', async () => {
    const unsafe = '<p>Hello {name}</p><img src="x" onerror="alert(1)"><script>alert(1)</script>'
    const tpl = await addTemplate(templateBody(`${PREFIX}send-safe-${++seq}`, { body: unsafe }))
    expect(tpl.body).not.toMatch(/onerror|<script/i)
    await request(app.getHttpServer())
      .put(`${TEMPLATE_URL}/${tpl.id}`)
      .set(bearer(admin))
      .send({ body: unsafe })
      .expect(200)
    const stored = await ds.query('SELECT body FROM msg_mail_template WHERE id = ?', [tpl.id])
    expect(stored[0].body).not.toMatch(/onerror|<script/i)
    const answered = await request(app.getHttpServer())
      .get(`${TEMPLATE_URL}/${tpl.id}`)
      .set(bearer(admin))
      .expect(200)
    expect(answered.body.data.body).not.toMatch(/onerror|<script/i)

    const res = await sendTest(tpl.id, {
      to: 'reader@example.com',
      params: { name: '<b>x</b>' },
    }).expect(200)
    expect(res.body.data).toMatchObject({ ok: true, recordId: expect.any(Number) })
    const row = await record(res.body.data.recordId)
    expect(row).toMatchObject({
      status: 'sent',
      template_code: tpl.code,
      locale: 'en-US',
      subject: 'Hello <b>x</b>',
      attempts: 1,
    })
    expect(row.to_list).toEqual(['reader@example.com'])
    expect(row.body).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(row.body).not.toMatch(/onerror|<script/i)
    const mail = JSON.parse(
      ((await sendMail.mock.results[0]!.value) as { message: string }).message,
    )
    const sent = sendMail.mock.calls[0]![0] as { html: string; subject: string }
    expect(sent.html).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(sent.subject).toBe('Hello <b>x</b>')
    expect(mail.html).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(mail.subject).toBe('Hello <b>x</b>')
  })

  it('send answers generically and stores a fixed failure code', async () => {
    const tpl = await addTemplate(templateBody(`${PREFIX}send-fail-${++seq}`))
    sendMail.mockRejectedValueOnce(new Error('remote server SECRET 554'))
    const res = await sendTest(tpl.id, { to: 'reader@example.com', params: {} }).expect(200)
    expect(res.body.data.ok).toBe(false)
    const row = await record(res.body.data.recordId)
    expect(row.status).toBe('failed')
    expect(row.error).toBe('send_failed')
    // not the provider's text (`554` alone also turns up in a timestamp's milliseconds)
    expect(JSON.stringify(res.body) + JSON.stringify(row)).not.toMatch(/SECRET|remote server/)
  })

  it('send records a refused outbound target without dialing it', async () => {
    const tpl = await addTemplate(templateBody(`${PREFIX}send-refused-${++seq}`))
    const res = await strict(
      () => sendTest(tpl.id, { to: 'reader@example.com', params: {} }).expect(200),
      { OUTBOUND_SMTP_PORTS: [port] },
    )
    expect(res.body.data.ok).toBe(false)
    expect((await record(res.body.data.recordId)).error).toBe('refused')
    expect(sendMail).not.toHaveBeenCalled()
  })

  it('send reports no_account for disabled or absent account snapshots', async () => {
    const tpl = await addTemplate(templateBody(`${PREFIX}send-no-account-${++seq}`))
    await call('put', `/${accountId}/enabled`, { enabled: false }).expect(200)
    const res = await sendTest(tpl.id, { to: 'reader@example.com', params: {} }).expect(200)
    expect(res.body.data.ok).toBe(false)
    expect((await record(res.body.data.recordId)).error).toBe('no_account')
    const id = await channel.write({
      template: { ...tpl, accountId: null },
      recipient: {
        userId: null,
        email: 'reader@example.com',
        mobile: null,
        locale: 'en-US',
        timezone: 'UTC',
      },
      params: {},
      values: {},
    })
    await ds.query('UPDATE msg_mail_record SET account_id = NULL WHERE id = ?', [id])
    await channel.deliver(id)
    expect((await record(id)).error).toBe('no_account')
  })

  it('send channel skips missing addresses, selects enabled templates and claims once', async () => {
    expect(channel).toBeDefined()
    const code = `${PREFIX}send-channel-${++seq}`
    const tpl = await addTemplate(templateBody(code))
    await addTemplate(templateBody(code, { locale: 'zh-CN', enabled: false }))
    expect((await channel.templates(code)).map((row) => row.id)).toEqual([tpl.id])
    const draft = {
      template: tpl,
      recipient: {
        userId: null,
        email: null,
        mobile: null,
        locale: 'en-US' as const,
        timezone: 'UTC',
      },
      params: {},
      values: {},
    }
    const skippedId = await app.get(TransactionHost).withTransaction(() => channel.write(draft))
    expect(await record(skippedId)).toMatchObject({ status: 'skipped', error: 'no_address' })
    expect(await channel.due(100)).not.toContain(skippedId)
    const pendingId = await channel.write({
      ...draft,
      recipient: { ...draft.recipient, email: 'reader@example.com' },
    })
    expect(await channel.due(100)).toContain(pendingId)
    await Promise.all([channel.deliver(pendingId), channel.deliver(pendingId)])
    expect(sendMail).toHaveBeenCalledTimes(1)
    expect((await record(pendingId)).status).toBe('sent')
    await ds.query('UPDATE msg_mail_record SET status = ?, attempts = ? WHERE id = ?', [
      'failed',
      2,
      pendingId,
    ])
    expect(await channel.due(100)).toContain(pendingId)
    await ds.query('UPDATE msg_mail_record SET status = ?, attempts = ? WHERE id = ?', [
      'failed',
      3,
      pendingId,
    ])
    expect(await channel.due(100)).not.toContain(pendingId)
  })

  it('send endpoint enforces permission, email validation and unknown id', async () => {
    const tpl = await addTemplate(templateBody(`${PREFIX}send-auth-${++seq}`))
    expect((await sendTest(tpl.id, { to: 'reader@example.com', params: {} }, reader)).status).toBe(
      403,
    )
    expect((await sendTest(tpl.id, { to: 'bad', params: {} })).status).toBe(400)
    expect((await sendTest(999_999, { to: 'reader@example.com', params: {} })).status).toBe(404)
  })
})
