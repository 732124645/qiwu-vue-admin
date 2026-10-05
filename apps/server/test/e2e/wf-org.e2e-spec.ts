// typeormOrg: the OrgDirectory port over iam_* in the test database. Only enabled, live users
//; a disabled or deleted role / position, or a deleted link row, reaches nobody; a deleted dept is
// no dept; head chains follow tree_path nearest first; initiatorCtx = dept tree_path + enabled role ids
//. Works on a DataSource and on a transaction's EntityManager.
import { DataSource } from 'typeorm'
import { dataSourceOptions } from '../../src/db/data-source.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { typeormOrg } from '../../src/modules/workflow/typeorm-org.js'

const PREFIX = 'wf-org-e2e-'
const GONE = { deleted_at: new Date() }
const NO_SUCH = Number.MAX_SAFE_INTEGER

let ds: DataSource
const made = { iam_user: [], iam_role: [], iam_position: [], iam_dept: [] } as Record<
  string,
  number[]
>
const u: Record<string, number> = {}
const r: Record<string, number> = {}
const p: Record<string, number> = {}
const d: Record<string, number> = {}
const path: Record<string, string> = {}
const org = () => typeormOrg(ds)

async function add(table: string, row: Record<string, unknown>) {
  const id = await insertRow(ds.manager, table, row)
  made[table].push(id)
  return id
}

/** A dept under `parent` (null = top level); tree_path = the parent's + its own id. */
async function dept(name: string, parent: string | null, extra = {}) {
  const id = await add('iam_dept', {
    parent_id: parent ? d[parent] : 0,
    name: PREFIX + name,
    tree_path: '/',
    ...extra,
  })
  d[name] = id
  path[name] = `${parent ? path[parent] : '/'}${id}/`
  await ds.query('UPDATE iam_dept SET tree_path = ? WHERE id = ?', [path[name], id])
}

/** A user with role / position links; a link name ending in `!` is a deleted link row. */
async function user(
  name: string,
  deptName: string | null,
  roles: string[],
  positions: string[] = [],
  extra = {},
) {
  u[name] = await add('iam_user', {
    username: PREFIX + name,
    display_name: name,
    dept_id: deptName ? d[deptName] : null,
    password_hash: 'not-used-by-this-spec',
    ...extra,
  })
  const link = (table: string, column: string, ids: Record<string, number>, names: string[]) =>
    Promise.all(
      names.map((n) =>
        ds.query(`INSERT INTO ${table} (user_id, ${column}, deleted_at) VALUES (?, ?, ?)`, [
          u[name],
          ids[n.replace('!', '')],
          n.endsWith('!') ? new Date() : null,
        ]),
      ),
    )
  await link('iam_user_roles', 'role_id', r, roles)
  await link('iam_user_positions', 'position_id', p, positions)
}

beforeAll(async () => {
  ds = await new DataSource(dataSourceOptions()).initialize()
  for (const [name, extra] of [
    ['R1', {}],
    ['R2', {}],
    ['Roff', { enabled: 0 }],
    ['Rgone', GONE],
  ] as const)
    r[name] = await add('iam_role', {
      code: PREFIX + name,
      name: PREFIX + name,
      data_scope: 'own_rows',
      ...extra,
    })
  for (const [name, extra] of [
    ['P1', {}],
    ['P2', {}],
    ['Poff', { enabled: 0 }],
    ['Pgone', GONE],
  ] as const)
    p[name] = await add('iam_position', { code: PREFIX + name, name: PREFIX + name, ...extra })
  // A ← B ← C ← D, A ← E ← F, B ← G, A ← X (deleted) ← Y
  await dept('A', null)
  await dept('B', 'A')
  await dept('C', 'B')
  await dept('D', 'C')
  await dept('E', 'A')
  await dept('F', 'E')
  await dept('G', 'B')
  await dept('X', 'A', GONE)
  await dept('Y', 'X')
  // ids ascend in this order
  await user('a', 'A', ['R1', 'Roff', 'Rgone'])
  await user('b', 'B', ['R1', 'R2'], ['P1', 'Poff', 'Pgone'])
  await user('c', 'C', ['R2'], ['P1', 'P2'])
  await user('dd', 'D', [], ['P2'])
  await user('e', 'D', ['R1', 'R2!'], ['P2!'])
  await user('f', null, [])
  await user('x', 'X', [])
  await user('off', 'C', ['R1'], ['P1'], { enabled: 0 })
  await user('gone', 'C', ['R1'], ['P1'], GONE)
  // heads: D none, C disabled, G deleted, F and E the same user
  const heads = { A: 'a', B: 'b', C: 'off', E: 'b', F: 'b', G: 'gone', X: 'a', Y: 'c' }
  for (const [dn, un] of Object.entries(heads))
    await ds.query('UPDATE iam_dept SET head_user_id = ? WHERE id = ?', [u[un], d[dn]])
})

