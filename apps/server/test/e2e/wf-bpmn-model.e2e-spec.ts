// A BPMN model over /api/wf/models (–8). The draft is the XML as sent
// after the size, DOCTYPE and strict parse checks; a publish derives the tree from the XML (never the client's)
// and stores it with the normalized XML in one version, the same XML becoming the draft (`draft_json` stays
// null). Error contract: `errors[].path` = `xml.<element id>`, `xml` without one. Each flow kind takes its own
// body only; the 100 KB JSON body limit stays (413). A BPMN version runs as any tree: started, approved and
// finished through the approval center, its diagram in the instance detail for whoever may see the instance.
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { treeToXml, WF_BPMN_XML_MAX } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { WfHandlers } from '../../src/modules/workflow/runtime/wf-handlers.js'
import { cfg, fixture, type Fx } from '../fixtures/wf/bpmn-fixture.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const PREFIX = 'e2e-wfb-'
const MODELS = '/api/wf/models'
/** the form fields: the dynamic models' sent ones, the custom handler's */
const FIELDS = { days: 'number' } as const

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
const tokens: Record<string, string> = {}
const u: Record<string, number> = {}

/** a call in en-US (the messages the cases look for) */
const api = (who: string, method: 'get' | 'post' | 'put', path: string, body?: object) => {
  const req = request(app.getHttpServer())
    [method](path)
    .set({ ...bearer(tokens[who]!), 'Accept-Language': 'en-US' })
  return body ? req.send(body) : req
}
let seq = 0
/** a BPMN model (dynamic unless `over` says otherwise) */
const add = async (over: object = {}) =>
  (
    await api('admin', 'post', MODELS, {
      modelKey: `${PREFIX}${++seq}`,
      name: 'Leave',
      formKind: 'dynamic',
      flowKind: 'bpmn',
      ...over,
    }).expect(201)
  ).body.data
const detail = async (id: number) =>
  (await api('admin', 'get', `${MODELS}/${id}`).expect(200)).body.data
const draft = (id: number, body: object) => api('admin', 'put', `${MODELS}/${id}/draft`, body)
const publish = (id: number, body: object) => api('admin', 'post', `${MODELS}/${id}/versions`, body)
const versionsOf = async (id: number) =>
  (await api('admin', 'get', `${MODELS}/${id}/versions`).expect(200)).body.data
const versionRow = async (id: number) =>
  (
    await ds.query<{ tree_json: object; bpmn_xml: string | null }[]>(
      'SELECT tree_json, bpmn_xml FROM wf_version WHERE id = ?',
      [id],
    )
  )[0]!

/** begin → exclusive `by-days`: `days > 3` (path `long`) bob reviews (`r1`), else (`other`) nothing */
const xmlOf = () =>
  treeToXml({
    id: 'begin',
    type: 'begin',
    name: 'Begin',
    next: {
      id: 'by-days',
      type: 'fork',
      name: 'Days',
      mode: 'exclusive',
      paths: [
        {
          id: 'long',
          name: 'Long',
          when: [[{ field: 'days', op: 'gt', value: 3 }]],
          child: { id: 'r1', type: 'review', name: 'Review', ...settings(u.bob!) },
        },
        { id: 'other', name: 'Other', fallback: true, when: [] },
      ],
    },
  })
/** a review's settings (`qw:Config`) */
const settings = (userId: number) => ({
  assignee: { kind: 'users' as const, ids: [userId] },
  sign: 'any' as const,
  whenNobody: 'autoPass' as const,
  whenInitiatorIsReviewer: 'self' as const,
  onReject: 'finish' as const,
})
/** start → R1 (named, set up) → end */
const base = (more: Partial<Fx> = {}) =>
  fixture({
    flows: 'S>R1>E1',
    ...more,
    names: { R1: 'Review', ...more.names },
    inner: { R1: cfg(settings(1)), ...more.inner },
  })

/** the custom models' business handler (`WfHandlers.get` stubbed: real keys come from decorators) */
const handled = new Set<string>()
const states: string[] = []
const handler = {
  fields: () => ({ ...FIELDS }),
  assertStartable: async () => {},
  loadFormValues: async () => ({ days: 5 }),
  onStateChange: async (inst: { state: string }) => {
    states.push(inst.state)
  },
}

