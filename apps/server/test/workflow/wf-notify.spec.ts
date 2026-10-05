// 通知 (see docs/design-notes.md#workflow): WfNotify turns the change sets WfStore writes into Notifier sends (the
// nine wf.* templates: inbox + mail rows in each recipient's language and zone, typed params) and `wf:task`
// pushes to the users whose to-dos changed, once the outermost transaction commits (never on a rollback).
// Nobody hears of their own action. Drives WfStore with engine calls (the action endpoints are tested elsewhere).
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Propagation, TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import { LOCALES, RT, type RealtimeMessage, type WfChangeSet, type WfStep } from '@qiwu/shared'
import { ClsService } from 'nestjs-cls'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { NotifyDispatcher } from '../../src/core/notify/notify.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { approve, reject, sendBack } from '../../src/modules/workflow/engine/actions.js'
import { emptyChangeSet, event } from '../../src/modules/workflow/engine/advance.js'
import { cancel, reassign } from '../../src/modules/workflow/engine/lifecycle.js'
import { transfer } from '../../src/modules/workflow/engine/routing.js'
import { WfNotify } from '../../src/modules/workflow/runtime/wf-notify.js'
import { WfTaskRow } from '../../src/modules/workflow/runtime/wf-runtime.entity.js'
import { type WfRun, WfStore } from '../../src/modules/workflow/runtime/wf-store.js'
import { chain, fields, notify, parallel, review, T0 } from '../fixtures/wf/flow.js'
import { signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import { closeSockets, connect, inbox, socketOf } from '../setup/socket.js'

const PREFIX = 'e2e-wfn-'
/** model and node names are seed keys ({i18n}: 员工 / Staff, 总部 / Headquarters) or an admin's text */
const MODEL = 'seed.role.staff'
const HQ = 'seed.dept.hq'
const TEMPLATES = [
  'wf.task.assigned',
  'wf.instance.approved',
  'wf.instance.rejected',
  'wf.cc',
  'wf.task.canceled',
  'wf.instance.sent_back',
  'wf.task.urged',
  'wf.task.overdue',
  'wf.task.timeout',
]

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let cls: ClsService
let store: WfStore
let txHost: TransactionHost<TransactionalAdapterTypeOrm>
/** init starts; ann (zh-CN, Shanghai), ben (en-US, UTC), cat and dan review or get copies */
const WHO = ['init', 'ann', 'ben', 'cat', 'dan'] as const
type Who = (typeof WHO)[number]
const u = {} as Record<Who, number>
/** what each user's socket received */
const got = {} as Record<Who, RealtimeMessage[]>
const nameOf = (id: number) => WHO.find((w) => u[w] === Number(id))
let seq = 0
/** the last msg_inbox / msg_mail_record ids before the current test */
const mark = { inbox: 0, mail: 0 }

/** a model named `name` with one published version of `steps`; the version id */
async function publish(steps: WfStep[], name = MODEL): Promise<number> {
  const key = `${PREFIX}m${++seq}`
  const tree = { id: 'begin', type: 'begin', name: 'Begin', next: chain(...steps) }
  const m = await ds.query(
    "INSERT INTO wf_model (model_key, name, form_kind) VALUES (?, ?, 'dynamic')",
    [key, name],
  )
  const v = await ds.query(
    'INSERT INTO wf_version (model_id, model_key, version, tree_json, form_snapshot) VALUES (?, ?, 1, ?, ?)',
    [m.insertId, key, JSON.stringify(tree), JSON.stringify({ fields })],
  )
  return v.insertId
}

const input = (versionId: number) => ({
  versionId,
  initiatorId: u.init,
  initiatorDeptId: null,
  businessKey: null,
  formValues: { amount: 1 },
  initiatorPicks: {},
  initiatorCtx: { deptTreePath: null, roleIds: [] },
})
/** starts version `versionId` (at T0) in its own transaction; the instance id */
const start = async (versionId: number) =>
  (await cls.run(() => store.start(input(versionId), T0))).inst.id
const act = (instanceId: number, fn: (run: WfRun) => WfChangeSet | Promise<WfChangeSet>) =>
  cls.run(() => store.act(instanceId, fn, T0))
/** the pending task of `who` */
const taskOf = (run: WfRun, who: Who) =>
  run.tasks.find((t) => t.assigneeId === u[who] && t.state === 'pending')!

/** [who, template] of the inbox rows written since the test began */
async function sent() {
  const rows = await ds.query<{ user_id: number; template_code: string }[]>(
    'SELECT user_id, template_code FROM msg_inbox WHERE id > ? AND user_id IN (?) ORDER BY id',
    [mark.inbox, Object.values(u)],
  )
  return rows.map((r) => [nameOf(r.user_id), r.template_code])
}
/** the inbox row of `who` since the test began */
const inboxOf = async (who: Who) =>
  (
    await ds.query<{ template_code: string; locale: string; title: string; body: string }[]>(
      'SELECT template_code, locale, title, body FROM msg_inbox WHERE id > ? AND user_id = ?',
      [mark.inbox, u[who]],
    )
  )[0]
/** `wf:task` instance ids `who` received */
const pushes = (who: Who) =>
  got[who].flatMap((m) => (m.type === RT.wfTask ? [m.payload.instanceId] : []))
/** lets in-flight emits land (same process, loopback) */
const settle = () => new Promise((r) => setTimeout(r, 150))

async function cleanup() {
  const sub = `SELECT id FROM wf_instance WHERE model_key LIKE '${PREFIX}%'`
  for (const t of ['wf_task', 'wf_cc', 'wf_event'])
    await ds.query(`DELETE FROM ${t} WHERE instance_id IN (${sub})`)
  for (const t of ['wf_instance', 'wf_version', 'wf_model'])
    await ds.query(`DELETE FROM ${t} WHERE model_key LIKE ?`, [`${PREFIX}%`])
  const ids = Object.values(u)
  if (ids.length) {
    await app.get(NotifyDispatcher).idle()
    for (const t of ['msg_inbox', 'msg_mail_record'])
      await ds.query(`DELETE FROM ${t} WHERE user_id IN (?)`, [ids])
  }
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  cls = app.get(ClsService)
  store = app.get(WfStore)
  txHost = app.get(TransactionHost)
  await cleanRedis(redis)
  await ds.query('DELETE FROM iam_user WHERE username LIKE ?', [`${PREFIX}%`])
  for (const who of WHO) {
    const en = who === 'ben' || who === 'dan'
    u[who] = await insertRow(ds.manager, 'iam_user', {
      username: PREFIX + who,
      display_name: who,
      password_hash: 'not-used-by-this-spec',
      password_changed_at: new Date(),
      locale: en ? 'en-US' : 'zh-CN',
      timezone: en ? 'UTC' : 'Asia/Shanghai',
    })
    const { accessToken } = await signIn(app, PREFIX + who)
    got[who] = inbox(await connect(socketOf(app, { token: accessToken })))
  }
  await cleanup()
})

