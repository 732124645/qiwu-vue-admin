// Real routes and persistence, with only DNS / provider transports replaced.
// Parser, sanitizer, SDK-agent and browser details retain their dedicated regression specs.
import dns from 'node:dns'
import { rm } from 'node:fs/promises'
import { createServer, request as nodeRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import {
  Err,
  excelImportParams,
  STORAGE_SECRET_MASK,
  storageParams,
  WF_BPMN_XML_MAX,
} from '@qiwu/shared'
import ExcelJS from 'exceljs'
import nodemailer from 'nodemailer'
import sharp from 'sharp'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { AppConfigService } from '../../src/core/config/config.module.js'
import { uploadRoot } from '../../src/core/paths.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { ParamService } from '../../src/core/settings/param.service.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { S3Storage } from '../../src/modules/platform/storage/s3-storage.js'
import { StorageService } from '../../src/modules/platform/storage/storage.service.js'
import { cfg, fixture } from '../fixtures/wf/bpmn-fixture.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const PREFIX = 'sec-input-'
const CONFIGS = '/api/storage/configs'
const OBJECTS = '/api/storage/objects'
const ACCOUNTS = '/api/messaging/mail-accounts'
const MODELS = '/api/wf/models'
const FORMS = '/api/wf/forms'
const HTML =
  '<p style="color:red" onclick="alert(1)">Safe</p><img src="x" onerror="alert(1)"><script>alert(1)</script><style>p{display:none}</style><iframe src="https://evil.example"></iframe>'
const SAFE = '<p>Safe</p><img src="x" />'
const PDF = Buffer.from('%PDF-1.4\ntrailer\n<<>>\n%%EOF\n')
const FORMULAS = ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx']
// Child rows first; these baselines belong to this spec.
const TABLES = [
  'msg_mail_record',
  'msg_inbox',
  'msg_mail_template',
  'msg_inbox_template',
  'msg_mail_account',
  'msg_bulletin',
  'wf_version',
  'wf_model',
  'wf_form',
  'fs_object',
  'fs_storage',
  'iam_user',
] as const
const baselines = new Map<string, number>()
let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let png: Buffer
let admin: string
let owner: string
let other: string
let seq = 0
let endpoint: Server
let endpointPort: number
let hits = 0
const unique = () => `${PREFIX}${++seq}`
const api = (
  method: 'get' | 'post' | 'put' | 'delete',
  path: string,
  body?: object,
  token = admin,
) => {
  const req = request(app.getHttpServer())
    [method](path)
    .set({ ...bearer(token), 'Accept-Language': 'en-US' })
  return body ? req.send(body) : req
}
const count = async (table: string) =>
  Number((await ds.query(`SELECT COUNT(*) AS n FROM ${table}`))[0].n)
const s3Body = (over: object = {}) => ({
  name: unique(),
  driver: 's3',
  endpoint: 'https://s3.example.com',
  region: 'us-east-1',
  bucket: 'qw-files',
  accessKey: 'AKIDEXAMPLE',
  secretKey: 'input-secret',
  forcePathStyle: true,
  ...over,
})
const mailBody = (over: object = {}) => ({
  name: unique(),
  address: 'sender@example.com',
  username: 'mailer',
  password: 'input-password',
  host: 'smtp.example.com',
  port: 465,
  security: 'ssl',
  ...over,
})
const upload = (file: Buffer, name: string, bizTag = 'attachment') =>
  request(app.getHttpServer())
    .post(OBJECTS)
    .set(bearer(owner))
    .field('bizTag', bizTag)
    .attach('file', file, name)
const add = async (path: string, body: object) =>
  (await api('post', path, body).expect(201)).body.data
async function strict<T>(fn: () => Promise<T>, s3Ports?: number[]) {
  const config = app.get(AppConfigService)
  const get = config.get.bind(config)
  const spy = vi
    .spyOn(config, 'get')
    .mockImplementation(((key: string) =>
      key === 'ALLOW_PRIVATE_ENDPOINTS'
        ? false
        : key === 'OUTBOUND_S3_PORTS' && s3Ports
          ? s3Ports
          : get(key as never)) as typeof config.get)
  try {
    return await fn()
  } finally {
    spy.mockRestore()
  }
}
async function withParam(key: string, value: string, fn: () => Promise<void>) {
  const [{ param_value: before }] = await ds.query(
    'SELECT param_value FROM cfg_param WHERE param_key = ?',
    [key],
  )
  const set = async (v: string) => {
    await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [v, key])
    await app.get(ParamService).invalidate(key)
  }
  await set(value)
  try {
    await fn()
  } finally {
    await set(before)
  }
}
async function xlsx(rows: string[][]) {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('users')
  rows.forEach((row) => ws.addRow(row))
  return Buffer.from(await wb.xlsx.writeBuffer())
}
const importFile = (file: Buffer, name = unique() + '.xlsx') =>
  request(app.getHttpServer())
    .post('/api/iam/users/import')
    .set({ ...bearer(admin), 'Accept-Language': 'en-US' })
    .attach('file', file, name)
