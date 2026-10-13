// Tasks and notifications with tenants (see docs/design-notes.md#tenancy), the switch on, between the
// default tenant (A) and tenant B. Tasks are the platform's: their pages refuse another tenant (403) on
// every route, even granted their menus, and a timed-out task alerts the default tenant's root accounts
// only. The outbox job scans every tenant and delivers each row in its own tenant; a delivery run in
// another tenant leaves the row alone. A mail without an account of its template goes through the
// platform's first enabled account whatever the tenant. The retention purge takes every tenant's rows.
import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import { DEFAULT_TENANT_ID as A, runPerms, taskPerms } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { tenantId, withTenant } from '../../src/core/context/tenant.js'
import { Notifier, NotifyChannels, NotifyDispatcher } from '../../src/core/notify/notify.js'
import { RealtimeService } from '../../src/core/realtime/realtime.service.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { findId, insertRow } from '../../src/db/seeds/upsert.js'
import { InboxChannel } from '../../src/modules/platform/messaging/inbox/inbox.channel.js'
import { MailTransports } from '../../src/modules/platform/messaging/mail-account/mail-transports.js'
import { JobScheduler } from '../../src/modules/platform/scheduler/job-scheduler.js'
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

const PREFIX = 'tj-e2e-'
const job = { signal: new AbortController().signal, log: () => {} }

let on: NestExpressApplication
let ds: DataSource
let redis: Redis
let B: PeopledTenant
/** a plain user of the default tenant */
let aUser = 0
const tokens = { root: '', bAdmin: '' }
/** the default tenant's and the platform's rows of this spec, by table (B's go with B.dispose()) */
const mine: Record<string, number[]> = {
  msg_inbox: [],
  aud_action_log: [],
  job_task: [],
  msg_mail_template: [],
  msg_mail_account: [],
}
let lastRun = 0
let lastInbox = 0
/** fire times of this spec: whole seconds far from now (no cron tick collides with them) */
let at = Date.UTC(2033, 0, 1)
const nextAt = () => (at += 1000)

const inbox = (userId: number, title = `${PREFIX}hello`) => ({
  user_id: userId,
  template_code: `${PREFIX}inbox`,
  locale: 'en-US',
  category: 'system',
  title,
  body: 'x',
  status: 'pending',
})
/** status and attempts of rows of `table` (a constant of this spec), by id */
const states = async (table: string, ids: number[]) =>
  (
    await ds.query<{ id: number; status: string; attempts: number }[]>(
      `SELECT id, status, attempts FROM ${table} WHERE id IN (?) ORDER BY id`,
      [ids],
    )
  ).map((r) => [Number(r.id), r.status, Number(r.attempts)])

beforeAll(async () => {
  on = await bootApp({ multiTenant: true })
  ds = on.get<DataSource>(getDataSourceToken())
  redis = on.get(REDIS)
  await cleanRedis(redis)
  lastRun = Number((await ds.query('SELECT COALESCE(MAX(id), 0) AS n FROM job_run'))[0].n)
  lastInbox = Number((await ds.query('SELECT COALESCE(MAX(id), 0) AS n FROM msg_inbox'))[0].n)
  B = await createTenant(on, { users: true })
  aUser = await addUser(on, A, `${PREFIX}reader`)
  tokens.root = (await signIn(on)).accessToken
  // B's `member` holds every menu of the scheduler pages (platform menus: its sessions lose them)
  const menus = await ds.query<{ id: number }[]>(
    'SELECT id FROM iam_menu WHERE perms IN (?) AND deleted_at IS NULL',
    [[...Object.values(taskPerms), ...Object.values(runPerms)]],
  )
  for (const { id } of menus)
    await addRow(on, B.id, 'iam_role_menus', { role_id: B.roleId, menu_id: Number(id) })
  tokens.bAdmin = (await signInDirect(on, B.users.admin))!.accessToken
})

afterAll(async () => {
  if (ds) {
    await on.get(JobScheduler).idle()
    await on.get(NotifyDispatcher).idle()
    await B?.dispose()
    await ds.query('DELETE FROM msg_inbox WHERE id > ? AND template_code = ? AND tenant_id = ?', [
      lastInbox,
      'scheduler.job.timeout',
      A,
    ])
    await ds.query('DELETE FROM job_run WHERE id > ?', [lastRun])
    // table names of this spec
    for (const [table, ids] of Object.entries(mine))
      if (ids.length) await ds.query(`DELETE FROM ${table} WHERE id IN (?)`, [ids])
    if (aUser) await ds.query('DELETE FROM iam_user WHERE id = ?', [aUser])
  }
  if (redis) await cleanRedis(redis)
  await on?.close()
})