/** from now on: only later messages and pushes count */
async function markNow() {
  const [{ inbox: i, mail }] = await ds.query(
    `SELECT (SELECT COALESCE(MAX(id), 0) FROM msg_inbox) AS inbox,
            (SELECT COALESCE(MAX(id), 0) FROM msg_mail_record) AS mail`,
  )
  Object.assign(mark, { inbox: Number(i), mail: Number(mail) })
  await settle()
  for (const who of WHO) got[who].length = 0
}

beforeEach(markNow)

afterAll(async () => {
  closeSockets()
  if (ds) {
    await cleanup()
    await ds.query('DELETE FROM iam_user WHERE username LIKE ?', [`${PREFIX}%`])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

describe('templates', () => {
  it('seeds the nine codes for inbox and mail in both languages, enabled, named by seed keys; no SMS', async () => {
    for (const table of ['msg_inbox_template', 'msg_mail_template']) {
      const rows = await ds.query<{ code: string; locale: string; name: string }[]>(
        `SELECT code, locale, name FROM ${table} WHERE code IN (?) AND enabled = 1 ORDER BY code, locale`,
        [TEMPLATES],
      )
      expect(rows.map((r) => `${r.code} ${r.locale}`)).toEqual(
        [...TEMPLATES].sort().flatMap((c) => [...LOCALES].sort().map((l) => `${c} ${l}`)),
      )
      expect(rows.every((r) => r.name.startsWith('seed.wfTemplate.'))).toBe(true)
    }
    const [{ n }] = await ds.query(
      "SELECT COUNT(*) AS n FROM msg_sms_template WHERE code LIKE 'wf.%'",
    )
    expect(Number(n)).toBe(0)
  })
})

describe('start', () => {
  it('new to-dos → wf.task.assigned (inbox + mail) in each language and zone, typed params; notify node → wf.cc', async () => {
    const v = await publish([
      notify('n', u.dan),
      review('a', { name: HQ, assignee: { kind: 'users', ids: [u.ann, u.ben] } }),
    ])
    const id = await start(v)
    expect(await sent()).toEqual([
      ['ann', 'wf.task.assigned'],
      ['ben', 'wf.task.assigned'],
      ['dan', 'wf.cc'],
    ])
    // the model and node names translated, the start time in the recipient's zone
    expect(await inboxOf('ann')).toEqual({
      template_code: 'wf.task.assigned',
      locale: 'zh-CN',
      title: '待审批：init的员工',
      body: `init 于 2026-03-01 16:00 发起的员工（编号 ${id}）已到「总部」，等待您审批。`,
    })
    expect(await inboxOf('ben')).toEqual({
      template_code: 'wf.task.assigned',
      locale: 'en-US',
      title: 'Approval needed: Staff from init',
      body: `Staff #${id}, started by init at 2026-03-01 08:00, is waiting for your approval at "Headquarters".`,
    })
    expect((await inboxOf('dan'))!.title).toBe('CC: Staff from init')
    // the mail channel too (no address: recorded as skipped)
    const mails = await ds.query<{ user_id: number; template_code: string; subject: string }[]>(
      'SELECT user_id, template_code, subject, status FROM msg_mail_record WHERE id > ? AND user_id IN (?) ORDER BY id',
      [mark.mail, Object.values(u)],
    )
    expect(mails).toEqual([
      expect.objectContaining({ user_id: u.ann, subject: '待审批：init的员工', status: 'skipped' }),
      expect.objectContaining({ user_id: u.ben, subject: 'Approval needed: Staff from init' }),
      expect.objectContaining({ user_id: u.dan, template_code: 'wf.cc' }),
    ])
    // wf:task to the users whose to-dos changed, not to the cc
    await vi.waitFor(() => expect([pushes('ann'), pushes('ben')]).toEqual([[id], [id]]))
    await settle()
    expect([pushes('init'), pushes('dan')]).toEqual([[], []])
  })

  it('an admin text as the model name stays as it is', async () => {
    await start(await publish([review('a', { assignee: { kind: 'users', ids: [u.ben] } })], 'Trip'))
    expect((await inboxOf('ben'))!.title).toBe('Approval needed: Trip from init')
  })

  it('wf:task waits for the outermost commit (a savepoint commit is not it); a rollback sends nothing', async () => {
    const v = await publish([review('a', { assignee: { kind: 'users', ids: [u.ann] } })])
    let id = 0
    await cls.run(() =>
      txHost.withTransaction(async () => {
        await txHost.withTransaction(Propagation.Nested, async () => {
          id = (await store.start(input(v), T0)).inst.id
        })
        await settle()
        expect(pushes('ann')).toEqual([])
      }),
    )
    await vi.waitFor(() => expect(pushes('ann')).toEqual([id]))
    expect(await sent()).toEqual([['ann', 'wf.task.assigned']])

    got.ann.length = 0
    const boom = new Error('boom')
    await expect(
      cls.run(() =>
        txHost.withTransaction(async () => {
          await store.start(input(v), T0)
          throw boom
        }),
      ),
    ).rejects.toBe(boom)
    await settle()
    expect(pushes('ann')).toEqual([])
    expect(await sent()).toEqual([['ann', 'wf.task.assigned']])
  })
})

describe('actions', () => {
  const only = (...ids: number[]) => ({ assignee: { kind: 'users' as const, ids } })

  it('cancel: every pending assignee → wf.task.canceled; a waiting one (no to-do yet: not told at start either) nothing', async () => {
    const id = await start(await publish([review('a', { ...only(u.ann, u.ben), sign: 'ordered' })]))
    expect(await sent()).toEqual([['ann', 'wf.task.assigned']])
    await markNow()
    await act(id, (r) => cancel(r.ctx, r.inst, r.tasks, { comment: null }))
    expect(await sent()).toEqual([['ann', 'wf.task.canceled']])
    expect((await inboxOf('ann'))!.title).toBe('待办已取消：init的员工')
    await vi.waitFor(() => expect(pushes('ann')).toEqual([id]))
  })

  it('send back to begin → the initiator gets wf.instance.sent_back; the reviewer (the actor) nothing', async () => {
    const id = await start(await publish([review('a', only(u.ann))]))
    await markNow()
    await act(id, (r) =>
      sendBack(r.ctx, r.inst, r.tasks, taskOf(r, 'ann'), { to: 'begin', comment: null }),
    )
    expect(await sent()).toEqual([['init', 'wf.instance.sent_back']])
    expect((await inboxOf('init'))!.body).toBe(
      `您于 2026-03-01 16:00 发起的员工（编号 ${id}）已退回给您，请修改后重新提交，或撤销申请。`,
    )
    await vi.waitFor(() => expect([pushes('init'), pushes('ann')]).toEqual([[id], [id]]))
  })

  it('urge → every pending assignee gets wf.task.urged naming their step; to-dos unchanged: no wf:task', async () => {
    const id = await start(
      await publish([
        review('x', only(u.cat)),
        parallel('p', [review('a', only(u.ann)), review('b', { ...only(u.ben), name: HQ })]),
      ]),
    )
    // cat's task is done: no longer a to-do to urge
    await act(id, (r) => approve(r.ctx, r.inst, r.tasks, taskOf(r, 'cat'), { comment: null }))
    await markNow()
    await act(id, (r) => ({
      ...emptyChangeSet(),
      events: [event('urge', null, r.inst.initiatorId)],
    }))
    expect(await sent()).toEqual([
      ['ann', 'wf.task.urged'],
      ['ben', 'wf.task.urged'],
    ])
    expect((await inboxOf('ann'))!.body).toBe(`init 催您尽快处理员工（编号 ${id}）在「A」的待办。`)
    expect((await inboxOf('ben'))!.body).toBe(
      `init asks you to handle your to-do at "Headquarters" on Staff #${id} soon.`,
    )
    await settle()
    expect([pushes('ann'), pushes('ben')]).toEqual([[], []])
  })

  it('transfer: the new assignee gets wf.task.assigned, the actor nothing; reassign: the old one canceled', async () => {
    const id = await start(await publish([review('a', only(u.ann))]))
    await markNow()
    await act(id, (r) =>
      transfer(r.ctx, r.inst, r.tasks, taskOf(r, 'ann'), { to: u.ben, comment: null }),
    )
    expect(await sent()).toEqual([['ben', 'wf.task.assigned']])
    await markNow()
    await act(id, (r) =>
      reassign(r.ctx, r.inst, r.tasks, taskOf(r, 'ben'), {
        actorId: u.cat,
        to: u.dan,
        comment: null,
      }),
    )
    expect(await sent()).toEqual([
      ['ben', 'wf.task.canceled'],
      ['dan', 'wf.task.assigned'],
    ])
    await vi.waitFor(() => expect([pushes('ben'), pushes('dan')]).toEqual([[id], [id]]))
  })

  it('the end → wf.instance.approved / rejected to the initiator; co-reviewers of an `any` step lose their to-dos', async () => {
    const v = await publish([review('a', only(u.ann, u.ben))])
    const ok = await start(v)
    const no = await start(v)
    await markNow()
    await act(ok, (r) => approve(r.ctx, r.inst, r.tasks, taskOf(r, 'ann'), { comment: null }))
    expect(await sent()).toEqual([
      ['ben', 'wf.task.canceled'],
      ['init', 'wf.instance.approved'],
    ])
    expect((await inboxOf('init'))!.title).toBe('已通过：员工')
    await markNow()
    await act(no, (r) => reject(r.ctx, r.inst, r.tasks, taskOf(r, 'ben'), { comment: 'no' }))
    expect(await sent()).toEqual([
      ['ann', 'wf.task.canceled'],
      ['init', 'wf.instance.rejected'],
    ])
  })

  it('overdue (the remind job) → wf.task.overdue with the due time in the recipient zone', async () => {
    const id = await start(await publish([review('a', { ...only(u.ann), timeout: { hours: 2 } })]))
    await markNow()
    const task = await ds.getRepository(WfTaskRow).findOneByOrFail({ instanceId: id })
    await cls.run(() => txHost.withTransaction(() => app.get(WfNotify).overdue(task)))
    expect(await sent()).toEqual([['ann', 'wf.task.overdue']])
    expect((await inboxOf('ann'))!.body).toBe(
      `init 发起的员工（编号 ${id}）在「A」的待办已于 2026-03-01 18:00 到期，请尽快处理。`,
    )
  })
})
