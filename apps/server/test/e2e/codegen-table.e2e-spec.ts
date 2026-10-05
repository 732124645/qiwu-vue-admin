// codegen.table (contract packages/shared/src/platform/codegen/codegen-api.schema.ts; see docs/design-notes.md#codegen): the
// generator page's API. Configs: list with filters, importable tables (no framework or imported ones),
// import (all or none), detail, save with the identifier whitelist, sync, delete one / many. Output:
// preview (the golden files byte for byte), zip download of one or many configs (two rendering one
// path → 422 C3006), workspace write only where NODE_ENV=development && CODEGEN_WRITE=true (else 422
// C3005; existing files are never overwritten: identical → unchanged, different → per-file diffs and
// nothing written). 403 per perm, 400 / 404, @ActionLog rows, Swagger. The write cases touch only files
// that exist identical in the repository (the golden demo_book), so nothing is ever written.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { codegenPerms, Err } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { runSeeds } from '../../src/db/seeds/index.js'
import { findId, insertRow } from '../../src/db/seeds/upsert.js'
import { hasMobile, MOBILE } from '../../src/modules/platform/codegen/workspace.js'
import { logOf } from '../setup/audit.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const PREFIX = 'e2e-codegen-'
const URL = '/api/codegen/tables'
const MISSING = 999_999
/** Repository root (tests run with cwd = apps/server). */
const ROOT = join(process.cwd(), '../..')

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
const tokens: Record<'admin' | 'reader' | 'plain', string> = { admin: '', reader: '', plain: '' }
const userIds: number[] = []
const menuIds: number[] = []
let roleId: number
/** the table's last id before this spec: every config above it is this spec's (cleanup) */
let lastId = 0
/** configs of the golden modules, by table */
const cg: Record<string, number> = {}

const call = (
  who: keyof typeof tokens,
  method: 'get' | 'post' | 'put' | 'delete',
  path = '',
  body?: object,
) => {
  const req = request(app.getHttpServer())[method](`${URL}${path}`).set(bearer(tokens[who]))
  return body ? req.send(body) : req
}
const data = (res: request.Response) => res.body.data

/** A binary response body as a Buffer. */
const binary = (r: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = []
  r.on('data', (c: Buffer) => chunks.push(c))
  r.on('end', () => cb(null, Buffer.concat(chunks)))
}
const download = (ids: string) =>
  call('admin', 'get', '/download').query({ ids }).buffer(true).parse(binary)

/** The menu action row of `perms` (seeded with the generator page's menus; added here while missing). */
async function permMenu(perms: string): Promise<number> {
  const id = await findId(ds.manager, 'iam_menu', { kind: 'action', perms })
  if (id !== undefined) return id
  const added = await insertRow(ds.manager, 'iam_menu', { kind: 'action', perms, name: perms })
  menuIds.push(added)
  return added
}

async function user(name: string, roles: number[]) {
  const id = await insertRow(ds.manager, 'iam_user', {
    username: PREFIX + name,
    display_name: name,
    password_hash: 'not-used-by-this-spec',
    password_changed_at: new Date(),
  })
  for (const r of roles)
    await ds.query('INSERT INTO iam_user_roles (user_id, role_id) VALUES (?, ?)', [id, r])
  userIds.push(id)
  return (await signIn(app, PREFIX + name)).accessToken
}

/** Deletes this spec's configs with their columns, for good. */
const dropMine = async () => {
  await ds.query('DELETE FROM cg_column WHERE table_id > ?', [lastId])
  await ds.query('DELETE FROM cg_table WHERE id > ?', [lastId])
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  await cleanRedis(redis)
  // the golden configs as seeded (other specs clear cg_table)
  await runSeeds(ds, ['codegen'])
  for (const r of await ds.query('SELECT id, table_name AS t FROM cg_table'))
    cg[r.t as string] = r.id as number
  lastId = Number((await ds.query('SELECT COALESCE(MAX(id), 0) AS n FROM cg_table'))[0].n)
  roleId = await insertRow(ds.manager, 'iam_role', {
    code: `${PREFIX}reader`,
    name: `${PREFIX}reader`,
    data_scope: 'all',
  })
  await ds.query('INSERT INTO iam_role_menus (role_id, menu_id) VALUES (?, ?)', [
    roleId,
    await permMenu(codegenPerms.browse),
  ])
  for (const perms of Object.values(codegenPerms)) await permMenu(perms)
  tokens.admin = (await signIn(app)).accessToken
  tokens.reader = await user('reader', [roleId])
  tokens.plain = await user('plain', [])
})

