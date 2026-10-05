// Read-only lookups for the user page: GET /api/iam/depts/tree (enabled depts in the caller's data
// scope as a forest) and GET /api/iam/roles/options (enabled roles; root only for root). Any signed-in
// user; 401 without a session; Swagger documents both (the recursive tree resolvably).
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import type { DeptTreeNode, RoleOption } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { findId, insertRow } from '../../src/db/seeds/upsert.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const PREFIX = 'lookup-e2e-'

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
const created = { users: [] as number[], roles: [] as number[], depts: [] as number[] }
const dept: Record<string, number> = {}

const get = (token: string | null, url: string) => {
  const req = request(app.getHttpServer()).get(url)
  return token ? req.set(bearer(token)) : req
}
const tree = async (token: string): Promise<DeptTreeNode[]> =>
  (await get(token, '/api/iam/depts/tree').expect(200)).body.data
const roleOptions = async (token: string): Promise<RoleOption[]> =>
  (await get(token, '/api/iam/roles/options').expect(200)).body.data

/** Name tree of a forest: `name` or `[name, children]`, for readable expectations. */
type Shape = string | [string, Shape[]]
const shape = (nodes: DeptTreeNode[]): Shape[] =>
  nodes.map((n) => (n.children.length ? [n.name, shape(n.children)] : n.name))

async function role(code: string, dataScope: string, pickedDepts: number[] = [], extra = {}) {
  const id = await insertRow(ds.manager, 'iam_role', {
    code: PREFIX + code,
    name: PREFIX + code,
    data_scope: dataScope,
    ...extra,
  })
  for (const d of pickedDepts)
    await ds.query('INSERT INTO iam_role_depts (role_id, dept_id) VALUES (?, ?)', [id, d])
  created.roles.push(id)
  return id
}

async function user(name: string, deptId: number | null, roles: number[]) {
  const id = await insertRow(ds.manager, 'iam_user', {
    username: PREFIX + name,
    display_name: name,
    dept_id: deptId,
    password_hash: 'not-used-by-this-spec',
    password_changed_at: new Date(),
  })
  for (const r of roles)
    await ds.query('INSERT INTO iam_user_roles (user_id, role_id) VALUES (?, ?)', [id, r])
  created.users.push(id)
  return (await signIn(app, PREFIX + name)).accessToken
}

/** A dept under `parent` (tree_path = parent's + own id). */
async function addDept(name: string, parent: number, extra = {}) {
  const [{ tree_path: parentPath }] = await ds.query(
    'SELECT tree_path FROM iam_dept WHERE id = ?',
    [parent],
  )
  const id = await insertRow(ds.manager, 'iam_dept', {
    parent_id: parent,
    name: PREFIX + name,
    tree_path: parentPath,
    sort_no: 90,
    ...extra,
  })
  await ds.query('UPDATE iam_dept SET tree_path = ? WHERE id = ?', [`${parentPath}${id}/`, id])
  created.depts.push(id)
  return id
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  await cleanRedis(redis)
  for (const key of ['hq', 'rd', 'platform', 'product', 'ops', 'support', 'finance'])
    dept[key] = (await findId(ds.manager, 'iam_dept', { name: `seed.dept.${key}` }))!
})

