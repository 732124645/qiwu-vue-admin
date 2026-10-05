import { Logger } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, smsChannelPerms, smsTemplatePerms } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { vi } from 'vitest'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { SessionRevoker } from '../../src/core/auth/session-revoker.js'
import { SecretBox } from '../../src/core/crypto/secret-box.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { findId, insertRow, upsert } from '../../src/db/seeds/upsert.js'
import { SmsClients } from '../../src/modules/platform/messaging/sms-channel/sms-clients.js'
import { NotifyChannels, NotifyDispatcher } from '../../src/core/notify/notify.js'
import { CaptchaTicketVerifier } from '../../src/core/captcha/captcha-ticket.js'
import { ParamService } from '../../src/core/settings/param.service.js'
import { keyPattern, redisKey } from '../../src/core/redis/cache-namespaces.js'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { SmsNotifyChannel } from '../../src/modules/platform/messaging/sms-template/sms-notify-channel.js'
import { SmsTemplate } from '../../src/modules/platform/messaging/sms-template/sms-template.entity.js'
import { OtpService } from '../../src/modules/platform/messaging/sms-otp/sms-otp.service.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const mocks = vi.hoisted(() => ({
  aliLoad: vi.fn<() => void>(),
  aliConfig: vi.fn<(config: unknown) => void>(),
  aliSend: vi.fn<(request: unknown) => Promise<unknown>>(),
  aliTest: vi.fn<(request: unknown) => Promise<unknown>>(),
  tencentLoad: vi.fn<() => void>(),
  tencentConfig: vi.fn<(config: unknown) => void>(),
  tencentSend: vi.fn<(request: unknown) => Promise<unknown>>(),
  tencentTest: vi.fn<(request: unknown) => Promise<unknown>>(),
}))

vi.mock('@alicloud/dysmsapi20170525', () => {
  mocks.aliLoad()
  return {
    default: {
      default: class {
        constructor(config: unknown) {
          mocks.aliConfig(config)
        }
        sendSms(req: unknown) {
          return mocks.aliSend(req)
        }
        querySmsSignList(req: unknown) {
          return mocks.aliTest(req)
        }
      },
      SendSmsRequest: class {
        constructor(fields: object) {
          Object.assign(this, fields)
        }
      },
      QuerySmsSignListRequest: class {
        constructor(fields: object) {
          Object.assign(this, fields)
        }
      },
    },
  }
})
vi.mock('tencentcloud-sdk-nodejs-sms', () => {
  mocks.tencentLoad()
  return {
    default: {
      sms: {
        v20210111: {
          Client: class {
            constructor(config: unknown) {
              mocks.tencentConfig(config)
            }
            SendSms(req: unknown) {
              return mocks.tencentSend(req)
            }
            DescribeSmsSignList(req: unknown) {
              return mocks.tencentTest(req)
            }
          },
        },
      },
    },
  }
})

const URL = '/api/messaging/sms-channels'
const PREFIX = 'sms-e2e-'
let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let clients: SmsClients
let admin: string
let reader: string
let roleId: number
let userId: number
let lastId: number
let lastTemplateId: number
let lastRecordId: number
let seq = 0

const body = (over: object = {}) => ({ driver: 'debug', name: `${PREFIX}${++seq}`, ...over })
const call = (method: 'get' | 'post' | 'put', path = '', payload?: object, token = admin) => {
  const req = request(app.getHttpServer())[method](`${URL}${path}`).set(bearer(token))
  return payload ? req.send(payload) : req
}
const add = async (payload: object) =>
  (await call('post', '', payload).expect(201)).body.data as { id: number }
const saved = async (id: number) =>
  (
    await ds.query(
      'SELECT driver, api_secret_enc AS apiSecretEnc, receipt_secret_enc AS receiptSecretEnc FROM msg_sms_channel WHERE id = ?',
      [id],
    )
  )[0] as { driver: string; apiSecretEnc: string; receiptSecretEnc: string }