describe('the scheduler pages', () => {
  it('refuse another tenant on every route (403), even granted their menus; nothing runs, changes or goes', async () => {
    const taskId = (await findId(ds.manager, 'job_task', { name: 'seed.task.auditPurge' }))!
    const runId = await insertRow(ds.manager, 'job_run', {
      task_id: taskId,
      task_name: 'seed.task.auditPurge',
      handler: 'audit.purge',
      outcome: 'ok',
    })
    const before = await ds.query('SELECT * FROM job_task WHERE id = ?', [taskId])
    const routes: ['get' | 'post' | 'put' | 'delete', string, object?][] = [
      ['get', '/scheduler/tasks'],
      ['get', '/scheduler/tasks/export'],
      ['get', '/scheduler/tasks/handlers'],
      ['get', '/scheduler/tasks/next-fire-times?cron=0%200%203%20*%20*%20*'],
      ['get', `/scheduler/tasks/${taskId}`],
      [
        'post',
        '/scheduler/tasks',
        { name: `${PREFIX}task`, handler: 'demo.echo', cron: '0 0 3 * * *' },
      ],
      ['put', `/scheduler/tasks/${taskId}`, { cron: '0 0 4 * * *' }],
      ['put', `/scheduler/tasks/${taskId}/enabled`, { enabled: false }],
      ['post', `/scheduler/tasks/${taskId}/run`],
      ['delete', `/scheduler/tasks/${taskId}`],
      ['post', '/scheduler/tasks/batch-delete', { ids: [taskId] }],
      ['get', '/scheduler/runs'],
      ['get', '/scheduler/runs/export'],
      ['get', `/scheduler/runs/${runId}`],
      ['delete', `/scheduler/runs/${runId}`],
      ['post', '/scheduler/runs/batch-delete', { ids: [runId] }],
      ['post', '/scheduler/runs/clean'],
    ]
    for (const [method, path, body] of routes) {
      const req = request(on.getHttpServer())[method](`/api${path}`).set(bearer(tokens.bAdmin))
      expect([method, path, (await (body ? req.send(body) : req)).status]).toEqual([
        method,
        path,
        403,
      ])
    }
    await on.get(JobScheduler).idle()
    expect(await ds.query('SELECT * FROM job_task WHERE id = ?', [taskId])).toEqual(before)
    expect(await ds.query('SELECT id FROM job_task WHERE name = ?', [`${PREFIX}task`])).toEqual([])
    expect(
      await ds.query('SELECT id, deleted_at FROM job_run WHERE task_id = ? AND id > ?', [
        taskId,
        lastRun,
      ]),
    ).toEqual([{ id: runId, deleted_at: null }])
    // the default tenant's root uses them
    await request(on.getHttpServer())
      .get(`/api/scheduler/runs/${runId}`)
      .set(bearer(tokens.root))
      .expect(200)
  })
})

describe('the timeout alert', () => {
  it("goes to the default tenant's root accounts only, never to the holder of a builtin role coded root in another tenant", async () => {
    // whatever made it: a builtin role coded `root` in B, held by B's alice
    const fakeRoot = await addRow(on, B.id, 'iam_role', {
      code: 'root',
      name: 'seed.role.root',
      data_scope: 'all',
      is_builtin: 1,
    })
    await addRow(on, B.id, 'iam_user_roles', { user_id: B.users.alice, role_id: fakeRoot })
    const [admin] = await ds.query<{ id: number }[]>(
      'SELECT id FROM iam_user WHERE username = ? AND tenant_id = ?',
      ['admin', A],
    )
    const taskId = await insertRow(ds.manager, 'job_task', {
      name: `${PREFIX}timeout`,
      handler: 'demo.echo',
      params: { delayMs: 10_000 },
      cron: '0 0 3 * * *',
      enabled: 0,
      timeout_ms: 100,
    })
    mine.job_task!.push(taskId)
    const notifier = on.get(Notifier)
    const send = notifier.send.bind(notifier)
    const sent: [number[], number][] = []
    const spy = vi.spyOn(notifier, 'send').mockImplementation((input) => {
      sent.push([input.to as number[], tenantId()])
      return send(input)
    })
    try {
      await on.get(JobScheduler).fire(taskId, nextAt(), 'manual')
    } finally {
      spy.mockRestore()
    }
    const [run] = await ds.query<{ outcome: string }[]>(
      'SELECT outcome FROM job_run WHERE task_id = ?',
      [taskId],
    )
    expect(run?.outcome).toBe('timeout')
    expect(sent).toHaveLength(1)
    const [to, tenant] = sent[0]!
    expect(tenant).toBe(A)
    expect(to).toContain(Number(admin!.id))
    expect(to).not.toContain(B.users.alice)
    const rows = await ds.query<{ user_id: number; tenant_id: number }[]>(
      'SELECT user_id, tenant_id FROM msg_inbox WHERE id > ? AND template_code = ? ORDER BY id',
      [lastInbox, 'scheduler.job.timeout'],
    )
    expect(rows.map((r) => [Number(r.user_id), Number(r.tenant_id)])).toEqual(
      to.map((id) => [id, A]),
    )
  })
})