afterAll(async () => {
  if (ds) {
    if (created.users.length) {
      await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [created.users])
      await ds.query('DELETE FROM iam_user WHERE id IN (?)', [created.users])
    }
    if (created.roles.length) {
      await ds.query('DELETE FROM iam_role_depts WHERE role_id IN (?)', [created.roles])
      await ds.query('DELETE FROM iam_role WHERE id IN (?)', [created.roles])
    }
    if (created.depts.length)
      await ds.query('DELETE FROM iam_dept WHERE id IN (?)', [created.depts.reverse()])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

describe('GET /api/iam/depts/tree', () => {
  it('root: every enabled dept as a forest, siblings by sort_no', async () => {
    const admin = (await signIn(app)).accessToken
    const hq = (await tree(admin)).find((n) => n.id === dept.hq)!
    expect(hq).toMatchObject({ parentId: 0, name: 'seed.dept.hq' })
    expect(shape([hq])).toEqual([
      [
        'seed.dept.hq',
        [
          ['seed.dept.rd', ['seed.dept.platform', 'seed.dept.product']],
          ['seed.dept.ops', ['seed.dept.support']],
          'seed.dept.finance',
        ],
      ],
    ])
    expect(hq.children[0]).toMatchObject({ id: dept.rd, parentId: dept.hq })
  })

  it('disabled and deleted depts are left out; a child whose parent is left out becomes a root', async () => {
    const off = await addDept('off', dept.rd!, { enabled: 0 })
    const orphan = await addDept('orphan', off)
    await addDept('deleted', dept.rd!, { deleted_at: new Date() })
    const admin = (await signIn(app)).accessToken
    const forest = await tree(admin)
    const ids = (nodes: DeptTreeNode[]): number[] =>
      nodes.flatMap((n) => [n.id, ...ids(n.children)])
    expect(ids(forest)).not.toContain(off)
    expect(forest.find((n) => n.id === orphan)).toEqual({
      id: orphan,
      parentId: off,
      name: `${PREFIX}orphan`,
      children: [],
    })
    expect(JSON.stringify(forest)).not.toContain(`${PREFIX}deleted`)
  })

  it('data scope: own_dept → only the own dept; own_dept_tree → its subtree; picked → those; none → []', async () => {
    const ownDept = await user('own', dept.rd!, [await role('own', 'own_dept')])
    expect(shape(await tree(ownDept))).toEqual(['seed.dept.rd'])

    const subtree = await user('tree', dept.ops!, [await role('tree', 'own_dept_tree')])
    expect(shape(await tree(subtree))).toEqual([['seed.dept.ops', ['seed.dept.support']]])

    const picked = await user('picked', null, [
      await role('picked', 'picked_depts', [dept.finance!, dept.platform!]),
    ])
    // both become roots (their parents are out of scope), by sort_no then id
    expect((await tree(picked)).map((n) => n.id).sort()).toEqual(
      [dept.finance, dept.platform].sort(),
    )

    const ownRows = await user('rows', dept.rd!, [await role('rows', 'own_rows')])
    expect(await tree(ownRows)).toEqual([]) // depts have no owner column
    expect(await tree(await user('none', dept.rd!, []))).toEqual([])
  })

  it('401 without a session', async () => {
    await get(null, '/api/iam/depts/tree').expect(401)
  })
})

describe('GET /api/iam/roles/options', () => {
  it('enabled roles by sort_no, id as { id, code, name }; root only for a root caller', async () => {
    const early = await role('early', 'all', [], { sort_no: -1 })
    const disabled = await role('disabled', 'all', [], { enabled: 0 })
    const deleted = await role('deleted', 'all', [], { deleted_at: new Date() })
    const admin = await roleOptions((await signIn(app)).accessToken)
    const expected = await ds.query(
      'SELECT id, code, name FROM iam_role WHERE enabled = 1 AND deleted_at IS NULL ORDER BY sort_no, id',
    )
    expect(admin).toEqual(expected.map((r: RoleOption) => ({ ...r })))
    expect(admin[0]).toMatchObject({ id: early, code: `${PREFIX}early` })
    expect(admin.map((r) => r.code)).toContain('root')
    expect(admin.map((r) => r.id)).not.toContain(disabled)
    expect(admin.map((r) => r.id)).not.toContain(deleted)

    const plain = await roleOptions(await user('plain', null, []))
    expect(plain).toEqual(admin.filter((r) => r.code !== 'root'))
  })

  it('401 without a session', async () => {
    await get(null, '/api/iam/roles/options').expect(401)
  })
})

it('Swagger documents both, the recursive tree without unresolvable references', async () => {
  const doc = (await get(null, '/api/docs-json').expect(200)).body
  const tree = doc.paths['/api/iam/depts/tree'].get.responses['200'].content['application/json']
  expect(JSON.stringify(tree)).not.toContain('#/definitions/')
  // one level inlined; the recursion itself is a plain object
  expect(tree.schema.properties.data.items.properties).toMatchObject({
    id: { type: 'integer' },
    parentId: { type: 'integer' },
    name: { type: 'string' },
    children: { type: 'array', items: { type: 'object' } },
  })
  expect(doc.paths['/api/iam/roles/options'].get).toBeDefined()
})