const sms = {
  mobile: '13800138000',
  body: 'hello debug body',
  templateId: 'TPL123',
  params: { a: 'one', b: 'two' },
  paramOrder: ['b', 'a'],
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  clients = app.get(SmsClients)
  await cleanRedis(redis)
  lastId = Number((await ds.query('SELECT COALESCE(MAX(id), 0) AS n FROM msg_sms_channel'))[0].n)
  lastTemplateId = Number(
    (await ds.query('SELECT COALESCE(MAX(id), 0) AS n FROM msg_sms_template'))[0].n,
  )
  lastRecordId = Number(
    (await ds.query('SELECT COALESCE(MAX(id), 0) AS n FROM msg_sms_record'))[0].n,
  )
  roleId = await insertRow(ds.manager, 'iam_role', {
    code: `${PREFIX}reader`,
    name: `${PREFIX}reader`,
    data_scope: 'all',
  })
  const browse = await findId(ds.manager, 'iam_menu', { perms: smsChannelPerms.browse })
  await ds.query('INSERT INTO iam_role_menus (role_id, menu_id) VALUES (?, ?)', [roleId, browse])
  const createTemplate = await findId(ds.manager, 'iam_menu', { perms: smsTemplatePerms.create })
  await ds.query('INSERT INTO iam_role_menus (role_id, menu_id) VALUES (?, ?)', [
    roleId,
    createTemplate,
  ])
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
    await ds.query('DELETE FROM msg_sms_record WHERE id > ?', [lastRecordId])
    await ds.query('DELETE FROM msg_sms_template WHERE id > ?', [lastTemplateId])
    await ds.query('DELETE FROM msg_sms_channel WHERE id > ?', [lastId])
    await ds.query('DELETE FROM iam_user_roles WHERE user_id = ?', [userId])
    await ds.query('DELETE FROM iam_user WHERE id = ?', [userId])
    await ds.query('DELETE FROM iam_role_menus WHERE role_id = ?', [roleId])
    await ds.query('DELETE FROM iam_role WHERE id = ?', [roleId])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

describe('channel', () => {
  it('boxes both secrets, hides them in every answer, keeps blanks, and replaces new values', async () => {
    const first = { apiSecret: 'first-api', receiptSecret: 'first-receipt' }
    const posted = (await call('post', '', body(first)).expect(201)).body.data
    const id = posted.id as number
    const hidden = (value: unknown) => {
      expect(JSON.stringify(value)).not.toContain('first-api')
      expect(JSON.stringify(value)).not.toContain('first-receipt')
      expect(JSON.stringify(value)).not.toContain('apiSecret')
      expect(JSON.stringify(value)).not.toContain('receiptSecret')
    }
    hidden(posted)
    hidden((await call('get', `/${id}`).expect(200)).body)
    hidden((await call('get').expect(200)).body)
    const box = app.get(SecretBox)
    const original = await saved(id)
    expect(box.decrypt(original.apiSecretEnc)).toBe(first.apiSecret)
    expect(box.decrypt(original.receiptSecretEnc)).toBe(first.receiptSecret)
    await call('put', `/${id}`, {}).expect(200)
    await call('put', `/${id}`, { apiSecret: '', receiptSecret: '' }).expect(200)
    expect(await saved(id)).toEqual(original)
    await call('put', `/${id}`, { apiSecret: 'next-api', receiptSecret: 'next-receipt' }).expect(
      200,
    )
    const next = await saved(id)
    expect(next.apiSecretEnc).not.toBe(original.apiSecretEnc)
    expect(box.decrypt(next.apiSecretEnc)).toBe('next-api')
    expect(box.decrypt(next.receiptSecretEnc)).toBe('next-receipt')
  })

  it('validates the whole resulting row and keeps a failed driver switch atomic', async () => {
    const id = (await add(body())).id
    for (const payload of [
      body({ driver: 'aliyun', signName: 'sign', apiSecret: 'secret' }),
      body({ driver: 'aliyun', signName: 'sign', apiKey: 'id' }),
      body({ driver: 'tencent', signName: 'sign', apiKey: 'id', apiSecret: 'secret' }),
    ]) {
      const res = await call('post', '', payload).expect(422)
      expect(res.body.code).toBe(Err.SMS_CHANNEL_INCOMPLETE.code)
    }
    const bad = await call('put', `/${id}`, { driver: 'aliyun' }).expect(422)
    expect(bad.body.code).toBe(Err.SMS_CHANNEL_INCOMPLETE.code)
    expect((await saved(id)).driver).toBe('debug')
    await call('put', `/${id}`, {
      driver: 'aliyun',
      signName: 'sign',
      apiKey: 'id',
      apiSecret: 'secret',
    }).expect(200)
    expect((await saved(id)).driver).toBe('aliyun')
    for (const region of ['cn-hangzhou.evil.com', 'a/b'])
      await call('post', '', body({ region })).expect(400)
  })

  it('debug logs one line, returns an id, tests true, and loads no SDK', async () => {
    const id = (await add(body())).id
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    try {
      expect(await (await clients.for(id)).send(sms)).toMatchObject({
        providerMsgId: expect.stringMatching(/^debug-/),
      })
      expect(log).toHaveBeenCalledTimes(1)
      expect(String(log.mock.calls[0]?.[0])).toContain(sms.mobile)
      expect(String(log.mock.calls[0]?.[0])).toContain(sms.body)
      expect((await call('post', `/${id}/test`).expect(200)).body.data).toEqual({ ok: true })
      expect(mocks.aliLoad).not.toHaveBeenCalled()
      expect(mocks.tencentLoad).not.toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
  })

  it('aliyun uses decrypted credentials, request fields and read-only test; errors stay generic', async () => {
    const id = (
      await add(
        body({
          driver: 'aliyun',
          signName: 'sign',
          apiKey: 'access-id',
          apiSecret: 'secret-value',
        }),
      )
    ).id
    mocks.aliTest.mockResolvedValue({ body: { code: 'OK' } })
    expect((await call('post', `/${id}/test`).expect(200)).body.data).toEqual({ ok: true })
    expect(mocks.aliTest).toHaveBeenCalledWith(
      expect.objectContaining({ pageIndex: 1, pageSize: 1 }),
    )
    mocks.aliTest.mockResolvedValue({
      body: { code: 'Rejected', message: 'provider-secret-error' },
    })
    expect((await call('post', `/${id}/test`).expect(200)).body.data).toEqual({ ok: false })
    mocks.aliSend.mockResolvedValue({ body: { code: 'OK', bizId: 'biz-1' } })
    expect(await (await clients.for(id)).send(sms)).toEqual({ providerMsgId: 'biz-1' })
    expect(mocks.aliConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        accessKeyId: 'access-id',
        accessKeySecret: 'secret-value',
        endpoint: 'dysmsapi.aliyuncs.com',
        regionId: 'cn-hangzhou',
        readTimeout: 5000,
        connectTimeout: 5000,
      }),
    )
    expect(mocks.aliSend).toHaveBeenCalledWith(
      expect.objectContaining({
        signName: 'sign',
        templateCode: sms.templateId,
        templateParam: JSON.stringify(sms.params),
      }),
    )
    mocks.aliTest.mockRejectedValue(new Error('provider-secret-error'))
    const failed = await call('post', `/${id}/test`).expect(200)
    expect(failed.body.data).toEqual({ ok: false })
    expect(JSON.stringify(failed.body)).not.toContain('provider-secret-error')
    mocks.aliSend.mockResolvedValue({
      body: { code: 'Rejected', message: 'provider-secret-error' },
    })
    await expect((await clients.for(id)).send(sms)).rejects.toThrow('SMS provider failed')
  })

  it('tencent sends E.164 and ordered params, and rejects failed status generically', async () => {
    const id = (
      await add(
        body({
          driver: 'tencent',
          signName: 'sign',
          appId: 'app1',
          apiKey: 'secret-id',
          apiSecret: 'secret-key',
        }),
      )
    ).id
    mocks.tencentTest.mockResolvedValue({})
    expect((await call('post', `/${id}/test`).expect(200)).body.data).toEqual({ ok: true })
    mocks.tencentSend.mockResolvedValue({ SendStatusSet: [{ Code: 'Ok', SerialNo: 'serial-1' }] })
    expect(await (await clients.for(id)).send(sms)).toEqual({ providerMsgId: 'serial-1' })
    expect(mocks.tencentConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: { secretId: 'secret-id', secretKey: 'secret-key' },
        region: 'ap-guangzhou',
        profile: { httpProfile: { reqTimeout: 5 } },
      }),
    )
    expect(mocks.tencentSend).toHaveBeenCalledWith(
      expect.objectContaining({
        PhoneNumberSet: ['+8613800138000'],
        SmsSdkAppId: 'app1',
        SignName: 'sign',
        TemplateId: sms.templateId,
        TemplateParamSet: ['two', 'one'],
      }),
    )
    mocks.tencentSend.mockResolvedValue({
      SendStatusSet: [{ Code: 'Failed', Message: 'provider-secret-error' }],
    })
    await expect((await clients.for(id)).send(sms)).rejects.toThrow('SMS provider failed')
  })

  it('test needs modify and returns 404 for unknown id', async () => {
    const id = (await add(body())).id
    expect((await call('post', `/${id}/test`, undefined, reader).expect(403)).body.code).toBe(
      Err.FORBIDDEN.code,
    )
    await call('post', '/999999/test').expect(404)
  })
})

