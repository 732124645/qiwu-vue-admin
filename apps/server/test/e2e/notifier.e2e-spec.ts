import { Injectable } from '@nestjs/common'
import { Propagation, Transactional, TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { DEFAULT_TIMEZONE, DEFAULT_TIMEZONE_PARAM, RT, type Locale } from '@qiwu/shared'
import { ClsService } from 'nestjs-cls'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import {
  fillTemplate,
  NOTIFY_CLAIM_TIMEOUT_MS,
  NOTIFY_MAX_ATTEMPTS,
  Notifier,
  NotifyChannels,
  NotifyDispatcher,
  type NotifyChannel,
  type NotifyDraft,
  type NotifySend,
  type NotifyTemplate,
} from '../../src/core/notify/notify.js'
import { RealtimeService } from '../../src/core/realtime/realtime.service.js'
import { ParamService } from '../../src/core/settings/param.service.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { MailTransports } from '../../src/modules/platform/messaging/mail-account/mail-transports.js'
import { SmsClients } from '../../src/modules/platform/messaging/sms-channel/sms-clients.js'
import { cleanRedis } from '../setup/redis.js'

const PREFIX = 'test.notify.'
const OUTBOX = `${PREFIX}outbox`
const RENDER = `${PREFIX}render`
const DISABLED = `${PREFIX}disabled`
const MAIL = `${PREFIX}mail`
const SMS = `${PREFIX}sms`
const staleClaim = () => new Date(Date.now() - NOTIFY_CLAIM_TIMEOUT_MS - 1000)
const dispatch = () =>
  dispatcher.dispatch({}, { signal: new AbortController().signal, log: () => {} })
const mailRecord = (status: string, attempts: number, claimedAt: Date | null = null) =>
  insertRow(ds.manager, 'msg_mail_record', {
    account_id: mailAccountId,
    to_list: ['reader@example.invalid'],
    template_code: MAIL,
    locale: 'en-US',
    subject: 'Recovery',
    body: '<p>Recovery</p>',
    status,
    attempts,
    claimed_at: claimedAt,
  })
const smsRecord = (status: string, attempts: number, claimedAt: Date | null = null, otp = false) =>
  insertRow(ds.manager, 'msg_sms_record', {
    channel_id: smsChannelId,
    template_code: SMS,
    mobile: '13800138000',
    body: otp ? '******' : 'Recovery',
    params: { templateId: smsTemplateId, values: otp ? { code: '******' } : {} },
    status,
    attempts,
    claimed_at: claimedAt,
  })

@Injectable()
class TxCalls {
  constructor(private readonly notifier: Notifier) {}

  @Transactional()
  async send(input: NotifySend) {
    return this.notifier.send(input)
  }

  @Transactional()
  async fails(input: NotifySend) {
    await this.notifier.send(input)
    throw new Error('rollback')
  }

  @Transactional(Propagation.Nested)
  async nestedSend(input: NotifySend) {
    return this.notifier.send(input)
  }

  @Transactional()
  async nestedFails(input: NotifySend) {
    await this.nestedSend(input)
    throw new Error('outer rollback')
  }

  @Transactional()
  async nestedWaits(input: NotifySend, gate: Promise<void>, entered: () => void) {
    const ids = await this.nestedSend(input)
    entered()
    await gate
    return ids
  }
}

interface MailTemplate extends NotifyTemplate {
  subject: string
  body: string
}

class TestMailChannel implements NotifyChannel<MailTemplate> {
  readonly code = 'mail'
  constructor(
    private readonly ds: DataSource,
    private readonly tx: TransactionHost<TransactionalAdapterTypeOrm>,
  ) {}

  templates(code: string): Promise<MailTemplate[]> {
    return this.ds.query(
      'SELECT id, code, locale, subject, body FROM msg_mail_template WHERE code = ? AND enabled = 1',
      [code],
    )
  }

  async write({ template, recipient, params, values }: NotifyDraft<MailTemplate>): Promise<number> {
    const email = recipient.email
    const result: { insertId: number } = await this.tx.tx.query(
      `INSERT INTO msg_mail_record (user_id, to_list, template_code, locale, subject, body, params, status, error, attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        recipient.userId,
        JSON.stringify(email ? [email] : []),
        template.code,
        template.locale,
        fillTemplate(template.subject, values),
        fillTemplate(template.body, values, true),
        JSON.stringify(params),
        email ? 'pending' : 'skipped',
        email ? null : 'no_address',
      ],
    )
    return Number(result.insertId)
  }

  async due(limit: number): Promise<number[]> {
    const rows: { id: number }[] = await this.ds.query(
      `SELECT id FROM msg_mail_record WHERE status IN ('pending', 'failed') AND attempts < ? ORDER BY id LIMIT ?`,
      [NOTIFY_MAX_ATTEMPTS, limit],
    )
    return rows.map((row) => Number(row.id))
  }

  async expire(): Promise<void> {}

  async deliver(id: number): Promise<void> {
    await this.ds.query(
      `UPDATE msg_mail_record SET status = 'sent', attempts = attempts + 1
       WHERE id = ? AND status IN ('pending', 'failed') AND attempts < ?`,
      [id, NOTIFY_MAX_ATTEMPTS],
    )
  }
}

let app: NestExpressApplication
let ds: DataSource
let notifier: Notifier
let dispatcher: NotifyDispatcher
let tx: TxCalls
let cls: ClsService
let push: ReturnType<typeof vi.spyOn>
let mailAccountId: number
let smsChannelId: number
let smsTemplateId: number
const users: Record<'zh' | 'en' | 'fallback' | 'noEmail', number> = {
  zh: 0,
  en: 0,
  fallback: 0,
  noEmail: 0,
}
const outboxInput = (userId = users.en): NotifySend => ({
  template: OUTBOX,
  to: [userId],
  channels: ['inbox'],
  params: { name: 'Ada' },
})
const inboxRows = () =>
  ds.query<
    { id: number; status: string; attempts: number; title: string; body: string; locale: string }[]
  >(
    'SELECT id, status, attempts, title, body, locale FROM msg_inbox WHERE template_code LIKE ? ORDER BY id',
    [`${PREFIX}%`],
  )
const clearRecords = async () => {
  await dispatcher.idle()
  await ds.query('DELETE FROM msg_inbox WHERE template_code LIKE ?', [`${PREFIX}%`])
  await ds.query('DELETE FROM msg_mail_record WHERE template_code LIKE ?', [`${PREFIX}%`])
  await ds.query('DELETE FROM msg_sms_record WHERE template_code LIKE ?', [`${PREFIX}%`])
  push.mockClear()
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    providers: [TxCalls],
  }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  notifier = app.get(Notifier)
  dispatcher = app.get(NotifyDispatcher)
  tx = app.get(TxCalls)
  cls = app.get(ClsService)
  await cleanRedis(app.get<Redis>(REDIS))
  push = vi.spyOn(app.get(RealtimeService), 'toUser').mockImplementation(() => {})
  const channels = app.get(NotifyChannels)
  if (!channels.get('mail')) channels.register(new TestMailChannel(ds, app.get(TransactionHost)))
  for (const [key, locale, timezone, email] of [
    ['zh', 'zh-CN', 'Asia/Shanghai', 'zh@example.invalid'],
    ['en', 'en-US', 'America/New_York', 'en@example.invalid'],
    ['fallback', 'en-US', null, 'fallback@example.invalid'],
    ['noEmail', 'en-US', null, null],
  ] as const)
    users[key] = await insertRow(ds.manager, 'iam_user', {
      username: `e2e-${PREFIX}${key}`,
      display_name: key,
      password_hash: 'unused',
      locale,
      timezone,
      email,
      password_changed_at: new Date(),
    })
  for (const [code, locale, title, body, enabled] of [
    [OUTBOX, 'en-US', 'Hello {name}', 'Notice {name}', 1],
    [RENDER, 'zh-CN', 'ZH {state}', '{when}|{action}|{unknown}|{raw}', 1],
    [RENDER, 'en-US', 'EN {state}', '{when}|{action}|{unknown}|{raw}', 1],
    [DISABLED, 'en-US', 'Disabled', 'Disabled', 0],
  ] as const)
    await insertRow(ds.manager, 'msg_inbox_template', {
      code,
      locale,
      name: code,
      title,
      body,
      category: 'system',
      enabled,
    })
  for (const [locale, subject] of [
    ['en-US', 'EN {when}'],
    ['zh-CN', 'ZH {when}'],
  ] as const)
    await insertRow(ds.manager, 'msg_mail_template', {
      code: MAIL,
      locale,
      name: MAIL,
      subject,
      body: '<p>{when}</p>',
      enabled: 1,
    })
  mailAccountId = await insertRow(ds.manager, 'msg_mail_account', {
    name: MAIL,
    address: 'notify@example.invalid',
    host: 'example.invalid',
    port: 25,
    security: 'none',
    enabled: 1,
  })
  smsChannelId = await insertRow(ds.manager, 'msg_sms_channel', {
    driver: 'debug',
    name: SMS,
    enabled: 1,
  })
  smsTemplateId = await insertRow(ds.manager, 'msg_sms_template', {
    code: SMS,
    locale: 'en-US',
    name: SMS,
    purpose: 'notice',
    body: 'Hello',
    channel_id: smsChannelId,
    enabled: 1,
  })
})

afterEach(clearRecords)

afterAll(async () => {
  if (ds) {
    await dispatcher.idle()
    await ds.query('DELETE FROM msg_inbox WHERE template_code LIKE ?', [`${PREFIX}%`])
    await ds.query('DELETE FROM msg_mail_record WHERE template_code LIKE ?', [`${PREFIX}%`])
    await ds.query('DELETE FROM msg_sms_record WHERE template_code LIKE ?', [`${PREFIX}%`])
    await ds.query('DELETE FROM msg_inbox_template WHERE code LIKE ?', [`${PREFIX}%`])
    await ds.query('DELETE FROM msg_mail_template WHERE code LIKE ?', [`${PREFIX}%`])
    await ds.query('DELETE FROM msg_sms_template WHERE code LIKE ?', [`${PREFIX}%`])
    await ds.query('DELETE FROM msg_sms_channel WHERE id = ?', [smsChannelId])
    await ds.query('DELETE FROM msg_mail_account WHERE id = ?', [mailAccountId])
    await ds.query('DELETE FROM iam_user WHERE id IN (?)', [Object.values(users)])
  }
  if (app) {
    await cleanRedis(app.get<Redis>(REDIS))
    await app.close()
  }
})

describe('outbox', () => {
  it('delivers a direct write once with its rendered push', async () => {
    const ids = await notifier.send(outboxInput())
    expect(ids.inbox).toHaveLength(1)
    expect(await inboxRows()).toMatchObject([
      { id: ids.inbox![0], status: 'delivered', attempts: 1, title: 'Hello Ada' },
    ])
    expect(push).toHaveBeenCalledExactlyOnceWith(users.en, {
      type: RT.notifyNew,
      payload: { id: ids.inbox![0], title: 'Hello Ada' },
    })
  })

  it('waits for the transaction commit', async () => {
    const ids = await tx.send(outboxInput())
    await dispatcher.idle()
    expect((await inboxRows())[0]).toMatchObject({
      id: ids.inbox![0],
      status: 'delivered',
      attempts: 1,
    })
    expect(push).toHaveBeenCalledTimes(1)
  })

  it('discards rows and pushes on business rollback', async () => {
    await expect(tx.fails(outboxInput())).rejects.toThrow('rollback')
    await dispatcher.idle()
    expect(await inboxRows()).toEqual([])
    expect(push).not.toHaveBeenCalled()
  })

  it('does not flush a nested send when its outer transaction rolls back', async () => {
    await expect(tx.nestedFails(outboxInput())).rejects.toThrow('outer rollback')
    await dispatcher.idle()
    expect(await inboxRows()).toEqual([])
    expect(push).not.toHaveBeenCalled()
  })

  it('flushes a nested send only after the outer method commits', async () => {
    const start = vi.spyOn(dispatcher, 'start')
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const inside = new Promise<void>((resolve) => {
      entered = resolve
    })
    try {
      const outer = tx.nestedWaits(outboxInput(), gate, entered)
      await inside
      expect(await inboxRows()).toEqual([])
      expect(start).not.toHaveBeenCalled()
      expect(push).not.toHaveBeenCalled()
      release()
      await outer
      await dispatcher.idle()
      expect((await inboxRows())[0]).toMatchObject({ status: 'delivered' })
      expect(start).toHaveBeenCalledTimes(1)
      expect(push).toHaveBeenCalledTimes(1)
    } finally {
      release()
      start.mockRestore()
    }
  })

  it('writes one row for a user listed twice', async () => {
    const ids = await notifier.send({ ...outboxInput(), to: [users.en, users.en] })
    expect(ids.inbox).toHaveLength(1)
    expect(await inboxRows()).toHaveLength(1)
    expect(push).toHaveBeenCalledTimes(1)
  })

  it('recovers a missed flush and never retries exhausted rows', async () => {
    const start = vi.spyOn(dispatcher, 'start').mockImplementation(() => {})
    let ids: Awaited<ReturnType<Notifier['send']>>
    try {
      ids = await tx.send(outboxInput())
    } finally {
      start.mockRestore()
    }
    expect((await inboxRows())[0]).toMatchObject({
      id: ids!.inbox![0],
      status: 'pending',
      attempts: 0,
    })
    await ds.query('UPDATE msg_inbox SET attempts = 3 WHERE id = ?', [ids!.inbox![0]])
    await dispatcher.dispatch({}, { signal: new AbortController().signal, log: () => {} })
    expect(push).not.toHaveBeenCalled()
    await ds.query('UPDATE msg_inbox SET attempts = 0 WHERE id = ?', [ids!.inbox![0]])
    await dispatcher.dispatch({}, { signal: new AbortController().signal, log: () => {} })
    expect((await inboxRows())[0]).toMatchObject({ status: 'delivered', attempts: 1 })
    expect(push).toHaveBeenCalledTimes(1)
  })

  it('claims once when flush and recovery race', async () => {
    const start = vi.spyOn(dispatcher, 'start').mockImplementation(() => {})
    let ids: Awaited<ReturnType<Notifier['send']>>
    try {
      ids = await tx.send(outboxInput())
    } finally {
      start.mockRestore()
    }
    await Promise.all([
      dispatcher.flush(ids!),
      dispatcher.dispatch({}, { signal: new AbortController().signal, log: () => {} }),
    ])
    expect((await inboxRows())[0]).toMatchObject({ status: 'delivered', attempts: 1 })
    expect(push).toHaveBeenCalledTimes(1)
  })

  it('reclaims crashed mail and SMS sends once with a new UTC claim token', async () => {
    const mailId = await mailRecord('sending', 1, staleClaim())
    const smsId = await smsRecord('sending', 1, staleClaim())
    const mailSend = vi
      .spyOn(app.get(MailTransports), 'send')
      .mockResolvedValue({ messageId: 'mail-recovered' } as Awaited<
        ReturnType<MailTransports['send']>
      >)
    const smsSend = vi.fn().mockResolvedValue({ providerMsgId: 'sms-recovered' })
    const forClient = vi.spyOn(app.get(SmsClients), 'for').mockResolvedValue({
      send: smsSend,
      test: async () => true,
    })
    try {
      await dispatch()
      const [mail] = await ds.query(
        'SELECT status, attempts, provider_msg_id, claimed_at FROM msg_mail_record WHERE id = ?',
        [mailId],
      )
      const [sms] = await ds.query(
        'SELECT status, attempts, provider_msg_id, claimed_at FROM msg_sms_record WHERE id = ?',
        [smsId],
      )
      expect(mail).toMatchObject({ status: 'sent', attempts: 2, provider_msg_id: 'mail-recovered' })
      expect(sms).toMatchObject({ status: 'sent', attempts: 2, provider_msg_id: 'sms-recovered' })
      expect(mail.claimed_at).toBeInstanceOf(Date)
      expect(sms.claimed_at).toBeInstanceOf(Date)
      expect(mailSend).toHaveBeenCalledTimes(1)
      expect(smsSend).toHaveBeenCalledTimes(1)
      await dispatch()
      expect(mailSend).toHaveBeenCalledTimes(1)
      expect(smsSend).toHaveBeenCalledTimes(1)
    } finally {
      mailSend.mockRestore()
      forClient.mockRestore()
    }
  })

  it('leaves fresh sending claims alone', async () => {
    const mailId = await mailRecord('sending', 1, new Date())
    const smsId = await smsRecord('sending', 1, new Date())
    const inboxId = await insertRow(ds.manager, 'msg_inbox', {
      user_id: users.en,
      template_code: OUTBOX,
      locale: 'en-US',
      category: 'system',
      title: 'In progress',
      body: 'In progress',
      status: 'sending',
      attempts: 1,
      claimed_at: new Date(),
    })
    const mailSend = vi.spyOn(app.get(MailTransports), 'send')
    const smsFor = vi.spyOn(app.get(SmsClients), 'for')
    try {
      const channels = app.get(NotifyChannels)
      expect(await channels.get('mail')!.due(100)).not.toContain(mailId)
      expect(await channels.get('sms')!.due(100)).not.toContain(smsId)
      expect(await channels.get('inbox')!.due(100)).not.toContain(inboxId)
      await dispatch()
      for (const [table, id] of [
        ['msg_mail_record', mailId],
        ['msg_sms_record', smsId],
        ['msg_inbox', inboxId],
      ] as const) {
        const [row] = await ds.query(`SELECT status, attempts FROM ${table} WHERE id = ?`, [id])
        expect(row).toMatchObject({ status: 'sending', attempts: 1 })
      }
      expect(mailSend).not.toHaveBeenCalled()
      expect(smsFor).not.toHaveBeenCalled()
      expect(push).not.toHaveBeenCalled()
    } finally {
      mailSend.mockRestore()
      smsFor.mockRestore()
    }
  })

  it('keeps the newer claimer result when the old sender finishes late', async () => {
    const id = await mailRecord('pending', 0)
    let release!: (value: { messageId: string }) => void
    let entered!: () => void
    const gate = new Promise<{ messageId: string }>((resolve) => {
      release = resolve
    })
    const inside = new Promise<void>((resolve) => {
      entered = resolve
    })
    const send = vi
      .spyOn(app.get(MailTransports), 'send')
      .mockImplementationOnce(async () => {
        entered()
        return (await gate) as Awaited<ReturnType<MailTransports['send']>>
      })
      .mockResolvedValueOnce({ messageId: 'new-claim' } as Awaited<
        ReturnType<MailTransports['send']>
      >)
    try {
      const first = app.get(NotifyChannels).get('mail')!.deliver(id)
      await inside
      const [claimed] = await ds.query('SELECT claimed_at FROM msg_mail_record WHERE id = ?', [id])
      expect(claimed.claimed_at).toBeInstanceOf(Date)
      await ds.query('UPDATE msg_mail_record SET claimed_at = ? WHERE id = ?', [staleClaim(), id])
      await dispatch()
      release({ messageId: 'old-claim' })
      await first
      const [row] = await ds.query(
        'SELECT status, attempts, provider_msg_id FROM msg_mail_record WHERE id = ?',
        [id],
      )
      expect(row).toMatchObject({ status: 'sent', attempts: 2, provider_msg_id: 'new-claim' })
      expect(send).toHaveBeenCalledTimes(2)
    } finally {
      release({ messageId: 'old-claim' })
      send.mockRestore()
    }
  })

  it('fails exhausted stale claims, including masked OTP, without sending', async () => {
    const mailId = await mailRecord('sending', NOTIFY_MAX_ATTEMPTS, staleClaim())
    const otpId = await smsRecord('sending', NOTIFY_MAX_ATTEMPTS, staleClaim(), true)
    const inboxId = await insertRow(ds.manager, 'msg_inbox', {
      user_id: users.en,
      template_code: OUTBOX,
      locale: 'en-US',
      category: 'system',
      title: 'Interrupted',
      body: 'Interrupted',
      status: 'sending',
      attempts: NOTIFY_MAX_ATTEMPTS,
      claimed_at: staleClaim(),
    })
    const mailSend = vi.spyOn(app.get(MailTransports), 'send')
    const smsFor = vi.spyOn(app.get(SmsClients), 'for')
    try {
      await dispatch()
      expect(
        (await ds.query('SELECT status, error FROM msg_mail_record WHERE id = ?', [mailId]))[0],
      ).toMatchObject({ status: 'failed', error: 'interrupted' })
      expect(
        (
          await ds.query('SELECT status, error, params FROM msg_sms_record WHERE id = ?', [otpId])
        )[0],
      ).toMatchObject({
        status: 'failed',
        error: 'interrupted',
        params: { values: { code: '******' } },
      })
      expect(
        (await ds.query('SELECT status FROM msg_inbox WHERE id = ?', [inboxId]))[0].status,
      ).toBe('failed')
      expect(mailSend).not.toHaveBeenCalled()
      expect(smsFor).not.toHaveBeenCalled()
      expect(push).not.toHaveBeenCalled()
    } finally {
      mailSend.mockRestore()
      smsFor.mockRestore()
    }
  })
})

describe('dispatch round', () => {
  it('goes on past a channel whose expire fails: its due rows and the other channels are still handled', async () => {
    const start = vi.spyOn(dispatcher, 'start').mockImplementation(() => {})
    let ids: Awaited<ReturnType<Notifier['send']>>
    try {
      ids = await tx.send(outboxInput())
    } finally {
      start.mockRestore()
    }
    const mailId = await mailRecord('sending', NOTIFY_MAX_ATTEMPTS, staleClaim())
    const expire = vi
      .spyOn(app.get(NotifyChannels).get('inbox')!, 'expire')
      .mockRejectedValue(new Error('Deadlock found when trying to get lock'))
    try {
      await expect(dispatch()).resolves.toMatch(/^processed/)
    } finally {
      expire.mockRestore()
    }
    expect((await inboxRows())[0]).toMatchObject({ id: ids!.inbox![0], status: 'delivered' })
    expect(
      (await ds.query('SELECT status, error FROM msg_mail_record WHERE id = ?', [mailId]))[0],
    ).toMatchObject({ status: 'failed', error: 'interrupted' })
  })
})

describe('render', () => {
  const params = {
    state: { dict: 'core.enabled', value: 'true' },
    when: { datetime: '2026-01-02T03:04:00.000Z' },
    action: { i18n: 'seed.role.root' },
    unknown: { i18n: 'admin.custom.label' },
    raw: '<b>raw</b>',
  } as const

  it('uses each recipient locale, dictionary label, time zone and plain text', async () => {
    const ids = await notifier.send({
      template: RENDER,
      to: [users.zh, users.en],
      channels: ['inbox'],
      params,
    })
    const rows = await inboxRows()
    expect(rows.map((row) => row.id)).toEqual(ids.inbox)
    expect(rows[0]).toMatchObject({ locale: 'zh-CN', title: 'ZH 启用' })
    expect(rows[0]!.body).toContain('超级管理员|admin.custom.label|<b>raw</b>')
    expect(rows[1]).toMatchObject({ locale: 'en-US', title: 'EN Enabled' })
    expect(rows[1]!.body).toBe('2026-01-01 22:04|Super administrator|admin.custom.label|<b>raw</b>')
  })

  it('uses the configured default zone for a user without a stored zone', async () => {
    const configuredZone = await app.get(ParamService).get(DEFAULT_TIMEZONE_PARAM)
    expect(configuredZone).toBe(DEFAULT_TIMEZONE)
    await cls.run(async () => {
      cls.set('timezone', 'America/Los_Angeles')
      await notifier.send({ template: RENDER, to: [users.fallback], channels: ['inbox'], params })
    })
    expect((await inboxRows())[0]).toMatchObject({
      locale: 'en-US',
      body: '2026-01-02 11:04|Super administrator|admin.custom.label|<b>raw</b>',
    })
  })

  it('falls back to the zh-CN row if the user language has no enabled row', async () => {
    await ds.query('UPDATE msg_inbox_template SET enabled = 0 WHERE code = ? AND locale = ?', [
      RENDER,
      'en-US',
    ])
    try {
      await notifier.send({ template: RENDER, to: [users.en], channels: ['inbox'], params })
      expect((await inboxRows())[0]).toMatchObject({ locale: 'zh-CN', title: 'ZH Enabled' })
    } finally {
      await ds.query('UPDATE msg_inbox_template SET enabled = 1 WHERE code = ? AND locale = ?', [
        RENDER,
        'en-US',
      ])
    }
  })

  it('selects enabled channel templates and honors explicit channels', async () => {
    expect(await notifier.send({ template: DISABLED, to: [users.en] })).toEqual({})
    expect(await inboxRows()).toEqual([])
    expect((await notifier.send({ template: OUTBOX, to: [users.en] })).inbox).toHaveLength(1)
    expect(await notifier.send({ template: MAIL, to: [users.en], channels: ['inbox'] })).toEqual({})
  })

  it('uses request language and zone for a direct address; inbox has no row for it', async () => {
    const ids = []
    for (const [locale, timezone] of [
      ['en-US', 'America/Los_Angeles'],
      ['zh-CN', 'Asia/Shanghai'],
    ] as const)
      ids.push(
        await cls.run(async () => {
          cls.set('locale', locale satisfies Locale)
          cls.set('timezone', timezone)
          const inbox = await notifier.send({
            template: RENDER,
            to: [{ email: 'direct@example.invalid' }],
            channels: ['inbox'],
            params,
          })
          expect(inbox).toEqual({})
          return notifier.send({
            template: MAIL,
            to: [{ email: 'direct@example.invalid' }],
            params: { when: params.when },
          })
        }),
      )
    expect(await inboxRows()).toEqual([])
    const rows = await ds.query<{ locale: string; to_list: string[]; subject: string }[]>(
      'SELECT locale, to_list, subject FROM msg_mail_record WHERE id IN (?) ORDER BY id',
      [ids.map((entry) => entry.mail![0])],
    )
    expect(rows).toMatchObject([
      { locale: 'en-US', to_list: ['direct@example.invalid'], subject: 'EN 2026-01-01 19:04' },
      { locale: 'zh-CN', to_list: ['direct@example.invalid'], subject: 'ZH 2026-01-02 11:04' },
    ])
  })

  it('records a missing mail address as skipped without delivery', async () => {
    const ids = await notifier.send({ template: MAIL, to: [users.noEmail], channels: ['mail'] })
    const [row] = await ds.query<{ status: string; to_list: string[]; attempts: number }[]>(
      'SELECT status, to_list, attempts FROM msg_mail_record WHERE id = ?',
      [ids.mail![0]],
    )
    expect(row).toMatchObject({ status: 'skipped', to_list: [], attempts: 0 })
    await dispatcher.dispatch({}, { signal: new AbortController().signal, log: () => {} })
    const [after] = await ds.query<{ status: string; attempts: number }[]>(
      'SELECT status, attempts FROM msg_mail_record WHERE id = ?',
      [ids.mail![0]],
    )
    expect(after).toMatchObject({ status: 'skipped', attempts: 0 })
    expect(push).not.toHaveBeenCalled()
  })
})