// Send traversal bytes unchanged (URL-based clients normalize literal '..').
const rawStatus = (path: string) =>
  new Promise<number>((resolve, reject) => {
    const { port } = app.getHttpServer().address() as AddressInfo
    nodeRequest({ host: '127.0.0.1', port, path }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
      .on('error', reject)
      .end()
  })

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  await cleanRedis(redis)
  for (const table of TABLES)
    baselines.set(
      table,
      Number((await ds.query(`SELECT COALESCE(MAX(id), 0) AS n FROM ${table}`))[0].n),
    )
  admin = (await signIn(app)).accessToken
  for (const who of ['owner', 'other']) {
    await insertRow(ds.manager, 'iam_user', {
      username: PREFIX + who,
      display_name: who,
      password_hash: 'not-used',
      password_changed_at: new Date(),
    })
    const token = (await signIn(app, PREFIX + who)).accessToken
    if (who === 'owner') owner = token
    else other = token
  }
  png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .png()
    .toBuffer()
  endpoint = createServer((_req, res) => {
    hits++
    res.writeHead(200).end()
  })
  await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve))
  endpointPort = (endpoint.address() as AddressInfo).port
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  vi.restoreAllMocks()
  if (endpoint) {
    endpoint.closeAllConnections()
    await new Promise<void>((resolve) => endpoint.close(() => resolve()))
  }
  if (ds && baselines.has('fs_object')) {
    const files: { object_key: string }[] = await ds.query(
      'SELECT object_key FROM fs_object WHERE id > ?',
      [baselines.get('fs_object')],
    )
    for (const file of files)
      for (const area of ['public', 'private'])
        await rm(join(uploadRoot(), area, file.object_key), { force: true })
    for (const table of TABLES)
      await ds.query(`DELETE FROM ${table} WHERE id > ?`, [baselines.get(table)])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

describe('XSS: persisted rich text and code-bearing form input', () => {
  it.each([
    [
      '/api/messaging/bulletins',
      'msg_bulletin',
      () => ({ title: unique(), kind: 'notice', body: HTML }),
    ],
    [
      '/api/messaging/mail-templates',
      'msg_mail_template',
      () => ({ code: unique(), locale: 'en-US', name: unique(), subject: 'Safe', body: HTML }),
    ],
  ] as const)('%s sanitizes create/update, not just its response', async (path, table, body) => {
    const row = await add(path, body())
    expect(row.body).toBe(SAFE)
    expect((await ds.query(`SELECT body FROM ${table} WHERE id = ?`, [row.id]))[0].body).toBe(SAFE)
    await api('put', `${path}/${row.id}`, { body: HTML }).expect(200)
    expect((await ds.query(`SELECT body FROM ${table} WHERE id = ?`, [row.id]))[0].body).toBe(SAFE)
    expect((await api('get', `${path}/${row.id}`).expect(200)).body.data.body).toBe(SAFE)
    await api('put', `${path}/${row.id}`, { body: HTML }, other).expect(403)
    expect((await ds.query(`SELECT body FROM ${table} WHERE id = ?`, [row.id]))[0].body).toBe(SAFE)
  })

  it('inbox template parameters remain plain text through delivery and reading', async () => {
    const tpl = await add('/api/messaging/inbox-templates', {
      code: `sec.input_${++seq}`,
      locale: 'en-US',
      name: unique(),
      title: 'Plain',
      body: 'Message {value}',
      category: 'system',
    })
    const sent = await api('post', `/api/messaging/inbox-templates/${tpl.id}/test`, {
      params: { value: HTML },
    }).expect(200)
    expect(sent.body.data.ok).toBe(true)
    const id = sent.body.data.recordId
    expect((await ds.query('SELECT body FROM msg_inbox WHERE id = ?', [id]))[0].body).toBe(
      'Message ' + HTML,
    )
    expect((await api('get', `/api/messaging/inboxes/mine/${id}`).expect(200)).body.data.body).toBe(
      'Message ' + HTML,
    )
    await api('get', `/api/messaging/inboxes/mine/${id}`, undefined, other).expect(404)
  })

  it('obfuscated functions, behaviour keys and unknown components fail before any write', async () => {
    const schemaJson = { rule: [{ type: 'input', field: 'memo', title: 'Memo' }] }
    const row = await add(FORMS, { name: unique(), schemaJson })
    const before = await count('wf_form')
    const rules = [
      ...[
        '$FN:function(){return 1}',
        '\u00a0\ufeff$EXEC:function(){return 1}',
        '\\u0024FN:alert(1)',
        '[[FORM-CREATE-PREFIX-function(){return 1}-FORM-CREATE-SUFFIX]]',
      ].map((title) => ({ type: 'input', field: 'memo', title })),
      { type: 'input', field: 'memo', props: { onClick: '$FNX:alert(1)' } },
      { type: 'script', field: 'memo' },
    ]
    for (const rule of rules) {
      const bad = { rule: [rule] }
      const rejected = await api('post', FORMS, { name: unique(), schemaJson: bad }).expect(400)
      expect(rejected.body.code).toBe(Err.VALIDATION_FAILED.code)
      expect(rejected.body.errors[0].path).toMatch(/^schemaJson\.rule\.0/)
      await api('put', `${FORMS}/${row.id}`, { schemaJson: bad }).expect(400)
    }
    expect(await count('wf_form')).toBe(before)
    expect(
      (await ds.query('SELECT schema_json FROM wf_form WHERE id = ?', [row.id]))[0].schema_json,
    ).toEqual(schemaJson)
  })
})

describe('SSRF: save-time refusals and guarded connections', () => {
  it('S3/SMTP private, mapped IPv6, metadata and unregistered ports never persist or dial', async () => {
    const s3Send = vi.spyOn(S3Storage.prototype, 'test')
    const smtpCreate = vi.spyOn(nodemailer, 'createTransport')
    const before = [await count('fs_storage'), await count('msg_mail_account')]
    await strict(async () => {
      for (const host of [
        '127.0.0.1',
        '10.0.0.1',
        '169.254.169.254',
        '[::ffff:127.0.0.1]',
        '[fd00:ec2::254]',
      ]) {
        expect(
          (await api('post', CONFIGS, s3Body({ endpoint: `https://${host}` })).expect(422)).body
            .code,
        ).toBe(Err.STORAGE_ENDPOINT_REFUSED.code)
        expect((await api('post', ACCOUNTS, mailBody({ host })).expect(422)).body.code).toBe(
          Err.MAIL_HOST_REFUSED.code,
        )
      }
      await api('post', CONFIGS, s3Body({ endpoint: 'https://s3.example.com:6379' })).expect(422)
      await api('post', ACCOUNTS, mailBody({ port: 6379 })).expect(422)
    })
    expect([await count('fs_storage'), await count('msg_mail_account')]).toEqual(before)
    expect(s3Send).not.toHaveBeenCalled()
    expect(smtpCreate).not.toHaveBeenCalled()
  })

  it('a stored S3 hostname resolving privately is refused by the SDK before the local service is hit; only the test bypass opens it', async () => {
    const row = await add(CONFIGS, s3Body({ endpoint: `http://s3.example.com:${endpointPort}` }))
    const lookup = vi
      .spyOn(dns.promises, 'lookup')
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never)
    const before = hits
    // Port explicitly registered: this must fail on DNS/address, not merely the port.
    await strict(async () => {
      const refused = await api('post', `${CONFIGS}/${row.id}/test`).expect(200)
      expect(refused.body.data).toEqual({ ok: false })
      expect(JSON.stringify(refused.body)).not.toMatch(/127\.0\.0\.1|input-secret/)
    }, [endpointPort])
    expect(lookup).toHaveBeenCalled()
    expect(hits).toBe(before)
    expect((await api('post', `${CONFIGS}/${row.id}/test`).expect(200)).body.data).toEqual({
      ok: true,
    })
    expect(hits).toBe(before + 1)
  })

  it('SMTP connects to the checked IP with original SNI, rechecks cached transports, and hides public provider failures', async () => {
    const row = await add(ACCOUNTS, mailBody())
    const lookup = vi
      .spyOn(dns.promises, 'lookup')
      .mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never)
    const transport = nodemailer.createTransport({ jsonTransport: true })
    const verify = vi.spyOn(transport, 'verify').mockRejectedValue(new Error('REMOTE SECRET 554'))
    const create = vi.spyOn(nodemailer, 'createTransport').mockReturnValue(transport)
    await strict(async () => {
      expect((await api('post', `${ACCOUNTS}/${row.id}/test`).expect(200)).body.data).toEqual({
        ok: false,
      })
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ host: '8.8.8.8', tls: { servername: 'smtp.example.com' } }),
      )
      expect(verify).toHaveBeenCalledOnce()
      lookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }] as never)
      const refused = await api('post', `${ACCOUNTS}/${row.id}/test`).expect(200)
      expect(refused.body.data).toEqual({ ok: false })
      expect(JSON.stringify(refused.body)).not.toMatch(/REMOTE|SECRET|554|169\.254/)
      expect(create).toHaveBeenCalledOnce()
      expect(verify).toHaveBeenCalledOnce()
    })
  })

  it('changing the S3 connection with a kept secret rolls back all fields before any external call', async () => {
    const body = s3Body()
    const row = await add(CONFIGS, body)
    const stored = async () =>
      (await ds.query('SELECT config, name, updated_at FROM fs_storage WHERE id = ?', [row.id]))[0]
    const before = await stored()
    const external = vi.spyOn(S3Storage.prototype, 'test')
    const res = await api('put', `${CONFIGS}/${row.id}`, {
      ...body,
      name: unique(),
      bucket: 'attacker-bucket',
      secretKey: STORAGE_SECRET_MASK,
    }).expect(422)
    expect(res.body.code).toBe(Err.STORAGE_SECRET_REQUIRED.code)
    expect(await stored()).toEqual(before)
    expect(external).not.toHaveBeenCalled()
  })
})