describe('receipt', () => {
  const secret = 'receipt-secret-1'
  let sendSeq = 0
  let channelId: number
  let templateId: number
  let notify: SmsNotifyChannel
  const templateUrl = '/api/messaging/sms-templates'
  const receipt = (id: number, token: string | null, payload: object) => {
    const url = `/api/messaging/sms/receipt/${id}${token === null ? '' : `?token=${encodeURIComponent(token)}`}`
    return request(app.getHttpServer()).post(url).send(payload)
  }
  const record = async (id: number) =>
    (await ds.query('SELECT * FROM msg_sms_record WHERE id = ?', [id]))[0] as Record<
      string,
      unknown
    >
  const createTemplate = async (over: object = {}) =>
    (
      await request(app.getHttpServer())
        .post(templateUrl)
        .set(bearer(admin))
        .send({
          code: `${PREFIX}receipt-${++seq}`,
          locale: 'en-US',
          channelId,
          name: 'Receipt template',
          purpose: 'notice',
          body: 'Code {code} to {name}',
          providerTemplateId: 'TPL-RECEIPT',
          ...over,
        })
        .expect(201)
    ).body.data as {
      id: number
      code: string
      locale: string
      channelId: number
      body: string
      paramNames: unknown
    }
  const testSend = (
    id: number,
    token = admin,
    payload: object = { mobile: '13800138000', params: { code: String(++sendSeq), name: 'Ada' } },
  ) =>
    request(app.getHttpServer()).post(`${templateUrl}/${id}/test`).set(bearer(token)).send(payload)

  beforeAll(async () => {
    channelId = (await add(body({ receiptSecret: secret }))).id
    templateId = (await createTemplate()).id
    notify = app.get(NotifyChannels).get('sms') as SmsNotifyChannel
  })

  it('test sends the stored text and persists the exact template and values', async () => {
    const res = await testSend(templateId).expect(200)
    expect(res.body.data).toMatchObject({ ok: true, recordId: expect.any(Number) })
    const row = await record(res.body.data.recordId)
    expect(row).toMatchObject({
      status: 'sent',
      channel_id: channelId,
      mobile: '13800138000',
      body: 'Code 1 to Ada',
      attempts: 1,
      params: { templateId, values: { code: '1', name: 'Ada' } },
    })
    expect(row.provider_msg_id).toMatch(/^debug-/)
  })

  it('skips missing mobile, finds enabled templates and claims a pending record once', async () => {
    const tpl = await createTemplate()
    await createTemplate({ code: tpl.code, locale: 'zh-CN', enabled: false })
    expect((await notify.templates(tpl.code)).map((row) => row.id)).toEqual([tpl.id])
    const draft = {
      template: await ds.getRepository(SmsTemplate).findOneByOrFail({ id: tpl.id }),
      recipient: {
        userId: null,
        email: null,
        mobile: null,
        locale: 'en-US' as const,
        timezone: 'UTC',
      },
      params: {},
      values: { code: 'x', name: 'y' },
    }
    const skippedId = await app.get(TransactionHost).withTransaction(() => notify.write(draft))
    expect(await record(skippedId)).toMatchObject({
      status: 'skipped',
      error: 'no_address',
      mobile: null,
    })
    expect(await notify.due(100)).not.toContain(skippedId)
    const pendingId = await notify.write({
      ...draft,
      recipient: { ...draft.recipient, mobile: '13800138000' },
    })
    expect(await notify.due(100)).toContain(pendingId)
    const client = await clients.for(channelId)
    const send = vi.spyOn(client, 'send')
    const forClient = vi.spyOn(clients, 'for').mockResolvedValue(client)
    try {
      await Promise.all([notify.deliver(pendingId), notify.deliver(pendingId)])
      expect(send).toHaveBeenCalledTimes(1)
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          templateId: 'TPL-RECEIPT',
          paramOrder: ['code', 'name'],
        }),
      )
      expect(await record(pendingId)).toMatchObject({ status: 'sent', attempts: 1 })
      await ds.query('UPDATE msg_sms_record SET status = ?, attempts = ? WHERE id = ?', [
        'failed',
        3,
        pendingId,
      ])
      expect(await notify.due(100)).not.toContain(pendingId)
    } finally {
      forClient.mockRestore()
      send.mockRestore()
    }
  })

  it('snapshots the first enabled channel when a template has no channel', async () => {
    const tpl = await createTemplate({ channelId: null })
    const template = await ds.getRepository(SmsTemplate).findOneByOrFail({ id: tpl.id })
    const expected = (
      await ds.query(
        'SELECT id FROM msg_sms_channel WHERE enabled = 1 AND deleted_at IS NULL ORDER BY id LIMIT 1',
      )
    )[0].id
    const id = await notify.write({
      template,
      recipient: {
        userId: null,
        email: null,
        mobile: '13800138000',
        locale: 'en-US',
        timezone: 'UTC',
      },
      params: {},
      values: {},
    })
    expect((await record(id)).channel_id).toBe(expected)
  })

  it('uses the stored parameter order and fixed delivery failure codes', async () => {
    const tpl = await createTemplate()
    await ds.query('UPDATE msg_sms_template SET param_names = ? WHERE id = ?', [
      JSON.stringify(['name', 'code']),
      tpl.id,
    ])
    const template = await ds.getRepository(SmsTemplate).findOneByOrFail({ id: tpl.id })
    const draft = {
      template,
      recipient: {
        userId: null,
        email: null,
        mobile: '13800138000',
        locale: 'en-US' as const,
        timezone: 'UTC',
      },
      params: {},
      values: { code: '42', name: 'Ada' },
    }
    const sentId = await notify.write(draft)
    const client = await clients.for(channelId)
    const send = vi.spyOn(client, 'send')
    const forClient = vi.spyOn(clients, 'for').mockResolvedValue(client)
    try {
      await notify.deliver(sentId)
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ paramOrder: ['name', 'code'] }))
      const failedId = await notify.write(draft)
      send.mockRejectedValueOnce(new Error('provider PRIVATE message'))
      await notify.deliver(failedId)
      expect(await record(failedId)).toMatchObject({ status: 'failed', error: 'send_failed' })
      const noChannelId = await notify.write(draft)
      await ds.query('UPDATE msg_sms_channel SET enabled = 0 WHERE id = ?', [channelId])
      await notify.deliver(noChannelId)
      expect(await record(noChannelId)).toMatchObject({ status: 'failed', error: 'no_channel' })
    } finally {
      await ds.query('UPDATE msg_sms_channel SET enabled = 1 WHERE id = ?', [channelId])
      forClient.mockRestore()
      send.mockRestore()
    }
  })

  it('accepts delivered and failed debug receipts with the supplied time', async () => {
    const sent = await testSend(templateId).expect(200)
    const id = sent.body.data.recordId as number
    const providerMsgId = String((await record(id)).provider_msg_id)
    expect(
      (
        await receipt(channelId, secret, [
          { providerMsgId, status: 'delivered', at: '2026-09-28T01:02:03.000Z' },
        ]).expect(200)
      ).body,
    ).toEqual({ code: 0, msg: 'ok' })
    expect(await record(id)).toMatchObject({
      receipt_status: 'delivered',
      receipt_at: new Date('2026-09-28T01:02:03.000Z'),
    })
    await receipt(channelId, secret, [{ providerMsgId, status: 'failed' }]).expect(200)
    expect((await record(id)).receipt_status).toBe('failed')
  })

  it('returns the same 404 for every unavailable credential without changing the record', async () => {
    const sent = await testSend(templateId).expect(200)
    const id = sent.body.data.recordId as number
    const providerMsgId = String((await record(id)).provider_msg_id)
    const other = (await add(body({ receiptSecret: 'another-secret' }))).id
    const disabled = (await add(body({ receiptSecret: 'disabled-secret', enabled: false }))).id
    const noSecret = (await add(body())).id
    const payload = [{ providerMsgId, status: 'delivered' }]
    const answers = await Promise.all([
      receipt(channelId, 'wrong', payload),
      receipt(channelId, null, payload),
      receipt(channelId, 'another-secret', payload),
      receipt(999999, secret, payload),
      receipt(disabled, 'disabled-secret', payload),
      receipt(noSecret, secret, payload),
    ])
    for (const answer of answers) expect(answer.status).toBe(404)
    const shapes = answers.map(({ body }) => ({ code: body.code, msg: body.msg, data: body.data }))
    expect(shapes.every((shape) => JSON.stringify(shape) === JSON.stringify(shapes[0]))).toBe(true)
    expect((await record(id)).receipt_status).toBeNull()
    expect(other).toBeGreaterThan(0)
  })

  it('updates only this URL channel even when provider ids collide', async () => {
    const other = (await add(body({ receiptSecret: 'scope-secret' }))).id
    const providerMsgId = `collision-${++seq}`
    const rows = await Promise.all(
      [channelId, other].map((id) =>
        ds.query(
          'INSERT INTO msg_sms_record (channel_id, template_code, body, provider_msg_id, status) VALUES (?, ?, ?, ?, ?)',
          [id, 'receipt-scope', 'plain', providerMsgId, 'sent'],
        ),
      ),
    )
    expect(rows).toHaveLength(2)
    await receipt(channelId, secret, [{ providerMsgId, status: 'delivered' }]).expect(200)
    const found = await ds.query(
      'SELECT channel_id, receipt_status FROM msg_sms_record WHERE provider_msg_id = ? ORDER BY channel_id',
      [providerMsgId],
    )
    expect(
      found.find((r: { channel_id: number }) => r.channel_id === channelId).receipt_status,
    ).toBe('delivered')
    expect(
      found.find((r: { channel_id: number }) => r.channel_id === other).receipt_status,
    ).toBeNull()
  })

  it('handles both provider formats and acknowledges each provider', async () => {
    const ali = (
      await add(
        body({
          driver: 'aliyun',
          signName: 'sign',
          apiKey: 'id',
          apiSecret: 'secret',
          receiptSecret: 'ali-receipt',
        }),
      )
    ).id
    const ten = (
      await add(
        body({
          driver: 'tencent',
          signName: 'sign',
          appId: 'app',
          apiKey: 'id',
          apiSecret: 'secret',
          receiptSecret: 'ten-receipt',
        }),
      )
    ).id
    for (const [id, providerMsgId] of [
      [ali, 'ali-biz'],
      [ten, 'ten-sid'],
    ] as const)
      await ds.query(
        'INSERT INTO msg_sms_record (channel_id, template_code, body, provider_msg_id, status) VALUES (?, ?, ?, ?, ?)',
        [id, 'receipt-provider', 'plain', providerMsgId, 'sent'],
      )
    expect(
      (
        await receipt(ali, 'ali-receipt', [
          { biz_id: 'ali-biz', success: true, report_time: '2026-09-28 09:02:03' },
        ]).expect(200)
      ).body,
    ).toEqual({ code: 0, msg: 'OK' })
    expect(
      (
        await receipt(ten, 'ten-receipt', [
          { sid: 'ten-sid', report_status: 'FAIL', user_receive_time: '2026-09-28 09:02:03' },
        ]).expect(200)
      ).body,
    ).toEqual({ result: 0, errmsg: 'OK' })
    const rows = await ds.query(
      'SELECT channel_id, receipt_status, receipt_at FROM msg_sms_record WHERE template_code = ? ORDER BY channel_id',
      ['receipt-provider'],
    )
    expect(rows.find((r: { channel_id: number }) => r.channel_id === ali)).toMatchObject({
      receipt_status: 'delivered',
      receipt_at: new Date('2026-09-28T01:02:03Z'),
    })
    expect(rows.find((r: { channel_id: number }) => r.channel_id === ten)).toMatchObject({
      receipt_status: 'failed',
      receipt_at: new Date('2026-09-28T01:02:03Z'),
    })
  })

  it('rejects malformed and oversized batches, and masks the token in HTTP traces', async () => {
    const sent = await testSend(templateId).expect(200)
    const id = sent.body.data.recordId as number
    const providerMsgId = String((await record(id)).provider_msg_id)
    await receipt(channelId, secret, [{ providerMsgId, status: 'unknown' }]).expect(400)
    await receipt(
      channelId,
      secret,
      Array.from({ length: 101 }, () => ({ providerMsgId, status: 'delivered' })),
    ).expect(400)
    expect((await record(id)).receipt_status).toBeNull()
    const traces = await ds.query(
      'SELECT url, query, body FROM aud_http_trace WHERE url = ? AND method = ?',
      [`/api/messaging/sms/receipt/${channelId}`, 'POST'],
    )
    expect(traces.length).toBeGreaterThan(0)
    expect(JSON.stringify(traces)).not.toContain(secret)
    const actions = await ds.query('SELECT url, params FROM aud_action_log WHERE url = ?', [
      `/api/messaging/sms/receipt/${channelId}`,
    ])
    expect(actions).toEqual([])
  })

  it('requires modify for test send and validates mobile and template id', async () => {
    expect((await testSend(templateId, reader)).status).toBe(403)
    expect((await testSend(templateId, admin, { mobile: 'bad', params: {} })).status).toBe(400)
    expect((await testSend(999999)).status).toBe(404)
  })
})