describe('the outbox', () => {
  it('notify.dispatch delivers each due row in its own tenant: the push and the listeners run in it', async () => {
    const bRow = await addRow(on, B.id, 'msg_inbox', inbox(B.users.alice))
    const aRow = await addRow(on, A, 'msg_inbox', inbox(aUser))
    mine.msg_inbox!.push(aRow)
    const heard: [number, number][] = []
    on.get(InboxChannel).onDelivered(async (row) => {
      if (row.id === aRow || row.id === bRow) heard.push([row.id, tenantId()])
    })
    const pushes: [number, number][] = []
    const push = vi
      .spyOn(on.get(RealtimeService), 'toUser')
      .mockImplementation((userId) => void pushes.push([userId, tenantId()]))
    try {
      await on.get(NotifyDispatcher).dispatch({}, job)
      await on.get(NotifyDispatcher).idle()
    } finally {
      push.mockRestore()
    }
    expect(await states('msg_inbox', [bRow, aRow])).toEqual([
      [bRow, 'delivered', 1],
      [aRow, 'delivered', 1],
    ])
    expect(heard).toEqual(
      expect.arrayContaining([
        [bRow, B.id],
        [aRow, A],
      ]),
    )
    expect(pushes).toEqual(
      expect.arrayContaining([
        [B.users.alice, B.id],
        [aUser, A],
      ]),
    )
  })

  it("a delivery run in another tenant leaves the row alone (inbox, mail, SMS); in the row's tenant it is claimed", async () => {
    const rows = {
      msg_inbox: await addRow(on, B.id, 'msg_inbox', inbox(B.users.alice)),
      msg_mail_record: await addRow(on, B.id, 'msg_mail_record', {
        to_list: JSON.stringify(['someone@example.invalid']),
        template_code: `${PREFIX}mail`,
        locale: 'en-US',
        subject: 'x',
        body: 'x',
        status: 'pending',
      }),
      msg_sms_record: await addRow(on, B.id, 'msg_sms_record', {
        template_code: `${PREFIX}sms`,
        mobile: '13900009999',
        body: 'x',
        status: 'pending',
      }),
    }
    const channels = on.get(NotifyChannels)
    const code = { msg_inbox: 'inbox', msg_mail_record: 'mail', msg_sms_record: 'sms' } as const
    const push = vi.spyOn(on.get(RealtimeService), 'toUser').mockImplementation(() => {})
    try {
      for (const [table, id] of Object.entries(rows) as [keyof typeof code, number][]) {
        await withTenant(A, () => channels.get(code[table])!.deliver(id))
        expect([table, await states(table, [id])]).toEqual([table, [[id, 'pending', 0]]])
      }
      expect(push).not.toHaveBeenCalled()
      // in B: the inbox row goes out; the mail and the SMS have no account or channel (failed, tried once)
      for (const [table, id] of Object.entries(rows) as [keyof typeof code, number][])
        await withTenant(B.id, () => channels.get(code[table])!.deliver(id))
      expect(await states('msg_inbox', [rows.msg_inbox])).toEqual([
        [rows.msg_inbox, 'delivered', 1],
      ])
      expect(await states('msg_mail_record', [rows.msg_mail_record])).toEqual([
        [rows.msg_mail_record, 'failed', 1],
      ])
      expect(await states('msg_sms_record', [rows.msg_sms_record])).toEqual([
        [rows.msg_sms_record, 'failed', 1],
      ])
      expect(push).toHaveBeenCalledExactlyOnceWith(B.users.alice, expect.anything())
    } finally {
      push.mockRestore()
    }
  })

  it("a mail of another tenant whose template names no account goes through the platform's first enabled account", async () => {
    const accountId = await insertRow(ds.manager, 'msg_mail_account', {
      name: `${PREFIX}account`,
      address: 'notify@example.invalid',
      host: 'example.invalid',
      port: 25,
      security: 'none',
      enabled: 1,
    })
    mine.msg_mail_account!.push(accountId)
    mine.msg_mail_template!.push(
      await insertRow(ds.manager, 'msg_mail_template', {
        code: `${PREFIX}mail`,
        locale: 'en-US',
        name: `${PREFIX}mail`,
        subject: 'Hello',
        body: '<p>Hello</p>',
        enabled: 1,
      }),
    )
    const [{ fallback }] = await ds.query<{ fallback: number }[]>(
      'SELECT MIN(id) AS fallback FROM msg_mail_account WHERE enabled = 1',
    )
    const transport = vi
      .spyOn(on.get(MailTransports), 'send')
      .mockResolvedValue({ messageId: `${PREFIX}sent` } as Awaited<
        ReturnType<MailTransports['send']>
      >)
    try {
      const ids = await withTenant(B.id, () =>
        on.get(Notifier).send({
          template: `${PREFIX}mail`,
          to: [{ email: 'b@example.invalid' }],
          channels: ['mail'],
        }),
      )
      const [row] = await ds.query<{ tenant_id: number; account_id: number; status: string }[]>(
        'SELECT tenant_id, account_id, status FROM msg_mail_record WHERE id = ?',
        [ids.mail![0]],
      )
      expect(row).toEqual({ tenant_id: B.id, account_id: Number(fallback), status: 'sent' })
      expect(transport).toHaveBeenCalledExactlyOnceWith(Number(fallback), expect.anything())
    } finally {
      transport.mockRestore()
    }
  })
})