describe('upload/download: bytes, ownership and one-time direct-upload grants', () => {
  it('mismatched magic/extension, active content, public non-image and oversized bytes leave no object or storage write', async () => {
    const put = vi.spyOn(app.get(StorageService), 'clientFor')
    const before = await count('fs_object')
    for (const [file, name] of [
      [PDF, 'fake.png'],
      [png, 'fake.pdf'],
      [Buffer.from(HTML), 'active.html'],
      [png, 'bad.exe'],
    ] as const) {
      expect((await upload(file, name).expect(422)).body.code).toBe(Err.STORAGE_TYPE_REJECTED.code)
    }
    expect((await upload(PDF, 'public.pdf', 'richtext').expect(422)).body.code).toBe(
      Err.STORAGE_PUBLIC_IMAGE_ONLY.code,
    )
    await withParam(storageParams.maxSizeMb, '1', async () => {
      await upload(Buffer.alloc(1024 * 1024 + 1), 'large.txt').expect(413)
    })
    expect(await count('fs_object')).toBe(before)
    expect(put).not.toHaveBeenCalled()
  })

  it('private bytes stay behind auth and traversal guards; deleting a public image breaks its URL immediately', async () => {
    const privateRow = (await upload(PDF, 'private.pdf').expect(201)).body.data
    const [{ object_key: key }] = await ds.query('SELECT object_key FROM fs_object WHERE id = ?', [
      privateRow.id,
    ])
    expect(privateRow.url).toBeNull()
    for (const path of [
      `/files/${key}`,
      `/files/../private/${key}`,
      `/files/%2e%2e%2fprivate%2f${key.replaceAll('/', '%2f')}`,
      `/files/..\\private\\${key}`,
    ])
      expect([path, await rawStatus(path)]).toEqual([path, 404])
    await request(app.getHttpServer()).get(`${OBJECTS}/${privateRow.id}/download`).expect(401)
    await api('get', `${OBJECTS}/${privateRow.id}/download`, undefined, other).expect(403)
    const downloaded = await api(
      'get',
      `${OBJECTS}/${privateRow.id}/download`,
      undefined,
      owner,
    ).expect(200)
    expect(downloaded.headers['x-content-type-options']).toBe('nosniff')
    expect(downloaded.headers['content-security-policy']).toBe("default-src 'none'; sandbox")
    expect(downloaded.headers['content-disposition']).toMatch(/^attachment;/)
    const publicRow = (await upload(png, 'public.png', 'richtext').expect(201)).body.data
    await request(app.getHttpServer()).get(publicRow.url).expect(200)
    await api('delete', `${OBJECTS}/${publicRow.id}`, undefined, owner).expect(403)
    await request(app.getHttpServer()).get(publicRow.url).expect(200)
    await api('delete', `${OBJECTS}/${publicRow.id}`).expect(200)
    await request(app.getHttpServer()).get(publicRow.url).expect(404)
    await api('get', `${OBJECTS}/${publicRow.id}/download`, undefined, owner).expect(404)
  })

  it('another user cannot burn a presign grant; confirm reads/copies the same ETag and refuses changed bytes', async () => {
    const local = (await ds.query('SELECT id FROM fs_storage WHERE is_primary = 1'))[0].id
    const row = await add(CONFIGS, s3Body())
    await api('put', `${CONFIGS}/${row.id}/primary`).expect(200)
    const client = app
      .get(StorageService)
      .s3Client((await ds.query('SELECT config FROM fs_storage WHERE id = ?', [row.id]))[0].config)
    const forStorage = vi.spyOn(app.get(StorageService), 'clientFor').mockReturnValue(client)
    let race = false
    const send = vi.spyOn(client.client, 'send').mockImplementation((async (command: unknown) => {
      if (command instanceof HeadObjectCommand)
        return { ContentLength: png.length, ETag: '"checked"' }
      if (command instanceof GetObjectCommand) {
        expect(command.input.IfMatch).toBe('"checked"')
        return { ETag: '"checked"', Body: Readable.from([png]) }
      }
      if (command instanceof CopyObjectCommand) {
        expect(command.input.CopySourceIfMatch).toBe('"checked"')
        if (race) throw Object.assign(new Error('changed'), { $metadata: { httpStatusCode: 412 } })
        return {}
      }
      if (command instanceof DeleteObjectCommand) return {}
      throw new Error('unexpected S3 command')
    }) as typeof client.client.send)
    try {
      for (const changed of [false, true]) {
        race = changed
        send.mockClear()
        const grant = (
          await api(
            'post',
            `${OBJECTS}/presign`,
            {
              filename: unique() + '.png',
              size: png.length,
              mime: 'image/png',
              bizTag: 'richtext',
            },
            owner,
          ).expect(200)
        ).body.data
        const redisGrant = redisKey('presign', grant.key)
        const before = await redis.get(redisGrant)
        expect(before).toBeTruthy()
        await api('post', `${OBJECTS}/confirm`, { key: grant.key }, other).expect(404)
        expect(await redis.get(redisGrant)).toBe(before)
        expect(send).not.toHaveBeenCalled()
        const countBefore = await count('fs_object')
        const result = await api('post', `${OBJECTS}/confirm`, { key: grant.key }, owner).expect(
          changed ? 422 : 201,
        )
        expect(await redis.get(redisGrant)).toBeNull()
        expect(await count('fs_object')).toBe(countBefore + (changed ? 0 : 1))
        expect(send.mock.calls.map(([command]) => command.constructor.name)).toEqual([
          'HeadObjectCommand',
          'GetObjectCommand',
          'CopyObjectCommand',
          'DeleteObjectCommand',
        ])
        if (changed) expect(result.body.code).toBe(Err.STORAGE_UPLOAD_MISMATCH.code)
        else expect(result.body.data).toMatchObject({ mime: 'image/png', isPublic: true })
        await api('post', `${OBJECTS}/confirm`, { key: grant.key }, owner).expect(404)
      }
    } finally {
      forStorage.mockRestore()
      client.destroy()
      await api('put', `${CONFIGS}/${local}/primary`).expect(200)
    }
  })
})