async function user(name: string) {
  u[name] = await insertRow(ds.manager, 'iam_user', {
    username: PREFIX + name,
    display_name: name,
    password_hash: 'not-used-by-this-spec',
    password_changed_at: new Date(),
  })
  tokens[name] = (await signIn(app, PREFIX + name)).accessToken
}

async function cleanup() {
  const sub = `SELECT id FROM wf_instance WHERE model_key LIKE '${PREFIX}%'`
  for (const t of ['wf_task', 'wf_cc', 'wf_event'])
    await ds.query(`DELETE FROM ${t} WHERE instance_id IN (${sub})`)
  for (const t of ['wf_instance', 'wf_version', 'wf_model'])
    await ds.query(`DELETE FROM ${t} WHERE model_key LIKE ?`, [`${PREFIX}%`])
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  vi.spyOn(app.get(WfHandlers), 'get').mockImplementation((k) =>
    handled.has(k) ? handler : undefined,
  )
  await cleanRedis(redis)
  await cleanup()
  // alice starts, bob reviews, mallory has no wf permission and no part in any instance
  for (const name of ['alice', 'bob', 'mallory']) await user(name)
  tokens.admin = (await signIn(app)).accessToken
})

afterAll(async () => {
  if (ds) {
    await cleanup()
    const ids = Object.values(u)
    if (ids.length) await ds.query('DELETE FROM iam_user WHERE id IN (?)', [ids])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

describe('draft and publish', () => {
  it('draft as sent → publish: tree_json and the normalized bpmn_xml in one version, which is the draft now', async () => {
    const m = await add()
    expect(m.flowKind).toBe('bpmn')
    expect(await detail(m.id)).toMatchObject({ flowKind: 'bpmn', draftJson: null, draftXml: null })
    const xml = xmlOf()
    await draft(m.id, { xml }).expect(200)
    expect((await detail(m.id)).draftXml).toBe(xml)
    // no xml in the body: the draft's
    const v1 = (await publish(m.id, { fields: FIELDS }).expect(201)).body.data
    expect(v1).toMatchObject({ version: 1, formSnapshot: { fields: FIELDS } })
    const row = await versionRow(v1.id)
    expect(row.tree_json).toEqual({
      id: 'begin',
      type: 'begin',
      name: 'Begin',
      next: {
        id: 'by-days',
        type: 'fork',
        name: 'Days',
        mode: 'exclusive',
        paths: [
          {
            id: 'long',
            name: 'Long',
            when: [[{ field: 'days', op: 'gt', value: 3 }]],
            child: { id: 'r1', type: 'review', name: 'Review', ...settings(u.bob!) },
          },
          { id: 'other', name: 'Other', fallback: true, when: [] },
        ],
      },
    })
    // normalized: the references bpmn-js writes, rebuilt from the flows
    expect(row.bpmn_xml).not.toBe(xml)
    expect(row.bpmn_xml).toContain('<bpmn:outgoing>long</bpmn:outgoing>')
    expect(await detail(m.id)).toMatchObject({
      currentVersionId: v1.id,
      draftJson: null,
      draftXml: row.bpmn_xml,
    })
    const vo = (await api('admin', 'get', `${MODELS}/${m.id}/versions/${v1.id}`).expect(200)).body
      .data
    expect(vo).toMatchObject({ tree: row.tree_json, bpmnXml: row.bpmn_xml })
  })

  it('xml in the body over the draft; neither (or an empty one) → 400 bpmn_parse; the stored XML publishes as it is', async () => {
    const m = await add()
    for (const body of [{}, { xml: '' }]) {
      const res = await publish(m.id, { ...body, fields: FIELDS }).expect(400)
      expect(res.body.errors).toEqual([
        { path: 'xml', msg: expect.stringContaining('cannot be read') },
      ])
    }
    const v1 = (await publish(m.id, { xml: xmlOf(), fields: FIELDS }).expect(201)).body.data
    const v2 = (await publish(m.id, { fields: FIELDS }).expect(201)).body.data
    const first = await versionRow(v1.id)
    expect(await versionRow(v2.id)).toEqual(first)
    expect((await detail(m.id)).draftXml).toBe(first.bpmn_xml)
  })

  it('a draft over 80 KiB, with a DOCTYPE or unreadable → 400 at xml, for a publish too; the saved draft stays', async () => {
    const m = await add()
    const xml = xmlOf()
    await draft(m.id, { xml }).expect(200)
    const cases: [string, string][] = [
      // 2 bytes a character: within the body schema's character count, over the byte limit
      [
        xml.replace('</bpmn:process>', `<!--${'é'.repeat(WF_BPMN_XML_MAX / 2)}--></bpmn:process>`),
        'at most 80 KiB',
      ],
      [xml.replace('?>', '?><!doctype d [<!ENTITY x "y">]>'), 'DOCTYPE'],
      [xml.replace('</bpmn:process>', '<bpmn:fooTask id="x"/></bpmn:process>'), 'cannot be read'],
      [xml.replace('id="r1"', 'id="begin"'), 'cannot be read'],
      ['<bpmn:definitions', 'cannot be read'],
    ]
    for (const [bad, text] of cases) {
      const errors = [{ path: 'xml', msg: expect.stringContaining(text) }]
      expect((await draft(m.id, { xml: bad }).expect(400)).body.errors).toEqual(errors)
      const res = await publish(m.id, { xml: bad, fields: FIELDS }).expect(400)
      expect(res.body.errors).toEqual(errors)
    }
    expect((await detail(m.id)).draftXml).toBe(xml)
    expect(await versionsOf(m.id)).toEqual([])
  })

  it('a refused diagram → 400 at xml.<element id>, nothing published', async () => {
    const m = await add()
    const cases: [string, string, string][] = [
      ['a loop', fixture({ flows: 'S>XJ>R1>X1>E1 X1>XJ' }), 'XJ'],
      ['a join of another type', fixture({ flows: 'S>X1>R1>PJ>E1 X1>R2>PJ' }), 'X1'],
      ['two start events', fixture({ flows: 'S>R1>E1 S2>R2>E2' }), 'S2'],
      ['a script task', fixture({ flows: 'S>T1>E1' }), 'T1'],
      // `${` entity encoded: caught after the parse
      ['an expression', base({ names: { R1: '&#36;&#123;x}' } }), 'R1'],
      [
        'settings carrying a hidden next step',
        base({
          inner: {
            R1: cfg({
              ...settings(1),
              next: {
                id: 'hidden',
                type: 'notify',
                name: 'Copy',
                assignee: { kind: 'users', ids: [42] },
              },
            }),
          },
        }),
        'R1',
      ],
    ]
    for (const [name, xml, id] of cases) {
      const res = await publish(m.id, { xml, fields: FIELDS }).expect(400)
      expect([name, res.body.errors]).toEqual([
        name,
        [{ path: `xml.${id}`, msg: expect.any(String) }],
      ])
    }
    // compile (rule ⑫): a review without settings, its errors at the element as well
    const res = await publish(m.id, { xml: base({ inner: { R1: '' } }), fields: FIELDS }).expect(
      400,
    )
    expect(res.body.errors.length).toBeGreaterThan(0)
    for (const e of res.body.errors) expect(e.path).toBe('xml.R1')
    expect(await versionsOf(m.id)).toEqual([])
    expect((await detail(m.id)).currentVersionId).toBeNull()
  })

  it("a flow kind takes its own body only (400 at the other's field); an update keeps the flow kind", async () => {
    const bpmn = await add()
    const tree = { id: 'begin', type: 'begin', name: 'Begin' }
    const xml = xmlOf()
    const at = (path: string) => [{ path, msg: expect.any(String) }]
    expect((await draft(bpmn.id, { tree }).expect(400)).body.errors).toEqual(at('tree'))
    const both = { tree, xml, fields: FIELDS }
    expect((await publish(bpmn.id, both).expect(400)).body.errors).toEqual(at('tree'))
    const plain = await add({ flowKind: undefined })
    expect(plain.flowKind).toBe('tree')
    expect((await draft(plain.id, { xml }).expect(400)).body.errors).toEqual(at('xml'))
    const res = await publish(plain.id, { xml, fields: FIELDS }).expect(400)
    expect(res.body.errors).toEqual(at('xml'))
    expect(await detail(plain.id)).toMatchObject({ draftJson: null, draftXml: null })
    await api('admin', 'put', `${MODELS}/${bpmn.id}`, { flowKind: 'tree', name: 'Renamed' }).expect(
      200,
    )
    expect(await detail(bpmn.id)).toMatchObject({ flowKind: 'bpmn', name: 'Renamed' })
  })

  it('a body over 100 KB → 413: the global JSON limit is not widened', async () => {
    const m = await add()
    // within the schema's character count, 2 bytes a character in the JSON body
    const xml = 'é'.repeat(60_000)
    await draft(m.id, { xml }).expect(413)
    await publish(m.id, { xml, fields: FIELDS }).expect(413)
  })

  it('without wf.model permissions → 403', async () => {
    const m = await add()
    await api('mallory', 'get', `${MODELS}/${m.id}`).expect(403)
    await api('mallory', 'put', `${MODELS}/${m.id}/draft`, { xml: xmlOf() }).expect(403)
    await api('mallory', 'post', `${MODELS}/${m.id}/versions`, { xml: xmlOf() }).expect(403)
    expect(await detail(m.id)).toMatchObject({ draftXml: null, currentVersionId: null })
  })
})

describe('running a BPMN version', () => {
  it('dynamic and custom: started, approved and finished through the approval center; the diagram in the detail', async () => {
    const dynamic = await add()
    const custom = await add({
      formKind: 'custom',
      createRoute: '/biz/leave/new',
      viewComponent: 'biz/leave/view',
    })
    handled.add(custom.modelKey)
    const runs: [string, number, object][] = [
      [
        dynamic.modelKey,
        (await publish(dynamic.id, { xml: xmlOf(), fields: FIELDS }).expect(201)).body.data.id,
        { formValues: { days: 5 } },
      ],
      // the handler's fields; its business row says 5 days
      [
        custom.modelKey,
        (await publish(custom.id, { xml: xmlOf() }).expect(201)).body.data.id,
        { businessKey: '7' },
      ],
    ]
    for (const [modelKey, versionId, body] of runs) {
      const start = api('alice', 'post', '/api/wf/instances', { modelKey, ...body })
      const id = (await start.expect(201)).body.data.id as number
      const [task] = await ds.query<{ id: number }[]>(
        "SELECT id FROM wf_task WHERE instance_id = ? AND assignee_id = ? AND state = 'pending'",
        [id, u.bob],
      )
      // days > 3: bob's review on the `long` path; he sees the version's diagram, nobody unrelated sees any
      const version = await versionRow(versionId)
      const seen = (await api('bob', 'get', `/api/wf/instances/${id}`).expect(200)).body.data
      expect(seen).toMatchObject({ tree: version.tree_json, bpmnXml: version.bpmn_xml })
      expect(seen.bpmnXml).toContain('bpmn:definitions')
      await api('mallory', 'get', `/api/wf/instances/${id}`).expect(404)
      await api('bob', 'post', `/api/wf/tasks/${task!.id}/approve`, {}).expect(200)
      const [inst] = await ds.query<{ state: string }[]>(
        'SELECT state FROM wf_instance WHERE id = ?',
        [id],
      )
      expect([modelKey, inst!.state]).toEqual([modelKey, 'approved'])
      const mine = (await api('alice', 'get', `/api/wf/instances/${id}`).expect(200)).body.data
      expect(mine.bpmnXml).toBe(version.bpmn_xml)
    }
    // the custom model's business row followed the instance
    expect(states.at(-1)).toBe('approved')
  })

  it('a tree version has no diagram in the detail', async () => {
    const m = await add({ flowKind: 'tree' })
    const tree = {
      id: 'begin',
      type: 'begin',
      name: 'Begin',
      next: { id: 'r1', type: 'review', name: 'Review', ...settings(u.bob!) },
    }
    await publish(m.id, { tree, fields: FIELDS }).expect(201)
    const res = await api('alice', 'post', '/api/wf/instances', { modelKey: m.modelKey }).expect(
      201,
    )
    const seen = await api('bob', 'get', `/api/wf/instances/${res.body.data.id}`).expect(200)
    expect(seen.body.data).toMatchObject({ tree, bpmnXml: null })
  })
})