afterAll(async () => {
  if (!ds?.isInitialized) return
  if (made.iam_user.length) {
    await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [made.iam_user])
    await ds.query('DELETE FROM iam_user_positions WHERE user_id IN (?)', [made.iam_user])
  }
  for (const [table, list] of Object.entries(made))
    if (list.length) await ds.query(`DELETE FROM ${table} WHERE id IN (?)`, [list])
  await ds.destroy()
})

const users = (...names: string[]) => names.map((n) => u[n])

describe('typeormOrg', () => {
  it('enabledUsers: enabled, live users among the ids, ascending, each once; unknown ids dropped', async () => {
    expect(await org().enabledUsers(users('off', 'b', 'gone', 'a', 'b').concat(NO_SUCH))).toEqual(
      users('a', 'b'),
    )
    expect(await org().enabledUsers([])).toEqual([])
  })

  it('usersOfRoles: enabled holders of an enabled, live role over a live link, ascending, each once', async () => {
    expect(await org().usersOfRoles([r.R2, r.R1])).toEqual(users('a', 'b', 'c', 'e'))
    // e's R2 link row is deleted
    expect(await org().usersOfRoles([r.R2])).toEqual(users('b', 'c'))
    expect(await org().usersOfRoles([r.Roff, r.Rgone])).toEqual([])
    expect(await org().usersOfRoles([])).toEqual([])
  })

  it('usersOfPositions: the same rules for positions', async () => {
    expect(await org().usersOfPositions([p.P1, p.P2])).toEqual(users('b', 'c', 'dd'))
    // e's P2 link row is deleted
    expect(await org().usersOfPositions([p.P2])).toEqual(users('c', 'dd'))
    expect(await org().usersOfPositions([p.Poff, p.Pgone])).toEqual([])
    expect(await org().usersOfPositions([])).toEqual([])
  })

  it('usersOfDepts: enabled members of these depts, not of their sub-depts; a deleted dept has none', async () => {
    expect(await org().usersOfDepts([d.D, d.C])).toEqual(users('c', 'dd', 'e'))
    expect(await org().usersOfDepts([d.B])).toEqual(users('b'))
    expect(await org().usersOfDepts([d.X])).toEqual([])
    expect(await org().usersOfDepts([])).toEqual([])
  })

  it('deptOfUser: the live dept; a disabled or deleted user keeps theirs', async () => {
    expect(await org().deptOfUser(u.dd)).toBe(d.D)
    expect(await org().deptOfUser(u.off)).toBe(d.C)
    expect(await org().deptOfUser(u.gone)).toBe(d.C)
    expect(await org().deptOfUser(u.f)).toBeNull()
    expect(await org().deptOfUser(u.x)).toBeNull()
    expect(await org().deptOfUser(NO_SUCH)).toBeNull()
  })

  it('deptHeads: enabled heads up the tree_path, nearest first, `levels` depts, each once', async () => {
    // D has no head, C's head is disabled
    expect(await org().deptHeads(d.D, 2)).toEqual([])
    expect(await org().deptHeads(d.D, 3)).toEqual(users('b'))
    expect(await org().deptHeads(d.D, Infinity)).toEqual(users('b', 'a'))
    expect(await org().deptHeads(d.D, 0)).toEqual([])
    // F and E share their head
    expect(await org().deptHeads(d.F, Infinity)).toEqual(users('b', 'a'))
    // G's head is deleted
    expect(await org().deptHeads(d.G, 1)).toEqual([])
    expect(await org().deptHeads(d.G, 2)).toEqual(users('b'))
    // a deleted dept: none of its own, and none as a link of a chain
    expect(await org().deptHeads(d.X, 9)).toEqual([])
    expect(await org().deptHeads(d.Y, 2)).toEqual(users('c'))
    expect(await org().deptHeads(d.Y, 3)).toEqual(users('c', 'a'))
    expect(await org().deptHeads(NO_SUCH, 9)).toEqual([])
  })

  it('initiatorCtx: the live dept tree_path and the ids of enabled, live roles over live links, ascending', async () => {
    expect(await org().initiatorCtx(u.b)).toEqual({ deptTreePath: path.B, roleIds: [r.R1, r.R2] })
    expect(await org().initiatorCtx(u.a)).toEqual({ deptTreePath: path.A, roleIds: [r.R1] })
    expect(await org().initiatorCtx(u.e)).toEqual({ deptTreePath: path.D, roleIds: [r.R1] })
    expect(path.D).toBe(`/${d.A}/${d.B}/${d.C}/${d.D}/`)
    expect(await org().initiatorCtx(u.f)).toEqual({ deptTreePath: null, roleIds: [] })
    expect(await org().initiatorCtx(u.x)).toEqual({ deptTreePath: null, roleIds: [] })
    expect(await org().initiatorCtx(NO_SUCH)).toEqual({ deptTreePath: null, roleIds: [] })
  })

  it("reads through a transaction's EntityManager too", async () => {
    expect(await ds.transaction((tx) => typeormOrg(tx).usersOfDepts([d.B]))).toEqual(users('b'))
  })
})