describe('Excel: real export/import safety', () => {
  it('export emits text, never a formula, for every dangerous prefix', async () => {
    for (const [i, name] of FORMULAS.entries())
      await insertRow(ds.manager, 'iam_user', {
        username: `${PREFIX}formula${i}`,
        display_name: name,
        password_hash: 'not-used',
      })
    const response = await api('get', '/api/iam/users/export')
      .query({ username: PREFIX + 'formula' })
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => cb(null, Buffer.concat(chunks)))
      })
      .expect(200)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(response.body)
    const ws = wb.worksheets[0]!
    expect(ws.rowCount).toBe(FORMULAS.length + 1)
    const names = Array.from(
      { length: FORMULAS.length },
      (_, i) => ws.getRow(i + 2).getCell(2).value,
    )
    // XML parsers normalize CR to LF; the cell must still be escaped text, never a formula object.
    expect(names.sort()).toEqual(FORMULAS.map((value) => "'" + value.replaceAll('\r', '\n')).sort())
  })

  it('macro/external-link parts and row/column/file limits reject imports without changing users', async () => {
    const before = await count('iam_user')
    const normal = await xlsx([
      ['Username', 'Display name'],
      [unique(), 'Name'],
      [unique(), 'Name'],
    ])
    for (const [from, to] of [
      ['docProps/core.xml', 'xl/vbaProject.bin'],
      ['xl/theme/theme1.xml', 'xl/externalLinks/a1'],
    ]) {
      expect(normal.includes(Buffer.from(from!))).toBe(true)
      const unsafe = Buffer.from(normal.toString('latin1').replaceAll(from!, to!), 'latin1')
      expect((await importFile(unsafe).expect(400)).body.code).toBe(Err.EXCEL_UNSAFE.code)
    }
    await withParam(excelImportParams.maxRows, '1', async () => {
      expect((await importFile(normal).expect(413)).body.code).toBe(Err.EXCEL_TOO_MANY_ROWS.code)
    })
    await withParam(excelImportParams.maxColumns, '2', async () => {
      expect(
        (await importFile(await xlsx([['Username', 'Display name', 'Note']])).expect(413)).body
          .code,
      ).toBe(Err.EXCEL_TOO_MANY_COLUMNS.code)
    })
    await withParam(excelImportParams.maxMb, '1', async () => {
      await importFile(Buffer.concat([normal, Buffer.alloc(1024 * 1024)])).expect(413)
    })
    expect(await count('iam_user')).toBe(before)
  })
})