afterAll(async () => {
  vi.unstubAllEnvs()
  if (ds) {
    await dropMine()
    // the golden configs as seeded again (cases below edit some)
    await runSeeds(ds, ['codegen'])
    if (userIds.length) {
      await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [userIds])
      await ds.query('DELETE FROM iam_user WHERE id IN (?)', [userIds])
    }
    await ds.query('DELETE FROM iam_role_menus WHERE role_id = ?', [roleId])
    await ds.query('DELETE FROM iam_role WHERE id = ?', [roleId])
    if (menuIds.length) await ds.query('DELETE FROM iam_menu WHERE id IN (?)', [menuIds])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

describe('configs', () => {
  it('list: the imported configs, table name / comment contain (wildcards literal), paging', async () => {
    const res = await call('admin', 'get')
      .query({ tableName: 'demo_', sort: 'tableName' })
      .expect(200)
    expect(data(res).items.map((t: { tableName: string }) => t.tableName)).toEqual([
      'demo_book',
      'demo_invoice',
      'demo_invoice_line',
      'demo_topic',
    ])
    expect(data(res).items[0]).toMatchObject({
      id: cg.demo_book,
      groupCode: 'biz',
      template: 'crud',
    })
    expect(data(await call('admin', 'get').query({ tableName: 'demo%' }).expect(200)).total).toBe(0)
    expect(
      data(await call('admin', 'get').query({ tableComment: '图书', pageSize: 1 }).expect(200)),
    ).toMatchObject({ total: 1, items: [{ tableName: 'demo_book' }] })
  })

  it('detail: the config with its columns in sort order', async () => {
    const book = data(await call('admin', 'get', `/${cg.demo_book}`).expect(200))
    expect(book).toMatchObject({ tableName: 'demo_book', className: 'Book', masterTableId: null })
    expect(book.columns.map((c: { columnName: string }) => c.columnName).slice(0, 3)).toEqual([
      'id',
      'isbn',
      'title',
    ])
    const line = data(await call('admin', 'get', `/${cg.demo_invoice_line}`).expect(200))
    expect(line).toMatchObject({ masterTableId: cg.demo_invoice, subFkCol: 'invoice_id' })
  })

  it('importable: base tables not imported yet, never meta_ / test_ / cg_; import all or none; sync; delete one and many', async () => {
    const names = data(await call('admin', 'get', '/importable').expect(200)).map(
      (t: { tableName: string }) => t.tableName,
    )
    expect(names).toContain('iam_role')
    for (const hidden of ['demo_book', 'cg_table', 'cg_column', 'meta_migrations'])
      expect(names).not.toContain(hidden)
    expect(names.filter((n: string) => /^(meta|test|cg)_/.test(n))).toEqual([])

    // one name not importable: nothing imported
    for (const bad of [['iam_role', 'cg_table'], ['iam_role', 'demo_book'], ['nope']]) {
      const res = await call('admin', 'post', '/import', { tableNames: bad }).expect(422)
      expect(res.body.code).toBe(Err.CODEGEN_TABLE_UNAVAILABLE.code)
    }
    expect(data(await call('admin', 'get').query({ tableName: 'iam_role' })).total).toBe(0)

    const { ids } = data(
      await call('admin', 'post', '/import', { tableNames: ['iam_role', 'iam_dept'] }).expect(200),
    )
    expect(ids).toHaveLength(2)
    const role = data(await call('admin', 'get', `/${ids[0]}`).expect(200))
    expect(role).toMatchObject({ tableName: 'iam_role', className: 'Role', template: 'crud' })
    expect(data(await call('admin', 'get', `/${ids[1]}`))).toMatchObject({ template: 'tree' })
    // the DDL unchanged: nothing to sync
    expect(data(await call('admin', 'post', `/${ids[0]}/sync`).expect(200))).toEqual({
      added: [],
      removed: [],
      changed: [],
    })
    // a column removed from the config comes back with sync
    await ds.query("DELETE FROM cg_column WHERE table_id = ? AND column_name = 'note'", [ids[0]])
    expect(data(await call('admin', 'post', `/${ids[0]}/sync`).expect(200)).added).toEqual(['note'])

    await call('admin', 'delete', `/${ids[0]}`).expect(200)
    await call('admin', 'post', '/batch-delete', { ids: [ids[1]] }).expect(200)
    // soft: the configs stay marked deleted, their columns with them (the reference registry's cascade)
    expect(
      await ds.query('SELECT id FROM cg_table WHERE id IN (?) AND deleted_at IS NULL', [ids]),
    ).toEqual([])
    expect(await ds.query('SELECT id FROM cg_table WHERE id IN (?)', [ids])).toHaveLength(2)
    expect(
      await ds.query('SELECT id FROM cg_column WHERE table_id IN (?) AND deleted_at IS NULL', [
        ids,
      ]),
    ).toEqual([])
  })

  it('save: the fields and columns sent; identifiers outside the whitelist → 400, nothing saved', async () => {
    const { ids } = data(
      await call('admin', 'post', '/import', { tableNames: ['iam_user_pref'] }).expect(200),
    )
    const [id] = ids
    const before = data(await call('admin', 'get', `/${id}`))
    const column = before.columns.find((c: { columnName: string }) => c.columnName === 'pref_key')
    await call('admin', 'put', `/${id}`, {
      featureName: 'prefs',
      columns: [{ id: column.id, fieldName: 'prefKey2', inQuery: true }],
    }).expect(200)
    const after = data(await call('admin', 'get', `/${id}`))
    expect(after.featureName).toBe('prefs')
    expect(after.columns.find((c: { id: number }) => c.id === column.id)).toMatchObject({
      fieldName: 'prefKey2',
      inQuery: true,
    })
    for (const [body, path] of [
      [{ className: 'Pref;evil()' }, 'className'],
      [{ className: 'Pref*/' }, 'className'],
      [{ business: '../x' }, 'business'],
      [{ domain: 'Iam' }, 'domain'],
      [{ parentMenuRouteName: 'a b' }, 'parentMenuRouteName'],
      [{ options: { menuIcon: 'lucide:x"><script>' } }, 'options'],
      [{ columns: [{ id: column.id, fieldName: 'a-b' }] }, 'columns'],
      [{ columns: [{ id: column.id, dictCode: "x'); drop" }] }, 'columns'],
    ] as const) {
      const res = await call('admin', 'put', `/${id}`, { featureName: 'changed', ...body }).expect(
        400,
      )
      expect(res.body.code).toBe(Err.VALIDATION_FAILED.code)
      expect(res.body.errors[0].path).toMatch(new RegExp(`^${path}`))
    }
    // a column of another config → 404
    const book = data(await call('admin', 'get', `/${cg.demo_book}`))
    await call('admin', 'put', `/${id}`, {
      columns: [{ id: book.columns[0].id, inList: false }],
    }).expect(404)
    expect(data(await call('admin', 'get', `/${id}`)).featureName).toBe('prefs')
    // a sub-table link to no other config / to itself / to a config not of template master_sub → 422 C3007
    for (const link of [
      { masterTableId: id, subFkCol: 'user_id' },
      { masterTableId: MISSING, subFkCol: 'user_id' },
      { masterTableId: cg.demo_book, subFkCol: 'user_id' },
    ]) {
      const res = await call('admin', 'put', `/${id}`, link).expect(422)
      expect(res.body.code).toBe(Err.CODEGEN_SUB_TABLES.code)
    }
    // the parent menu: never cleared (400), a group menu's route name (a page's or none → 422 C3008)
    await call('admin', 'put', `/${id}`, { parentMenuRouteName: null }).expect(400)
    for (const name of ['iam-user', 'no-such-menu']) {
      const res = await call('admin', 'put', `/${id}`, { parentMenuRouteName: name }).expect(422)
      expect(res.body).toMatchObject({ code: Err.CODEGEN_PARENT_MENU.code })
    }
    await call('admin', 'put', `/${id}`, { parentMenuRouteName: 'devtools' }).expect(200)
    expect(data(await call('admin', 'get', `/${id}`)).parentMenuRouteName).toBe('devtools')
    // The uni-app pages option, a boolean
    await call('admin', 'put', `/${id}`, { options: { withMobile: true } }).expect(200)
    expect(data(await call('admin', 'get', `/${id}`)).options).toMatchObject({ withMobile: true })
    const res = await call('admin', 'put', `/${id}`, { options: { withMobile: 'yes' } }).expect(400)
    expect(res.body.errors[0].path).toMatch(/^options/)
  })

  it('parent menus: every group menu as a forest (devtools → demo), each marked pickable', async () => {
    const forest = data(await call('admin', 'get', '/parent-menus').expect(200))
    const devtools = forest.find((n: { routeName: string }) => n.routeName === 'devtools')
    expect(devtools).toMatchObject({
      name: 'menu.devtools.title',
      nameI18n: null,
      pickable: true,
      reason: null,
    })
    expect(devtools.children.map((n: { routeName: string }) => n.routeName)).toEqual(['demo'])
    expect(forest.map((n: { routeName: string }) => n.routeName)).toContain('system')
  })
})

describe('output', { timeout: 60_000 }, () => {
  it('preview: every file as pnpm gen render prints it (the golden module byte for byte), its language, the registration lines', async () => {
    // iam_position: a G0 module at its generated path whatever the project-domain moves of the demo modules
    const { files, registration } = data(
      await call('admin', 'get', `/${cg.iam_position}/preview`).expect(200),
    )
    expect(files.length).toBeGreaterThanOrEqual(11)
    for (const f of files) {
      expect(f.content).toBe(readFileSync(join(ROOT, f.path), 'utf8'))
      expect(f.language).toBe(
        { ts: 'typescript', vue: 'vue', json: 'json' }[f.path.split('.').pop() as string],
      )
    }
    expect(files.map((f: { path: string }) => f.path)).toContain(
      'apps/server/src/modules/platform/iam/position/position.entity.ts',
    )
    expect(registration.join('\n')).toContain('PositionModule')
    // a master-sub master renders its sub tables too
    const invoice = data(await call('admin', 'get', `/${cg.demo_invoice}/preview`).expect(200))
    expect(invoice.files.map((f: { path: string }) => f.path)).toContain(
      'apps/server/src/modules/demo/invoice/invoice-line.entity.ts',
    )
  })

  // A withMobile config (the seeded demo_book) also renders its uni-app pages; PC only (no mobile/): none
  it('preview and download: a withMobile config’s uni-app pages where the repository has the client', async () => {
    const { files, registration } = data(
      await call('admin', 'get', `/${cg.demo_book}/preview`).expect(200),
    )
    const paths: string[] = files.map((f: { path: string }) => f.path)
    const mobile = paths.filter((p) => p.startsWith(MOBILE))
    if (!hasMobile()) return expect(mobile).toEqual([])
    expect(mobile).toEqual([
      `${MOBILE}api/demo/book.ts`,
      `${MOBILE}pages-biz/demo/book/index.vue`,
      `${MOBILE}pages-biz/demo/book/detail.vue`,
      `${MOBILE}pages-biz/demo/book/form.vue`,
      `${MOBILE}locales/zh-CN/demo.book.json`,
      `${MOBILE}locales/en-US/demo.book.json`,
    ])
    for (const f of files.filter((f: { path: string }) => f.path.startsWith(MOBILE)))
      expect(f.content).toBe(readFileSync(join(ROOT, f.path), 'utf8'))
    expect(registration).toContain('  { "path": "demo/book/form", "style": {} }')
    const zip = (await download(String(cg.demo_book)).expect(200)).body as Buffer
    expect(zip.includes(Buffer.from(`${MOBILE}pages-biz/demo/book/index.vue`))).toBe(true)
  })

  it('preview refuses a stored identifier outside the whitelist → 422 C3002', async () => {
    await ds.query('UPDATE cg_table SET class_name = ? WHERE id = ?', ['Book;evil()', cg.demo_book])
    try {
      const res = await call('admin', 'get', `/${cg.demo_book}/preview`).expect(422)
      expect(res.body.code).toBe(Err.CODEGEN_IDENTIFIER_INVALID.code)
      expect((await download(String(cg.demo_book))).status).toBe(422)
    } finally {
      await ds.query('UPDATE cg_table SET class_name = ? WHERE id = ?', ['Book', cg.demo_book])
    }
  })

  it('download: one zip (non-empty) of one or many configs at their repository paths', async () => {
    const res = await download(`${cg.demo_book},${cg.demo_topic}`).expect(200)
    expect(res.headers['content-type']).toBe('application/zip')
    expect(res.headers['content-disposition']).toBe('attachment; filename="codegen.zip"')
    const zip = res.body as Buffer
    expect(zip.length).toBeGreaterThan(1000)
    expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    // the entry names are stored as they are
    for (const path of [
      'apps/server/src/modules/demo/book/book.service.ts',
      'apps/web/src/views/demo/topic/index.vue',
    ])
      expect(zip.includes(Buffer.from(path))).toBe(true)
    // the same bytes each time (fixed entry dates)
    expect((await download(`${cg.demo_book},${cg.demo_topic}`)).body).toEqual(zip)
  })

  it('download: two configs rendering one path → 422 C3006; bad or unknown ids → 400 / 404', async () => {
    await ds.query("UPDATE cg_table SET business = 'book' WHERE id = ?", [cg.demo_topic])
    try {
      const res = await download(`${cg.demo_book},${cg.demo_topic}`).expect(422)
      expect(JSON.parse(res.body.toString())).toMatchObject({
        code: Err.CODEGEN_PATH_CONFLICT.code,
      })
    } finally {
      await ds.query("UPDATE cg_table SET business = 'topic' WHERE id = ?", [cg.demo_topic])
    }
    for (const ids of ['', 'x', '0', `1,`]) expect((await download(ids)).status).toBe(400)
    expect((await download(`${cg.demo_book},${MISSING}`)).status).toBe(404)
  })

  it('write: refused where the server is not a development one with CODEGEN_WRITE=true → 422 C3005', async () => {
    expect(data(await call('admin', 'get', '/writable').expect(200))).toEqual({ writable: false })
    for (const env of [
      { NODE_ENV: 'test', CODEGEN_WRITE: 'true' },
      { NODE_ENV: 'development', CODEGEN_WRITE: 'false' },
      { NODE_ENV: 'production', CODEGEN_WRITE: 'true' },
    ]) {
      vi.stubEnv('NODE_ENV', env.NODE_ENV)
      vi.stubEnv('CODEGEN_WRITE', env.CODEGEN_WRITE)
      try {
        const res = await call('admin', 'post', '/write', { ids: [cg.demo_book] }).expect(422)
        expect(res.body.code).toBe(Err.CODEGEN_WRITE_DISABLED.code)
      } finally {
        vi.unstubAllEnvs()
      }
    }
  })

  it('write (development): identical files unchanged, differing ones → their diffs and nothing written', async () => {
    // iam_position: every file committed at its generated path, so nothing is ever written here
    const entity = 'apps/server/src/modules/platform/iam/position/position.entity.ts'
    const locale = 'apps/web/src/locales/zh-CN/iam.position.json'
    const onDisk = readFileSync(join(ROOT, locale), 'utf8')
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('CODEGEN_WRITE', 'true')
    try {
      expect(data(await call('admin', 'get', '/writable'))).toEqual({ writable: true })
      const ids = [cg.iam_position]
      const same = data(await call('admin', 'post', '/write', { ids }).expect(200))
      expect(same.written).toEqual([])
      expect(same.conflicts).toEqual([])
      expect(same.unchanged).toContain(entity)
      expect(same.registration.join('\n')).toContain('PositionModule')

      const position = data(await call('admin', 'get', `/${cg.iam_position}`))
      await call('admin', 'put', `/${cg.iam_position}`, {
        featureNameI18n: { ...position.featureNameI18n, 'zh-CN': '岗位管理（改）' },
      }).expect(200)
      const changed = data(
        await call('admin', 'post', '/write', { ids: [...ids, ...ids] }).expect(200),
      )
      expect(changed.written).toEqual([])
      expect(changed.conflicts.map((c: { path: string }) => c.path)).toContain(locale)
      const diff = changed.conflicts.find((c: { path: string }) => c.path === locale).diff
      expect(diff).toMatch(new RegExp(`^--- a/${locale}\\n\\+\\+\\+ b/${locale}\\n@@`))
      expect(diff).not.toContain('qw-codegen-diff-')
      expect(diff).not.toContain('diff --git')
      expect(diff).not.toContain(ROOT)
      expect(diff).toMatch(/^\+\s+"position": "岗位管理（改）"$/m)
      expect(readFileSync(join(ROOT, locale), 'utf8')).toBe(onDisk)
    } finally {
      vi.unstubAllEnvs()
      await runSeeds(ds, ['codegen'])
    }
  })
})

describe('errors', () => {
  it('403 per permission: browse-only may list and ask whether writing is on, nothing else; no perm → no list', async () => {
    const id = cg.demo_book
    await call('reader', 'get').expect(200)
    await call('reader', 'get', '/writable').expect(200)
    const forbidden = [
      call('reader', 'get', `/${id}`),
      call('reader', 'get', '/importable'),
      call('reader', 'get', '/parent-menus'),
      call('reader', 'post', '/import', { tableNames: ['iam_role'] }),
      call('reader', 'put', `/${id}`, { featureName: 'x' }),
      call('reader', 'post', `/${id}/sync`),
      call('reader', 'delete', `/${id}`),
      call('reader', 'post', '/batch-delete', { ids: [id] }),
      call('reader', 'get', `/${id}/preview`),
      call('reader', 'get', '/download').query({ ids: String(id) }),
      call('reader', 'post', '/write', { ids: [id] }),
      call('plain', 'get'),
    ]
    for (const res of await Promise.all(forbidden)) {
      expect(res.status).toBe(403)
      expect(res.body.code).toBe(Err.FORBIDDEN.code)
    }
    expect(data(await call('admin', 'get', `/${id}`))).toMatchObject({ className: 'Book' })
  })

  it('400 / 404: bad bodies, queries and ids; unknown ids', async () => {
    for (const res of [
      await call('admin', 'post', '/import', { tableNames: [] }),
      await call('admin', 'post', '/batch-delete', { ids: [] }),
      await call('admin', 'post', '/write', { ids: [] }),
      await call('admin', 'get').query({ sort: 'className' }),
      await call('admin', 'get', '/abc'),
    ])
      expect(res.status).toBe(400)
    for (const res of [
      await call('admin', 'get', `/${MISSING}`),
      await call('admin', 'put', `/${MISSING}`, { featureName: 'x' }),
      await call('admin', 'delete', `/${MISSING}`),
      await call('admin', 'post', `/${MISSING}/sync`),
      await call('admin', 'get', `/${MISSING}/preview`),
      await call('admin', 'post', '/batch-delete', { ids: [cg.demo_book, MISSING] }),
    ]) {
      expect(res.status).toBe(404)
      expect(res.body.code).toBe(Err.NOT_FOUND.code)
    }
    await call('admin', 'get', `/${cg.demo_book}`).expect(200)
  })

  it('a master with its sub table linked is not deleted alone (409 in_use); both in one batch are', async () => {
    const { ids } = data(
      await call('admin', 'post', '/import', { tableNames: ['aud_signin_log', 'iam_user'] }),
    )
    const [sub, master] = ids
    await call('admin', 'put', `/${master}`, { template: 'master_sub' }).expect(200)
    await call('admin', 'put', `/${sub}`, { masterTableId: master, subFkCol: 'user_id' }).expect(
      200,
    )
    const res = await call('admin', 'delete', `/${master}`).expect(409)
    expect(res.body.code).toBe(Err.IN_USE.code)
    await call('admin', 'post', '/batch-delete', { ids: [master, sub] }).expect(200)
    // a deleted master is no master any more (no foreign key, the save checks live configs)
    const { ids: again } = data(
      await call('admin', 'post', '/import', { tableNames: ['aud_signin_log'] }).expect(200),
    )
    const refused = await call('admin', 'put', `/${again[0]}`, {
      masterTableId: master,
      subFkCol: 'user_id',
    }).expect(422)
    expect(refused.body.code).toBe(Err.CODEGEN_SUB_TABLES.code)
    await call('admin', 'delete', `/${again[0]}`).expect(200)
  })
})

it('@ActionLog: import, modify, sync, remove, download and write leave rows with their verbs', async () => {
  const trace = `${PREFIX}${process.pid}-`
  const imported = await call('admin', 'post', '/import', { tableNames: ['iam_role'] })
    .set('X-Request-Id', `${trace}i`)
    .expect(200)
  const [id] = data(imported).ids
  await call('admin', 'put', `/${id}`, { featureName: 'r' }).set('X-Request-Id', `${trace}m`)
  await call('admin', 'post', `/${id}/sync`).set('X-Request-Id', `${trace}s`)
  await download(String(cg.demo_topic)).set('X-Request-Id', `${trace}g`)
  await call('admin', 'post', '/write', { ids: [cg.demo_topic] }).set('X-Request-Id', `${trace}w`)
  await call('admin', 'delete', `/${id}`).set('X-Request-Id', `${trace}d`)
  const expected: [string, object][] = [
    ['i', { verb: 'import', ok: 1 }],
    ['m', { verb: 'modify', biz_id: String(id), ok: 1 }],
    ['s', { verb: 'sync', biz_id: String(id), ok: 1 }],
    ['g', { verb: 'generate', biz_id: String(cg.demo_topic), ok: 1 }],
    ['w', { verb: 'write', ok: 0, error_msg: Err.CODEGEN_WRITE_DISABLED.key }],
    ['d', { verb: 'remove', biz_id: String(id), ok: 1 }],
  ]
  for (const [suffix, row] of expected)
    expect(await logOf(ds, `${trace}${suffix}`)).toMatchObject({
      domain: 'codegen.table',
      username: 'admin',
      ...row,
    })
})

it('Swagger documents every route', async () => {
  const doc = (await request(app.getHttpServer()).get('/api/docs-json').expect(200)).body
  expect(
    Object.keys(doc.paths)
      .filter((p) => p.startsWith(URL))
      .sort(),
  ).toEqual([
    URL,
    `${URL}/batch-delete`,
    `${URL}/download`,
    `${URL}/import`,
    `${URL}/importable`,
    `${URL}/parent-menus`,
    `${URL}/writable`,
    `${URL}/write`,
    `${URL}/{id}`,
    `${URL}/{id}/preview`,
    `${URL}/{id}/sync`,
  ])
  expect(doc.paths[`${URL}/download`].get.responses['200'].content).toHaveProperty(
    'application/zip',
  )
})