describe('audit.purge', () => {
  it('deletes the expired rows of every tenant, keeping the fresh ones', async () => {
    const old = new Date(Date.now() - 400 * 86_400_000)
    const fresh = new Date()
    const rows: Record<string, (at: Date) => Record<string, unknown>> = {
      aud_action_log: (at) => ({
        domain: PREFIX,
        verb: 'modify',
        http_method: 'PUT',
        url: '/x',
        ok: 1,
        cost_ms: 1,
        actor_tenant_id: B.id,
        created_at: at,
      }),
      aud_signin_log: (at) => ({
        kind: 'password',
        username: PREFIX,
        client_id: 'console',
        ok: 1,
        msg_key: 'signin.ok',
        created_at: at,
      }),
      msg_inbox: (at) => ({ ...inbox(B.users.alice), status: 'delivered', created_at: at }),
      msg_mail_record: (at) => ({
        to_list: JSON.stringify(['someone@example.invalid']),
        template_code: PREFIX,
        locale: 'en-US',
        subject: 'x',
        body: 'x',
        status: 'sent',
        created_at: at,
      }),
      msg_sms_record: (at) => ({
        template_code: PREFIX,
        body: 'x',
        status: 'sent',
        created_at: at,
      }),
      msg_sms_otp: (at) => ({
        mobile: '13900009999',
        scene: 'signin',
        code: '123456',
        daily_seq: 1,
        request_ip: '127.0.0.1',
        created_at: at,
      }),
    }
    const ids: Record<string, [old: number, fresh: number]> = {}
    for (const [table, row] of Object.entries(rows))
      ids[table] = [
        await addRow(on, B.id, table, row(old)),
        await addRow(on, B.id, table, row(fresh)),
      ]
    const oldA = await addRow(on, A, 'aud_action_log', {
      ...rows.aud_action_log!(old),
      actor_tenant_id: A,
    })
    mine.aud_action_log!.push(oldA)
    const taskId = (await findId(ds.manager, 'job_task', { name: 'seed.task.auditPurge' }))!
    await on.get(JobScheduler).fire(taskId, nextAt(), 'manual')
    const [run] = await ds.query<{ outcome: string }[]>(
      'SELECT outcome FROM job_run WHERE task_id = ? AND id > ? ORDER BY id DESC LIMIT 1',
      [taskId, lastRun],
    )
    expect(run?.outcome).toBe('ok')
    for (const [table, [o, f]] of Object.entries(ids))
      expect([
        table,
        // table names of this spec
        (await ds.query(`SELECT id FROM ${table} WHERE id IN (?)`, [[o, f]])).map(
          (r: { id: number }) => Number(r.id),
        ),
      ]).toEqual([table, [f]])
    expect(await ds.query('SELECT id FROM aud_action_log WHERE id = ?', [oldA])).toEqual([])
  })
})