describe('BPMN XML: byte/preparse limits and server-derived publication', () => {
  it('malicious XML cannot replace a saved draft or create a version; the valid XML derives its own tree', async () => {
    const settings = {
      assignee: { kind: 'users', ids: [1] },
      sign: 'any',
      whenNobody: 'autoPass',
      whenInitiatorIsReviewer: 'self',
      onReject: 'finish',
    }
    const base = () =>
      fixture({ flows: 'S>R1>E1', names: { R1: 'Review' }, inner: { R1: cfg(settings) } })
    const xml = base()
    const model = await add(MODELS, {
      modelKey: unique(),
      name: unique(),
      formKind: 'dynamic',
      flowKind: 'bpmn',
    })
    const draft = `${MODELS}/${model.id}/draft`
    const versions = `${MODELS}/${model.id}/versions`
    await api('put', draft, { xml }).expect(200)
    const badParse = [
      xml.replace(
        '?>',
        '?><!DoCtYpE d [<!EnTiTy x SYSTEM "http://169.254.169.254/latest/meta-data/">]>',
      ),
      xml.replace('?>', '?><!EnTiTy x "INJECTED">'),
      xml.replace('</bpmn:process>', `<!--${'é'.repeat(WF_BPMN_XML_MAX / 2)}--></bpmn:process>`),
      xml.replace('</bpmn:process>', '<bpmn:fooTask id="unknown"/></bpmn:process>'),
    ]
    expect(badParse[2]!.length).toBeLessThan(WF_BPMN_XML_MAX)
    expect(Buffer.byteLength(badParse[2]!)).toBeGreaterThan(WF_BPMN_XML_MAX)
    const badPublish = [
      ...badParse,
      xml.replace('urn:qiwu:bpmn:1', 'urn:attacker:bpmn'),
      fixture({ flows: 'S>T1>E1' }),
      xml.replace('<qw:Config>', '<evil:listener xmlns:evil="urn:attacker"/><qw:Config>'),
      xml.replace('name="Review"', 'name="&#36;&#123;alert(1)}"'),
    ]
    const outbound = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('unexpected outbound'))
    // Drafts may be half drawn; execution semantics are enforced on publication.
    for (const payload of badParse) {
      const res = await api('put', draft, { xml: payload }).expect(400)
      expect(res.body.code).toBe(Err.VALIDATION_FAILED.code)
      expect(res.body.errors[0].path).toMatch(/^xml(?:\.|$)/)
    }
    for (const payload of badPublish) {
      const res = await api('post', versions, { xml: payload, fields: {} }).expect(400)
      expect(res.body.code).toBe(Err.VALIDATION_FAILED.code)
      expect(res.body.errors[0].path).toMatch(/^xml(?:\.|$)/)
    }
    await api('post', versions, {
      xml,
      fields: {},
      tree: { id: 'forged', type: 'begin', name: 'Forged' },
    }).expect(400)
    expect(
      (
        await ds.query('SELECT draft_xml, current_version_id FROM wf_model WHERE id = ?', [
          model.id,
        ])
      )[0],
    ).toEqual({ draft_xml: xml, current_version_id: null })
    expect((await api('get', versions).expect(200)).body.data).toEqual([])
    expect(outbound).not.toHaveBeenCalled()
    await api('put', draft, { xml }, other).expect(403)
    const published = (await api('post', versions, { xml, fields: {} }).expect(201)).body.data
    const stored = (
      await ds.query('SELECT tree_json, bpmn_xml FROM wf_version WHERE id = ?', [published.id])
    )[0]
    expect(stored.tree_json).toMatchObject({
      id: 'S',
      type: 'begin',
      next: { id: 'R1', type: 'review', ...settings },
    })
    expect(stored.bpmn_xml).toContain('<bpmn:outgoing>S_R1</bpmn:outgoing>')
  })
})