describe('otp', () => {
  const mobiles = ['13800138101', '13800138102', '13800138103']
  const concurrent = Array.from(
    { length: 10 },
    (_, i) => `138001381${String(i + 4).padStart(2, '0')}`,
  )
  const unknown = '13800138999'
  const unknowns = [unknown, ...Array.from({ length: 4 }, (_, i) => `1380013899${i + 1}`)]
  const ip = '127.0.0.1'
  const url = '/api/auth/sms/code'
  const codeOf = (log: ReturnType<typeof vi.spyOn>) =>
    String(log.mock.calls.at(-1)?.[0]).match(/\b\d{6}\b/)?.[0] ?? ''
  let otp: OtpService
  let params: ParamService
  let otpUsers: number[]
  let otpChannelId: number
  let templateChannels: Array<{ id: number; channel_id: number | null }>
  let originalCaptcha: string | null
  const idle = () => app.get(NotifyDispatcher).idle()

  const setParam = async (key: string, value: string) => {
    await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [value, key])
    await params.invalidate(key)
  }
  const clearLimits = async () => {
    for await (const keys of redis.scanIterator({ MATCH: keyPattern('smsLimit'), COUNT: 100 }))
      if (keys.length) await redis.unlink(keys)
  }
  const send = (mobile: string, scene = 'signin', captchaTicket?: string) =>
    request(app.getHttpServer()).post(url).send({ mobile, scene, captchaTicket })
  const rows = (mobile: string) =>
    ds.query<
      Array<{
        id: number
        code: string
        attempts: number
        daily_seq: number
        request_ip: string
        consumed_at: Date | null
      }>
    >(
      'SELECT id, code, attempts, daily_seq, request_ip, consumed_at FROM msg_sms_otp WHERE mobile = ? ORDER BY id DESC',
      [mobile],
    )
  const records = (mobile: string) =>
    ds.query<
      Array<{
        id: number
        channel_id: number | null
        body: string
        params: { values: { code: string } }
        status: string
        attempts: number
      }>
    >(
      'SELECT id, channel_id, body, params, status, attempts FROM msg_sms_record WHERE mobile = ? AND template_code = ? ORDER BY id DESC',
      [mobile, 'auth.sms_code'],
    )

  beforeAll(async () => {
    otp = app.get(OtpService)
    params = app.get(ParamService)
    originalCaptcha = await params.get('captcha.mode')
    await upsert(
      ds.manager,
      'cfg_param',
      { param_key: 'captcha.mode' },
      {
        name: 'Captcha mode',
        name_i18n: { 'zh-CN': '验证码模式', 'en-US': 'Captcha mode' },
        group_code: 'captcha',
        is_builtin: 1,
        is_public: 0,
      },
      { param_value: 'off' },
    )
    await add(body())
    otpChannelId = (await add(body())).id
    templateChannels = await ds.query(
      'SELECT id, channel_id FROM msg_sms_template WHERE code = ?',
      ['auth.sms_code'],
    )
    await ds.query("UPDATE msg_sms_template SET channel_id = ? WHERE code = 'auth.sms_code'", [
      otpChannelId,
    ])
    otpUsers = await Promise.all(
      [...mobiles, ...concurrent].map((mobile, i) =>
        insertRow(ds.manager, 'iam_user', {
          username: `${PREFIX}otp-${i}`,
          display_name: `OTP ${i}`,
          password_hash: 'not-used',
          mobile,
          password_changed_at: new Date(),
        }),
      ),
    )
  })

  beforeEach(async () => {
    await idle()
    await clearLimits()
    await ds.query('DELETE FROM msg_sms_otp WHERE mobile IN (?)', [
      [...mobiles, ...concurrent, ...unknowns],
    ])
    await ds.query('DELETE FROM msg_sms_record WHERE template_code = ? AND mobile IN (?)', [
      'auth.sms_code',
      [...mobiles, ...concurrent, ...unknowns],
    ])
    for (const [key, value] of [
      ['captcha.mode', 'off'],
      ['sms.otp.cooldown_sec', '60'],
      ['sms.otp.mobile_daily_max', '10'],
      ['sms.otp.ip_daily_max', '20'],
      ['sms.otp.user_daily_max', '5'],
      ['sms.otp.global_daily_max', '1000'],
    ])
      await setParam(key, value)
  })

  afterAll(async () => {
    await idle()
    for (const template of templateChannels)
      await ds.query('UPDATE msg_sms_template SET channel_id = ? WHERE id = ?', [
        template.channel_id,
        template.id,
      ])
    await ds.query('DELETE FROM msg_sms_otp WHERE mobile IN (?)', [
      [...mobiles, ...concurrent, ...unknowns],
    ])
    await ds.query('DELETE FROM msg_sms_record WHERE template_code = ? AND mobile IN (?)', [
      'auth.sms_code',
      [...mobiles, ...concurrent, ...unknowns],
    ])
    if (otpUsers?.length) await ds.query('DELETE FROM iam_user WHERE id IN (?)', [otpUsers])
    if (originalCaptcha === null)
      await ds.query('DELETE FROM cfg_param WHERE param_key = ?', ['captcha.mode'])
    else await setParam('captcha.mode', originalCaptcha)
    await params.invalidate('captcha.mode')
    await clearLimits()
  })

  it('sends the real code while storing only a masked, claimed record', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    try {
      const answer = await send(mobiles[0]!).set('Accept-Language', 'en-US').expect(200)
      expect(answer.body.data).toEqual({ cooldownSec: 60 })
      await idle()
      expect((await records(mobiles[0]!))[0]?.status).toBe('sent')
      const [row] = await rows(mobiles[0]!)
      const [record] = await records(mobiles[0]!)
      expect(row).toMatchObject({
        code: expect.stringMatching(/^\d{6}$/),
        daily_seq: 1,
        request_ip: ip,
      })
      expect(record).toMatchObject({
        channel_id: otpChannelId,
        status: 'sent',
        attempts: 3,
        params: { templateId: expect.any(Number), values: { code: '******' } },
      })
      expect(record?.body).toContain('******')
      expect(record?.body).toContain('Your verification code')
      expect(JSON.stringify(record)).not.toContain(row!.code)
      expect(codeOf(log)).toBe(row!.code)
    } finally {
      log.mockRestore()
    }
  })

  it('ignores case and accent lookalikes when choosing the OTP template for en-US', async () => {
    const [canonicalEn] = await ds.query<Array<{ id: number }>>(
      "SELECT id FROM msg_sms_template WHERE code COLLATE utf8mb4_bin = 'auth.sms_code' AND locale = 'en-US'",
    )
    const otherChannelId = (await add(body())).id
    await ds.query('UPDATE msg_sms_template SET code = ? WHERE id = ?', [
      'auth.sms_code.e2e-held',
      canonicalEn!.id,
    ])
    let lookalikeId: number | undefined
    const client = vi.spyOn(clients, 'for')
    try {
      for (const [index, code] of ['AUTH.SMS_CODE', 'áuth.sms_code'].entries()) {
        lookalikeId =
          index === 0
            ? await insertRow(ds.manager, 'msg_sms_template', {
                code,
                locale: 'en-US',
                channel_id: otherChannelId,
                name: `${PREFIX}lookalike-${index}`,
                purpose: 'otp',
                body: 'intercept {code}',
              })
            : ((
                await request(app.getHttpServer())
                  .post('/api/messaging/sms-templates')
                  .set(bearer(reader))
                  .send({
                    code,
                    locale: 'en-US',
                    channelId: otherChannelId,
                    name: `${PREFIX}lookalike-${index}`,
                    purpose: 'otp',
                    body: 'intercept {code}',
                  })
                  .expect(201)
              ).body.data.id as number)
        const mobile = mobiles[index]!
        await send(mobile)
          .query({ lang: 'en-US' })
          .set('X-Forwarded-For', '198.51.100.88')
          .expect(200)
        await idle()
        const [record] = await ds.query<Array<{ template_code: string; channel_id: number }>>(
          'SELECT template_code, channel_id FROM msg_sms_record WHERE mobile = ? ORDER BY id DESC LIMIT 1',
          [mobile],
        )
        expect(await rows(mobile)).toHaveLength(1)
        expect(record).toMatchObject({ template_code: 'auth.sms_code', channel_id: otpChannelId })
        expect(client).not.toHaveBeenCalledWith(otherChannelId)
        await ds.query('DELETE FROM msg_sms_template WHERE id = ?', [lookalikeId])
        lookalikeId = undefined
      }
      expect(await otp.smsConfigured()).toBe(true)
    } finally {
      if (lookalikeId) await ds.query('DELETE FROM msg_sms_template WHERE id = ?', [lookalikeId])
      await ds.query('UPDATE msg_sms_template SET code = ? WHERE id = ?', [
        'auth.sms_code',
        canonicalEn!.id,
      ])
      client.mockRestore()
    }
  })

  it('requires an explicit enabled OTP channel and never falls back to the lower enabled channel', async () => {
    const mobile = mobiles[0]!
    const client = vi.spyOn(clients, 'for')
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    try {
      await ds.query("UPDATE msg_sms_template SET channel_id = NULL WHERE code = 'auth.sms_code'")
      expect(await otp.smsConfigured()).toBe(false)
      expect(
        (await send(mobile).set('X-Forwarded-For', '198.51.100.77').expect(200)).body.data,
      ).toEqual({ cooldownSec: 60 })
      await idle()
      expect(await rows(mobile)).toEqual([])
      expect(await records(mobile)).toEqual([])
      expect(client).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalled()

      await redis.unlink(redisKey('smsLimit', 'cooldown', mobile))
      await ds.query("UPDATE msg_sms_template SET channel_id = ? WHERE code = 'auth.sms_code'", [
        otpChannelId,
      ])
      expect(await otp.smsConfigured()).toBe(true)
      expect(await otp.issue({ mobile, scene: 'signin' }, ip)).toEqual({ cooldownSec: 60 })
      await idle()
      expect((await records(mobile))[0]?.channel_id).toBe(otpChannelId)
      expect(client).toHaveBeenCalledWith(otpChannelId)
    } finally {
      await ds.query("UPDATE msg_sms_template SET channel_id = ? WHERE code = 'auth.sms_code'", [
        otpChannelId,
      ])
      client.mockRestore()
      warn.mockRestore()
    }
  })

  it('enforces cooldown and voids the previous code after a second issue', async () => {
    const mobile = mobiles[1]!
    await send(mobile).expect(200)
    await idle()
    expect((await send(mobile).expect(429)).body.code).toBe(Err.SMS_TOO_FREQUENT.code)
    // the same number written with dashes shares the cooldown (limits count digits only)
    const dashed = `${mobile.slice(0, 3)}-${mobile.slice(3, 7)}-${mobile.slice(7)}`
    await expect(otp.issue({ mobile: dashed, scene: 'signin' }, ip)).rejects.toMatchObject({
      err: Err.SMS_TOO_FREQUENT,
    })
    expect(
      await redis.get(
        redisKey('smsLimit', 'mobile', new Date().toISOString().slice(0, 10), mobile),
      ),
    ).toBe('1')
    await redis.unlink(redisKey('smsLimit', 'cooldown', mobile))
    await otp.issue({ mobile, scene: 'signin' }, ip)
    await idle()
    const [newest, older] = await rows(mobile)
    expect(newest?.daily_seq).toBe(2)
    expect(older?.consumed_at).not.toBeNull()
    expect(await otp.consume({ mobile, scene: 'signin', code: older!.code }, ip)).toBe(false)
  })

  it('keeps the newest code when an older delivery commits last', async () => {
    const mobile = mobiles[1]!
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    // hold the first delivery in its transaction (before it voids and writes) until the second commits
    const target = otp as unknown as { resolveSender: (...args: unknown[]) => Promise<unknown> }
    const resolveSender = target.resolveSender.bind(otp)
    const gate = vi.spyOn(target, 'resolveSender').mockImplementationOnce(async (...args) => {
      await held
      return resolveSender(...args)
    })
    try {
      await otp.issue({ mobile, scene: 'signin' }, ip)
      await vi.waitFor(() => expect(gate).toHaveBeenCalledTimes(1), { timeout: 5000 })
      await redis.unlink(redisKey('smsLimit', 'cooldown', mobile))
      await otp.issue({ mobile, scene: 'signin' }, ip)
      await vi.waitFor(async () => expect(await rows(mobile)).toHaveLength(1), { timeout: 5000 })
      release()
      await idle()
      const [late, newest] = await rows(mobile)
      expect([late?.daily_seq, newest?.daily_seq]).toEqual([1, 2]) // the older code got the higher id
      expect(await otp.consume({ mobile, scene: 'signin', code: newest!.code }, ip)).toBe(true)
      expect(await otp.consume({ mobile, scene: 'signin', code: late!.code }, ip)).toBe(false)
    } finally {
      release()
      gate.mockRestore()
    }
  })

  it('checks mobile, IP and global daily caps atomically', async () => {
    const day = new Date().toISOString().slice(0, 10)
    await setParam('sms.otp.mobile_daily_max', '1')
    await otp.issue({ mobile: mobiles[0]!, scene: 'signin' }, ip)
    await idle()
    await redis.unlink(redisKey('smsLimit', 'cooldown', mobiles[0]!))
    await expect(otp.issue({ mobile: mobiles[0]!, scene: 'signin' }, ip)).rejects.toMatchObject({
      err: Err.SMS_TOO_FREQUENT,
    })
    expect(await redis.get(redisKey('smsLimit', 'ip', day, ip))).toBe('1')
    await setParam('sms.otp.mobile_daily_max', '10')
    await setParam('sms.otp.ip_daily_max', '2')
    await otp.issue({ mobile: mobiles[1]!, scene: 'signin' }, ip)
    await idle()
    await expect(otp.issue({ mobile: mobiles[2]!, scene: 'signin' }, ip)).rejects.toMatchObject({
      err: Err.SMS_TOO_FREQUENT,
    })
    expect(await redis.get(redisKey('smsLimit', 'global', day))).toBe('2')
    await clearLimits()
    await setParam('sms.otp.ip_daily_max', '20')
    await setParam('sms.otp.global_daily_max', '1')
    await otp.issue({ mobile: mobiles[0]!, scene: 'signin' }, ip)
    await idle()
    await expect(otp.issue({ mobile: mobiles[1]!, scene: 'signin' }, ip)).rejects.toMatchObject({
      err: Err.SMS_TOO_FREQUENT,
    })
    expect(await redis.get(redisKey('smsLimit', 'mobile', day, mobiles[1]!))).toBeNull()
  })

  it('shares request IP limits across rotating IPv6 addresses in one /64', async () => {
    await setParam('sms.otp.ip_daily_max', '2')
    await otp.issue({ mobile: unknowns[0]!, scene: 'signin' }, '2001:db8:a:b::1')
    await otp.issue({ mobile: unknowns[1]!, scene: 'signin' }, '2001:db8:a:b::2')
    await expect(
      otp.issue({ mobile: unknowns[2]!, scene: 'signin' }, '2001:db8:a:b:ffff::3'),
    ).rejects.toMatchObject({ err: Err.SMS_TOO_FREQUENT })
    expect(await redis.exists(redisKey('smsLimit', 'cooldown', unknowns[2]!))).toBe(0)
    await expect(
      otp.issue({ mobile: unknowns[3]!, scene: 'signin' }, '2001:db8:a:c::1'),
    ).resolves.toEqual({ cooldownSec: 60 })
    await idle()
  })

  it('counts only sent codes toward the global daily cap', async () => {
    const globalKey = redisKey('smsLimit', 'global', new Date().toISOString().slice(0, 10))
    await setParam('sms.otp.global_daily_max', '2')
    await setParam('sms.otp.ip_daily_max', '100')
    const answers = []
    for (const mobile of unknowns)
      answers.push((await send(mobile).set('X-Forwarded-For', '198.51.100.40').expect(200)).body)
    await idle()
    expect(answers).toEqual(Array(unknowns.length).fill(answers[0]))
    expect(await redis.get(globalKey)).toBeNull()
    for (const mobile of unknowns) {
      expect(await rows(mobile)).toEqual([])
      expect(await records(mobile)).toEqual([])
    }
    for (const [index, mobile] of mobiles.slice(0, 2).entries()) {
      const response = await send(mobile!).set('X-Forwarded-For', '198.51.100.40').expect(200)
      expect(response.body).toEqual(answers[0])
      await idle()
      expect((await records(mobile!))[0]?.status).toBe('sent')
      expect(await redis.get(globalKey)).toBe(String(index + 1))
    }
    const refused = await send(mobiles[2]!).set('X-Forwarded-For', '198.51.100.40').expect(429)
    expect(refused.body.code).toBe(Err.SMS_TOO_FREQUENT.code)
    await redis.unlink(redisKey('smsLimit', 'cooldown', unknowns[0]!))
    expect(
      (await send(unknowns[0]!).set('X-Forwarded-For', '198.51.100.40').expect(429)).body.code,
    ).toBe(Err.SMS_TOO_FREQUENT.code)
    await idle()
    expect(await rows(mobiles[2]!)).toEqual([])
    expect(await records(mobiles[2]!)).toEqual([])
  })

  it('drops delivery if the global cap fills after the answer', async () => {
    const mobile = mobiles[0]!
    const lock = ds.createQueryRunner()
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    try {
      await setParam('sms.otp.global_daily_max', '1')
      await lock.connect()
      await lock.query('LOCK TABLES iam_user WRITE')
      try {
        expect(
          (await send(mobile).set('X-Forwarded-For', '198.51.100.41').expect(200)).body.data,
        ).toEqual({ cooldownSec: 60 })
        await redis.set(redisKey('smsLimit', 'global', new Date().toISOString().slice(0, 10)), '1')
      } finally {
        await lock.query('UNLOCK TABLES')
        await lock.release()
      }
      await idle()
      expect(await rows(mobile)).toEqual([])
      expect(await records(mobile)).toEqual([])
      expect(warn).toHaveBeenCalledWith('SMS OTP global daily limit reached before delivery')
    } finally {
      warn.mockRestore()
    }
  })

  it('answers ineligible mobiles identically without a code, record or debug send', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    try {
      const accepted = (await send(mobiles[0]!).expect(200)).body.data
      await idle()
      for (const [mobile, scene] of [
        [unknown, 'signin'],
        [unknown, 'reset_password'],
      ]) {
        if (mobile === unknown && scene === 'reset_password')
          await redis.unlink(redisKey('smsLimit', 'cooldown', unknown))
        const before = (await records(mobile!)).length
        const answer = await otp.issue({ mobile: mobile!, scene: scene as 'signin' }, ip)
        await idle()
        expect(answer).toEqual(accepted)
        expect((await records(mobile!)).length).toBe(before)
        expect(mobile === unknown ? await rows(mobile!) : []).toEqual([])
      }
      expect(log.mock.calls.filter(([line]) => String(line).includes(unknown))).toEqual([])
      await expect(otp.issue({ mobile: unknown, scene: 'signin' }, ip)).rejects.toMatchObject({
        err: Err.SMS_TOO_FREQUENT,
      })
    } finally {
      log.mockRestore()
    }
  })

  it('rejects anonymous bind_mobile before captcha and SMS limits', async () => {
    await setParam('captcha.mode', 'slider')
    try {
      const res = await send(unknown, 'bind_mobile')
        .set('X-Forwarded-For', '198.51.100.20')
        .expect(400)
      expect(res.body.code).toBe(Err.VALIDATION_FAILED.code)
      expect(await redis.exists(redisKey('smsLimit', 'cooldown', unknown))).toBe(0)
      await idle()
      expect(await rows(unknown)).toEqual([])
      expect(await records(unknown)).toEqual([])
    } finally {
      await setParam('captcha.mode', 'off')
    }
  })

  it('issues concurrent codes to empty mobile ranges without deadlocks', async () => {
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    try {
      expect(
        await Promise.all(concurrent.map((mobile) => otp.issue({ mobile, scene: 'signin' }, ip))),
      ).toEqual(concurrent.map(() => ({ cooldownSec: 60 })))
      await idle()
      expect(errors.mock.calls).toEqual([])
      for (const mobile of concurrent) {
        expect((await rows(mobile)).filter((row) => row.consumed_at === null)).toHaveLength(1)
        expect(await records(mobile)).toHaveLength(1)
      }
    } finally {
      errors.mockRestore()
    }
  })

  it('answers registered and unregistered numbers while OTP rows are locked', async () => {
    const lock = ds.createQueryRunner()
    await lock.connect()
    await lock.query('LOCK TABLES msg_sms_otp WRITE')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const answers = await Promise.race([
        Promise.all([
          send(mobiles[0]!).set('X-Forwarded-For', '198.51.100.21'),
          send(unknown).set('X-Forwarded-For', '198.51.100.21'),
        ]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('SMS response waited for OTP table')), 2000)
        }),
      ])
      expect(answers.map((res) => res.status)).toEqual([200, 200])
      expect(answers[0]!.body).toEqual(answers[1]!.body)
    } finally {
      clearTimeout(timer)
      await lock.query('UNLOCK TABLES')
      await lock.release()
    }
    await idle()
    expect(await rows(mobiles[0]!)).toHaveLength(1)
    expect(await records(mobiles[0]!)).toHaveLength(1)
    expect(await rows(unknown)).toEqual([])
    expect(await records(unknown)).toEqual([])
  })

  it('treats a disabled account as unavailable for sign-in', async () => {
    const mobile = mobiles[2]!
    await ds.query('UPDATE iam_user SET enabled = 0 WHERE id = ?', [otpUsers[2]])
    try {
      expect(await otp.issue({ mobile, scene: 'signin' }, ip)).toEqual({ cooldownSec: 60 })
      await idle()
      expect(await rows(mobile)).toEqual([])
      expect(await records(mobile)).toEqual([])
    } finally {
      await ds.query('UPDATE iam_user SET enabled = 1 WHERE id = ?', [otpUsers[2]])
    }
  })

  it('a deleted account gets no code; revoking it (after the soft delete) still voids its number’s codes', async () => {
    const mobile = mobiles[2]!
    await otp.issue({ mobile, scene: 'signin' }, ip)
    await idle()
    expect((await rows(mobile)).map((r) => r.consumed_at)).toEqual([null])
    await ds.query('UPDATE iam_user SET deleted_at = NOW(3) WHERE id = ?', [otpUsers[2]])
    try {
      // UserService.remove soft-deletes, then revokes: the number may go to another user at once
      await app.get(SessionRevoker).revokeUser(otpUsers[2]!, 'user_removed')
      expect((await rows(mobile))[0]!.consumed_at).not.toBeNull()
      await clearLimits()
      expect(await otp.issue({ mobile, scene: 'signin' }, ip)).toEqual({ cooldownSec: 60 })
      await idle()
      expect(await rows(mobile)).toHaveLength(1)
    } finally {
      await ds.query('UPDATE iam_user SET deleted_at = NULL WHERE id = ?', [otpUsers[2]])
    }
  })

  it('requires a captcha ticket before counting, with off and missing-mode behavior', async () => {
    const mobile = mobiles[2]!
    await setParam('captcha.mode', 'slider')
    expect((await send(mobile).expect(403)).body.code).toBe(Err.AUTH_CAPTCHA_REQUIRED.code)
    expect(await redis.exists(redisKey('smsLimit', 'cooldown', mobile))).toBe(0)
    expect(await rows(mobile)).toEqual([])
    // the real verifier: another scene's ticket is refused, an sms_send one passes once
    // (service calls where possible: the route's per-IP rate limit is shared by this describe)
    const tickets = app.get(CaptchaTicketVerifier)
    const refused = { err: Err.AUTH_CAPTCHA_REQUIRED }
    const signinTicket = await tickets.issue('signin', ip)
    await expect(
      otp.issue({ mobile, scene: 'signin', captchaTicket: signinTicket }, ip),
    ).rejects.toMatchObject(refused)
    const ticket = await tickets.issue('sms_send', ip)
    await send(mobile, 'signin', ticket).expect(200)
    await clearLimits()
    await expect(
      otp.issue({ mobile, scene: 'signin', captchaTicket: ticket }, ip),
    ).rejects.toMatchObject(refused)
    await setParam('captcha.mode', 'unexpected')
    await expect(otp.issue({ mobile: unknown, scene: 'signin' }, ip)).rejects.toMatchObject({
      err: Err.AUTH_CAPTCHA_REQUIRED,
    })
    expect(await redis.exists(redisKey('smsLimit', 'cooldown', unknown))).toBe(0)
    await ds.query('DELETE FROM cfg_param WHERE param_key = ?', ['captcha.mode'])
    await params.invalidate('captcha.mode')
    expect((await send(unknown).expect(403)).body.code).toBe(Err.AUTH_CAPTCHA_REQUIRED.code)
    expect(await redis.exists(redisKey('smsLimit', 'cooldown', unknown))).toBe(0)
    await upsert(
      ds.manager,
      'cfg_param',
      { param_key: 'captcha.mode' },
      {},
      {
        param_value: 'off',
        name: 'Captcha mode',
        name_i18n: { 'zh-CN': '验证码模式', 'en-US': 'Captcha mode' },
        group_code: 'captcha',
        is_builtin: 1,
      },
    )
    await params.invalidate('captcha.mode')
    await send(unknown).expect(200)
  })

  it('silently accepts unavailable OTP templates and channels without creating codes', async () => {
    const mobile = mobiles[0]!
    const enabled = await ds.query<Array<{ id: number }>>(
      'SELECT id FROM msg_sms_channel WHERE enabled = 1',
    )
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    try {
      await ds.query('UPDATE msg_sms_template SET enabled = 0 WHERE code = ?', ['auth.sms_code'])
      expect(await otp.issue({ mobile, scene: 'signin' }, ip)).toEqual({ cooldownSec: 60 })
      await idle()
      expect(await rows(mobile)).toEqual([])
      expect(await records(mobile)).toEqual([])
      await redis.unlink(redisKey('smsLimit', 'cooldown', mobile))
      await ds.query('UPDATE msg_sms_template SET enabled = 1 WHERE code = ?', ['auth.sms_code'])
      await ds.query('UPDATE msg_sms_channel SET enabled = 0')
      expect(await otp.issue({ mobile, scene: 'signin' }, ip)).toEqual({ cooldownSec: 60 })
      await idle()
      expect(await rows(mobile)).toEqual([])
      expect(await records(mobile)).toEqual([])
      expect(warn).toHaveBeenCalled()
    } finally {
      await ds.query('UPDATE msg_sms_template SET enabled = 1 WHERE code = ?', ['auth.sms_code'])
      for (const { id } of enabled)
        await ds.query('UPDATE msg_sms_channel SET enabled = 1 WHERE id = ?', [id])
      warn.mockRestore()
    }
  })

  it('returns before provider delivery and leaves a failed masked record outside retries', async () => {
    const mobile = mobiles[0]!
    let rejectSend!: (error: Error) => void
    const delivery = new Promise<never>((_resolve, reject) => {
      rejectSend = reject
    })
    const client = vi.spyOn(clients, 'for').mockResolvedValue({
      send: () => delivery,
      test: async () => true,
    })
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    try {
      expect(await otp.issue({ mobile, scene: 'signin' }, ip)).toEqual({ cooldownSec: 60 })
      await vi.waitFor(() => expect(client).toHaveBeenCalled(), { timeout: 5000 })
      rejectSend(new Error('provider-private-error'))
      await idle()
      expect((await records(mobile))[0]?.status).toBe('failed')
      const [record] = await records(mobile)
      expect(record?.body).toContain('******')
      expect(JSON.stringify(record)).not.toContain((await rows(mobile))[0]!.code)
      expect(await (app.get(NotifyChannels).get('sms') as SmsNotifyChannel).due(100)).not.toContain(
        record?.id,
      )
    } finally {
      client.mockRestore()
      warn.mockRestore()
    }
  })

  it('consumes once, expires after five minutes, voids after five mistakes and limits verification', async () => {
    const mobile = mobiles[0]!
    await otp.issue({ mobile, scene: 'signin' }, ip)
    await idle()
    let [row] = await rows(mobile)
    expect(await otp.consume({ mobile, scene: 'reset_password', code: row!.code }, ip)).toBe(false)
    expect(await otp.consume({ mobile, scene: 'signin', code: row!.code }, ip)).toBe(true)
    expect(await otp.consume({ mobile, scene: 'signin', code: row!.code }, ip)).toBe(false)
    await redis.unlink(redisKey('smsLimit', 'cooldown', mobile))
    await otp.issue({ mobile, scene: 'signin' }, ip)
    await idle()
    ;[row] = await rows(mobile)
    for (let i = 0; i < 5; i++)
      expect(await otp.consume({ mobile, scene: 'signin', code: 'xxxxxx' }, ip)).toBe(false)
    expect((await rows(mobile))[0]).toMatchObject({ attempts: 5, consumed_at: expect.any(Date) })
    expect(await otp.consume({ mobile, scene: 'signin', code: row!.code }, ip)).toBe(false)
    await redis.unlink(redisKey('smsLimit', 'cooldown', mobile))
    await otp.issue({ mobile, scene: 'signin' }, ip)
    await idle()
    ;[row] = await rows(mobile)
    await ds.query(
      'UPDATE msg_sms_otp SET created_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 6 MINUTE) WHERE id = ?',
      [row!.id],
    )
    expect(await otp.consume({ mobile, scene: 'signin', code: row!.code }, ip)).toBe(false)
    expect(await otp.consume({ mobile, scene: 'signin', code: row!.code }, ip)).toBe(false)
    await expect(
      otp.consume({ mobile, scene: 'signin', code: row!.code }, ip),
    ).rejects.toMatchObject({ err: Err.SMS_TOO_FREQUENT })
  })

  it('limits verification by IP even across mobiles and scenes', async () => {
    const attempts = []
    for (let i = 0; i < 30; i++)
      attempts.push(
        await otp.consume({ mobile: mobiles[i % 3]!, scene: 'signin', code: '000000' }, ip),
      )
    expect(attempts).toEqual(Array(30).fill(false))
    await expect(
      otp.consume({ mobile: unknown, scene: 'signin', code: '000000' }, ip),
    ).rejects.toMatchObject({ err: Err.SMS_TOO_FREQUENT })
  })

  it('shares verification IP limits across rotating IPv6 addresses in one /64', async () => {
    for (let i = 0; i < 30; i++)
      expect(
        await otp.consume(
          { mobile: unknowns[i % 4]!, scene: 'signin', code: '000000' },
          `2001:db8:a:b::${i + 1}`,
        ),
      ).toBe(false)
    await expect(
      otp.consume(
        { mobile: unknowns[4]!, scene: 'signin', code: '000000' },
        '2001:db8:a:b:ffff::1',
      ),
    ).rejects.toMatchObject({ err: Err.SMS_TOO_FREQUENT })
    expect(
      await otp.consume(
        { mobile: unknowns[4]!, scene: 'signin', code: '000000' },
        '2001:db8:a:c::1',
      ),
    ).toBe(false)
  })

  it('validates mobile and scene at the HTTP boundary', async () => {
    expect((await send('bad')).status).toBe(400)
    expect((await send(mobiles[0]!, 'invalid')).status).toBe(400)
  })
})
