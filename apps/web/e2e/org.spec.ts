import { bearer, expect, msg, signIn, test, type Page } from './fixtures.ts'
import { USERS } from './env.ts'

// Organization pages (acceptance). `dept`: the dept tree table (add, add below, search, expand /
// collapse all, disable, delete) and the move case: moving a dept rewrites its children's paths and the
// "own dept and below" user list of a user under the new parent follows at once. `menu`: the kind-driven
// menu form with the IconPicker, the sort mode, and admin-created names (name_i18n) in the side menu per
// language. `role`: the role list (builtin root protected), the menu grant tree with its link switch, the
// data-scope dialog (no `all` for a non-root editor; own_dept → only the own dept's users) and the
// members page. `perm-reload`: button menus granted to a role reach its signed-in user at the
// next request (v-perm and the page's perm flags), no new sign-in; taken back, they go again.

const entity = msg('iam.dept.entity')
const field = (prop: string) => msg(`field.iam.dept.${prop}`)
const button = (page: Page, key: string) =>
  page.getByRole('button', { name: msg(key), exact: true })
const row = (page: Page, text: string) => page.getByRole('row').filter({ hasText: text })

interface Dept {
  id: number
  name: string
  treePath: string
  children: Dept[]
}

type Dialog = ReturnType<Page['getByRole']>
/** Opens the dialog's parent tree select (its wrapper: the input under a shown value takes no click). */
const openParent = (dialog: Dialog) =>
  dialog
    .locator('.el-form-item', { hasText: field('parentId') })
    .locator('.el-select__wrapper')
    .click()

/** Picks `name` in the dialog's parent tree select. */
async function pickParent(page: Page, dialog: Dialog, name: string) {
  await openParent(dialog)
  await page.locator('.el-select-dropdown').getByText(name, { exact: true }).click()
}

async function removeRow(page: Page, text: string) {
  await row(page, text)
    .getByRole('button', { name: msg('crud.action.delete'), exact: true })
    .click()
  await page
    .getByRole('dialog', { name: msg('crud.confirm.title') })
    .getByRole('button', { name: msg('crud.action.delete'), exact: true })
    .click()
}

test('dept: add → add below → search → collapse / expand all → disable → delete', async ({
  page,
}) => {
  const [A, B] = ['e2e-dept-a', 'e2e-dept-b']
  await signIn(page, 'admin', '/iam/depts')
  await expect(row(page, msg('seed.dept.platform'))).toBeVisible() // expanded by default

  // add under HQ, with the shared zod rules checked first
  await button(page, 'crud.action.create').click()
  const create = page.getByRole('dialog', {
    name: msg('crud.title.create', 'zh-CN', { name: entity }),
  })
  await create.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(
    create.getByText(msg('validation.required', 'zh-CN', { field: field('name') })),
  ).toBeVisible()
  await pickParent(page, create, msg('seed.dept.hq'))
  await create.getByRole('textbox', { name: field('name') }).fill(A)
  await create.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(page.getByText(msg('crud.msg.created'))).toBeVisible()
  await expect(create).toBeHidden()

  // add below it: the parent is preset
  await row(page, A)
    .getByRole('button', { name: msg('crud.action.addChild') })
    .click()
  const child = page.getByRole('dialog', {
    name: msg('crud.title.create', 'zh-CN', { name: entity }),
  })
  await child.getByRole('textbox', { name: field('name') }).fill(B)
  await child.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(child).toBeHidden()
  await expect(row(page, B)).toBeVisible()

  // search: the match shows as a root; the seeded names match their text
  await page.getByRole('textbox', { name: field('name') }).fill(B)
  await button(page, 'crud.action.search').click()
  await expect(page.getByRole('row')).toHaveCount(2) // header + the row
  await page.getByRole('textbox', { name: field('name') }).fill(msg('seed.dept.finance'))
  await button(page, 'crud.action.search').click()
  await expect(row(page, msg('seed.dept.finance'))).toBeVisible()
  await expect(page.getByRole('row')).toHaveCount(2)
  await button(page, 'crud.action.reset').click()

  // collapse all: only the top level stays; expand all shows the rest again
  await button(page, 'crud.action.collapseAll').click()
  await expect(row(page, msg('seed.dept.hq'))).toBeVisible()
  await expect(row(page, B)).toBeHidden()
  await button(page, 'crud.action.expandAll').click()
  await expect(row(page, B)).toBeVisible()

  // a parent with an enabled child cannot be disabled (the server's message), the child can
  await row(page, A).locator('.el-switch').click()
  // the server's translated `error.tree.child_enabled`, toasted by the request layer
  await expect(page.getByText('还有启用的下级，不能停用')).toBeVisible()
  await expect(row(page, A).getByRole('switch')).toBeChecked()
  await row(page, B).locator('.el-switch').click()
  await expect(row(page, B).getByRole('switch')).not.toBeChecked()
  // nothing is added below a disabled dept
  await expect(
    row(page, B).getByRole('button', { name: msg('crud.action.addChild') }),
  ).toBeDisabled()

  // delete: a parent only once its children are gone
  await expect(
    row(page, A).getByRole('button', { name: msg('crud.action.delete'), exact: true }),
  ).toBeDisabled()
  await removeRow(page, B)
  await expect(page.getByText(msg('crud.msg.deleted'))).toBeVisible()
  await expect(row(page, B)).toHaveCount(0)
  await removeRow(page, A)
  await expect(row(page, A)).toHaveCount(0)
})

test("dept: moving a dept rewrites its children's paths and the own_dept_tree user list follows", async ({
  page,
  request,
  browser,
}) => {
  const [A, B, X, MEMBER] = ['e2e-org-a', 'e2e-org-b', 'e2e-org-x', 'e2e-org-member']
  const admin = { Authorization: await bearer(request) }
  const post = async (url: string, data: object) => {
    const res = await request.post(url, { headers: admin, data })
    expect(res.ok(), await res.text()).toBe(true)
    return ((await res.json()) as { data: { id: number } }).data
  }
  const get = async <T>(url: string, params?: Record<string, string>) => {
    const res = await request.get(url, { headers: admin, params })
    expect(res.ok(), await res.text()).toBe(true)
    return ((await res.json()) as { data: T }).data
  }
  const hq = (await get<Dept[]>('/api/iam/depts')).find((d) => d.name === 'seed.dept.hq')!
  const x = await post('/api/iam/depts', { parentId: hq.id, name: X })
  const a = await post('/api/iam/depts', { parentId: hq.id, name: A })
  const b = await post('/api/iam/depts', { parentId: a.id, name: B })
  const member = await post('/api/iam/users', {
    username: MEMBER,
    displayName: MEMBER,
    deptId: b.id,
  })
  // the watcher (own dept and below for the user list) moves into X
  const [watcher] = await get<{ id: number }[]>('/api/iam/users/options', {
    keyword: USERS.tree.username,
  })
  const { deptId: home } = await get<{ deptId: number }>(`/api/iam/users/${watcher!.id}`)
  const moved = await request.put(`/api/iam/users/${watcher!.id}`, {
    headers: admin,
    data: { deptId: x.id },
  })
  expect(moved.ok(), await moved.text()).toBe(true)

  const watch = await browser.newPage()
  await signIn(watch, 'tree', '/iam/users')
  await expect(row(watch, USERS.tree.username)).toBeVisible()
  await expect(row(watch, MEMBER)).toHaveCount(0)

  // move A (with B) under X in the edit form
  await signIn(page, 'admin', '/iam/depts')
  await row(page, A)
    .getByRole('button', { name: msg('crud.action.edit') })
    .click()
  const edit = page.getByRole('dialog', { name: msg('crud.title.edit', 'zh-CN', { name: entity }) })
  await expect(edit.getByRole('textbox', { name: field('name') })).toHaveValue(A)
  // the parent picker leaves out the dept itself and its subtree
  await openParent(edit)
  const options = page.locator('.el-select-dropdown')
  await expect(options.getByText(X, { exact: true })).toBeVisible()
  await expect(options.getByText(A, { exact: true })).toHaveCount(0)
  await expect(options.getByText(B, { exact: true })).toHaveCount(0)
  await options.getByText(X, { exact: true }).click()
  await edit.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(edit).toBeHidden()
  const hqNow = (await get<Dept[]>('/api/iam/depts')).find((d) => d.id === hq.id)!
  const xNode = hqNow.children.find((d) => d.name === X)!
  expect(xNode.children.map((d) => d.name)).toEqual([A])
  expect(xNode.children[0]!.children.map((d) => d.name)).toEqual([B])
  expect((await get<Dept>(`/api/iam/depts/${b.id}`)).treePath).toBe(
    `${xNode.treePath}${a.id}/${b.id}/`,
  )

  // the watcher's next list has the moved member
  await watch.getByRole('button', { name: msg('crud.action.refresh') }).click()
  await expect(row(watch, MEMBER)).toBeVisible()
  await watch.close()

  // leave the depts and the watcher as they were: other specs pick depts from the same tree
  const send = async (res: Promise<{ ok(): boolean; text(): Promise<string> }>) => {
    const r = await res
    expect(r.ok(), await r.text()).toBe(true)
  }
  await send(
    request.put(`/api/iam/users/${watcher!.id}`, { headers: admin, data: { deptId: home } }),
  )
  await send(request.delete(`/api/iam/users/${member.id}`, { headers: admin }))
  for (const id of [b.id, a.id, x.id])
    await send(request.delete(`/api/iam/depts/${id}`, { headers: admin }))
})

test('menu: kind-driven form with the IconPicker; admin-created names follow the language (name_i18n)', async ({
  page,
}) => {
  const menuField = (prop: string, lang = 'zh-CN') => msg(`field.iam.menu.${prop}`, lang)
  const title = msg('crud.title.create', 'zh-CN', { name: msg('iam.menu.entity') })
  const [G, L] = ['e2e-org-menu-group', 'e2e-org-menu-link']
  const names = { group: ['e2e-org-zh', 'e2e-org-en'], link: ['e2e-link-zh', 'e2e-link-en'] }
  await signIn(page, 'admin', '/iam/menus')

  // a top-level group: its path and icon, no view, link or perms fields
  await button(page, 'crud.action.create').click()
  const group = page.getByRole('dialog', { name: title })
  await expect(group.getByRole('radio').first()).toBeChecked()
  await expect(group.getByRole('textbox', { name: menuField('component') })).toHaveCount(0)
  await expect(group.getByRole('textbox', { name: menuField('perms') })).toHaveCount(0)
  await expect(group.getByRole('textbox', { name: menuField('linkUrl') })).toHaveCount(0)
  await group.getByRole('textbox', { name: menuField('name') }).fill(G)
  await group.getByRole('textbox', { name: menuField('zh-CN') }).fill(names.group[0]!)
  await group.getByRole('textbox', { name: menuField('en-US') }).fill(names.group[1]!)
  await group.getByRole('textbox', { name: menuField('routePath') }).fill('/e2e-org-menu')
  const alwaysShow = group.locator('.el-form-item', { hasText: menuField('alwaysShow') })
  await alwaysShow.locator('.el-switch').click()
  await expect(alwaysShow.getByRole('switch')).toBeChecked()
  await group.getByRole('textbox', { name: menuField('icon') }).click()
  await page.getByRole('textbox', { name: msg('picker.icon.search') }).fill('chart-pie')
  await page.getByRole('option', { name: 'chart-pie', exact: true }).click()
  await expect(group.getByRole('textbox', { name: menuField('icon') })).toHaveValue(
    'lucide:chart-pie',
  )
  await group.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(group).toBeHidden()
  await expect(row(page, names.group[0]!)).toBeVisible()

  // sort mode: renumber in the table, saved at once (PUT /sort): the group moves right after home (0)
  await button(page, 'iam.menu.sort.start').click()
  await row(page, names.group[0]!)
    .getByRole('spinbutton', { name: `${menuField('sortNo')} ${names.group[0]}` })
    .fill('1')
  await button(page, 'iam.menu.sort.save').click()
  await expect(page.getByText(msg('crud.msg.updated'))).toBeVisible()
  await expect(page.getByRole('row').nth(2)).toContainText(names.group[0]!)
  await expect(button(page, 'iam.menu.sort.save')).toHaveCount(0)

  // an external link below it: the link alone (no path, no view)
  await row(page, names.group[0]!)
    .getByRole('button', { name: msg('crud.action.addChild') })
    .click()
  const link = page.getByRole('dialog', { name: title })
  await expect(link.getByRole('radio').nth(1)).toBeChecked() // a page
  await link
    .locator('.el-form-item', { hasText: menuField('linkType') })
    .getByRole('radio')
    .nth(2)
    .check({ force: true })
  await expect(link.getByRole('textbox', { name: menuField('component') })).toHaveCount(0)
  await expect(link.getByRole('textbox', { name: menuField('routePath') })).toHaveCount(0)
  await link.getByRole('textbox', { name: menuField('name') }).fill(L)
  await link.getByRole('textbox', { name: menuField('zh-CN') }).fill(names.link[0]!)
  await link.getByRole('textbox', { name: menuField('en-US') }).fill(names.link[1]!)
  await link.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(
    link.getByText(msg('validation.required', 'zh-CN', { field: menuField('linkUrl') })),
  ).toBeVisible()
  await link.getByRole('textbox', { name: menuField('linkUrl') }).fill('https://example.com/')
  await link.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(link).toBeHidden()

  // the side menu (reloaded) shows the per-locale names, in English after switching
  await page.reload()
  const side = page.getByRole('navigation', { name: msg('common.layout.sideMenu') })
  // alwaysShow keeps this single-child group; off the current trail, it starts closed
  await side.getByText(names.group[0]!, { exact: true }).click()
  await expect(side.getByRole('menuitem', { name: names.link[0] })).toBeVisible()
  const language = async (from: string, to: string) => {
    await page.getByRole('button', { name: msg('common.layout.language', from) }).click()
    await page
      .getByRole('menuitem', { name: msg(`common.language.${to === 'en-US' ? 'enUS' : 'zhCN'}`) })
      .click()
    await expect(page.locator('html')).toHaveAttribute('lang', to)
  }
  await language('zh-CN', 'en-US')
  const sideEn = page.getByRole('navigation', { name: msg('common.layout.sideMenu', 'en-US') })
  await expect(sideEn.getByText(names.group[1]!, { exact: true })).toBeVisible()
  await expect(sideEn.getByRole('menuitem', { name: names.link[1] })).toBeVisible()
  await expect(row(page, names.link[1]!)).toBeVisible()
  await language('en-US', 'zh-CN')

  // the name search matches the names as shown (a seeded key's text); a match is a root
  await page.getByRole('textbox', { name: menuField('name') }).fill(msg('menu.iam.dept'))
  await button(page, 'crud.action.search').click()
  await expect(row(page, msg('menu.iam.dept'))).toBeVisible()
  await expect(page.getByRole('row')).toHaveCount(2)
  await button(page, 'crud.action.reset').click()

  await removeRow(page, names.link[0]!)
  await expect(row(page, names.link[0]!)).toHaveCount(0)
  await removeRow(page, names.group[0]!)
  await expect(row(page, names.group[0]!)).toHaveCount(0)
})

test('role: add → search → edit → disable → delete; the builtin root is locked', async ({
  page,
}) => {
  const roleField = (prop: string) => msg(`field.iam.role.${prop}`)
  const roleEntity = msg('iam.role.entity')
  const [NAME, CODE] = ['e2e-org-role', 'e2e_org_role']
  await signIn(page, 'admin', '/iam/roles')
  const root = row(page, msg('seed.role.root'))
  await expect(root).toBeVisible()
  // root: never disabled or deleted, not even in a batch
  await expect(root.getByRole('switch')).toBeDisabled()
  await expect(root.getByRole('checkbox')).toBeDisabled()
  await expect(
    root.getByRole('button', { name: msg('crud.action.delete'), exact: true }),
  ).toBeDisabled()

  await button(page, 'crud.action.create').click()
  const create = page.getByRole('dialog', {
    name: msg('crud.title.create', 'zh-CN', { name: roleEntity }),
  })
  await create.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(
    create.getByText(msg('validation.required', 'zh-CN', { field: roleField('name') })),
  ).toBeVisible()
  await create.getByRole('textbox', { name: roleField('name') }).fill(NAME)
  await create.getByRole('textbox', { name: roleField('code') }).fill(CODE)
  await create.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(page.getByText(msg('crud.msg.created'))).toBeVisible()
  await expect(create).toBeHidden()
  // a new role sees its own dept until the data-scope dialog says otherwise (dict iam.data_scope)
  await expect(row(page, CODE)).toContainText('本部门')

  await page.getByRole('textbox', { name: roleField('code') }).fill(CODE)
  await button(page, 'crud.action.search').click()
  await expect(page.getByRole('row')).toHaveCount(2)

  await row(page, CODE)
    .getByRole('button', { name: msg('crud.action.edit') })
    .click()
  const edit = page.getByRole('dialog', {
    name: msg('crud.title.edit', 'zh-CN', { name: roleEntity }),
  })
  await expect(edit.getByRole('textbox', { name: roleField('name') })).toHaveValue(NAME)
  await edit.getByRole('textbox', { name: roleField('note') }).fill('e2e note')
  await edit.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(edit).toBeHidden()
  await expect(row(page, CODE)).toContainText('e2e note')

  await row(page, CODE).locator('.el-switch').click()
  await expect(row(page, CODE).getByRole('switch')).not.toBeChecked()

  await removeRow(page, CODE)
  await expect(page.getByText(msg('crud.msg.deleted'))).toBeVisible()
  await expect(row(page, CODE)).toHaveCount(0)
})

test("role: the menu grant tree saves checked + half-checked and echoes leaves; data scope own_dept → only the own dept's users; no `all` for a non-root editor", async ({
  page,
  request,
  browser,
}) => {
  const ROLE = 'e2e-org-grantee'
  const admin = { Authorization: await bearer(request) }
  const get = async <T>(url: string) => {
    const res = await request.get(url, { headers: admin })
    expect(res.ok(), await res.text()).toBe(true)
    return ((await res.json()) as { data: T }).data
  }
  const created = await request.post('/api/iam/roles', {
    headers: admin,
    data: { name: ROLE, code: ROLE },
  })
  expect(created.ok(), await created.text()).toBe(true)
  const role = ((await created.json()) as { data: { id: number } }).data

  await signIn(page, 'admin', '/iam/roles')
  const more = async (name: string, key: string) => {
    await row(page, name)
      .getByRole('button', { name: msg('crud.action.more') })
      .click()
    await page.getByRole('menuitem', { name: msg(key) }).click()
  }
  const grantTitle = msg('iam.role.grant.title', 'zh-CN', { name: ROLE })
  const node = (dialog: Dialog, text: string) =>
    dialog
      .locator('.el-tree-node__content')
      .filter({ has: page.getByText(text, { exact: true }) })
      .first()
  const box = (dialog: Dialog, text: string) => node(dialog, text).locator('.el-checkbox__input')

  // link on (the default): ticking the user page takes everything below it; its group follows
  await more(ROLE, 'iam.role.grant.action')
  let dialog = page.getByRole('dialog', { name: grantTitle })
  await expect(node(dialog, msg('menu.iam.user'))).toBeVisible()
  await node(dialog, msg('menu.iam.user')).locator('.el-checkbox').click()
  await expect(box(dialog, msg('menu.system.title'))).toHaveClass(/is-indeterminate/)
  await dialog.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(page.getByText(msg('iam.role.grant.done'))).toBeVisible()
  await expect(dialog).toBeHidden()

  interface Node {
    id: number
    name: string
    children: Node[]
  }
  const tree = await get<Node[]>('/api/iam/roles/menu-tree')
  const system = tree.find((n) => n.name === 'menu.system.title')!
  const users = system.children.find((n) => n.name === 'menu.iam.user')!
  const below = (n: Node): number[] => [n.id, ...n.children.flatMap(below)]
  const saved = await get<{ menuLink: boolean; menuIds: number[] }>(
    `/api/iam/roles/${role.id}/menus`,
  )
  expect(saved.menuLink).toBe(true)
  expect(saved.menuIds).toEqual([system.id, ...below(users)].sort((a, b) => a - b))

  // reopened: the page is ticked again (echoed from its leaves), the group half-ticked
  await more(ROLE, 'iam.role.grant.action')
  dialog = page.getByRole('dialog', { name: grantTitle })
  await expect(box(dialog, msg('menu.iam.user'))).toHaveClass(/is-checked/)
  await expect(box(dialog, msg('menu.system.title'))).toHaveClass(/is-indeterminate/)
  // link off: every node on its own, saved exactly as ticked
  await dialog.locator('.el-switch').first().click()
  await node(dialog, msg('menu.iam.user')).locator('.el-checkbox').click()
  await expect(box(dialog, msg('menu.iam.user'))).not.toHaveClass(/is-checked/)
  await dialog.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(dialog).toBeHidden()
  const strict = await get<{ menuLink: boolean; menuIds: number[] }>(
    `/api/iam/roles/${role.id}/menus`,
  )
  expect(strict.menuLink).toBe(false)
  expect(strict.menuIds).toEqual(
    [system.id, ...below(users)].filter((id) => id !== users.id).sort((a, b) => a - b),
  )

  // data scope own_dept: the scoped user (dept support) no longer sees the admin (HQ) at its next request
  const watch = await browser.newPage()
  await signIn(watch, 'scoped', '/iam/users')
  const keyword = watch.getByRole('textbox', { name: msg('field.iam.user.keyword') })
  const lookFor = async (text: string) => {
    await keyword.fill(text)
    await watch.getByRole('button', { name: msg('crud.action.search'), exact: true }).click()
  }
  await lookFor('admin')
  await expect(row(watch, 'Administrator')).toBeVisible()

  await more('e2e_scoped', 'iam.role.dataScope.action')
  dialog = page.getByRole('dialog', {
    name: msg('iam.role.dataScope.title', 'zh-CN', { name: 'e2e_scoped' }),
  })
  // the select's wrapper: the input under a shown value takes no click
  await dialog.locator('.el-select__wrapper').click()
  await page.getByRole('option', { name: '本部门', exact: true }).click()
  await dialog.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(page.getByText(msg('iam.role.dataScope.done'))).toBeVisible()
  await expect(row(page, 'e2e_scoped')).toContainText('本部门')

  await lookFor('admin')
  await expect(row(watch, 'Administrator')).toHaveCount(0)
  await lookFor(USERS.limited.username)
  await expect(row(watch, USERS.limited.username)).toBeVisible()
  await watch.close()

  // a non-root role editor is never offered `all`
  const granter = await browser.newPage()
  await signIn(granter, 'granter', '/iam/roles')
  await row(granter, ROLE)
    .getByRole('button', { name: msg('crud.action.more') })
    .click()
  await granter.getByRole('menuitem', { name: msg('iam.role.dataScope.action') }).click()
  const own = granter.getByRole('dialog', {
    name: msg('iam.role.dataScope.title', 'zh-CN', { name: ROLE }),
  })
  await own.locator('.el-select__wrapper').click()
  await expect(granter.getByRole('option', { name: '本部门', exact: true })).toBeVisible()
  await expect(granter.getByRole('option', { name: '全部数据', exact: true })).toHaveCount(0)
  await granter.close()

  const removed = await request.delete(`/api/iam/roles/${role.id}`, { headers: admin })
  expect(removed.ok(), await removed.text()).toBe(true)
})

test('role: members page — assign the ticked users from the other tab, remove one, back to the list', async ({
  page,
  request,
}) => {
  const ROLE = 'e2e-org-members'
  const admin = { Authorization: await bearer(request) }
  const created = await request.post('/api/iam/roles', {
    headers: admin,
    data: { name: ROLE, code: ROLE },
  })
  expect(created.ok(), await created.text()).toBe(true)
  const role = ((await created.json()) as { data: { id: number } }).data

  await signIn(page, 'admin', '/iam/roles')
  await page.getByRole('textbox', { name: msg('field.iam.role.code') }).fill(ROLE)
  await button(page, 'crud.action.search').click()
  await row(page, ROLE)
    .getByRole('button', { name: msg('crud.action.more') })
    .click()
  await page.getByRole('menuitem', { name: msg('menu.action.assignUsers') }).click()
  await expect(page).toHaveURL(new RegExp(`/iam/roles/${role.id}/users$`))
  await expect(
    page.locator('.el-descriptions').getByText(ROLE, { exact: true }).first(),
  ).toBeVisible()
  // nobody holds it yet: the table has its header row only
  await expect(page.locator('.qw-table-panel').getByRole('row')).toHaveCount(1)

  const keyword = page.getByRole('textbox', { name: msg('field.iam.role.keyword') })
  const [first, second] = [USERS.limited.username, USERS.reader.username]
  await page.getByRole('tab', { name: msg('iam.role.members.unassigned') }).click()
  await keyword.fill('e2e_')
  await button(page, 'crud.action.search').click()
  await row(page, first).locator('.el-checkbox').click()
  await row(page, second).locator('.el-checkbox').click()
  await button(page, 'iam.role.members.batchAdd').click()
  await expect(page.getByText(msg('iam.role.members.added'), { exact: true })).toBeVisible()
  await expect(row(page, first)).toHaveCount(0)

  await page.getByRole('tab', { name: msg('iam.role.members.assigned') }).click()
  await expect(row(page, first)).toBeVisible()
  await expect(row(page, second)).toBeVisible()
  await row(page, second)
    .getByRole('button', { name: msg('iam.role.members.revoke'), exact: true })
    .click()
  await page
    .getByRole('dialog', { name: msg('crud.confirm.title') })
    .getByRole('button', { name: msg('iam.role.members.revoke'), exact: true })
    .click()
  await expect(page.getByText(msg('iam.role.members.revoked'), { exact: true })).toBeVisible()
  await expect(row(page, second)).toHaveCount(0)
  await expect(row(page, first)).toBeVisible()

  await button(page, 'iam.role.members.back').click()
  await expect(page).toHaveURL(/\/iam\/roles$/)

  // leave nothing behind: out of the role, then the role
  const users = await request.get(`/api/iam/roles/${role.id}/members`, { headers: admin })
  const ids = ((await users.json()) as { data: { items: { id: number }[] } }).data.items.map(
    (u) => u.id,
  )
  const revoked = await request.post(`/api/iam/roles/${role.id}/members/revoke`, {
    headers: admin,
    data: { userIds: ids },
  })
  expect(revoked.ok(), await revoked.text()).toBe(true)
  const removed = await request.delete(`/api/iam/roles/${role.id}`, { headers: admin })
  expect(removed.ok(), await removed.text()).toBe(true)
})

test('perm-reload: new button menus granted to a role reach its signed-in user at the next request, no new sign-in; taken back, they go again', async ({
  page,
  request,
}) => {
  const admin = { Authorization: await bearer(request) }
  const call = async <T>(method: 'get' | 'post' | 'put' | 'delete', url: string, data?: object) => {
    const res = await request[method](url, { headers: admin, data })
    expect(res.ok(), await res.text()).toBe(true)
    return ((await res.json()) as { data: T }).data
  }
  interface MenuRow {
    id: number
    routeName: string | null
    children: MenuRow[]
  }
  const flat = (rows: MenuRow[]): MenuRow[] => rows.flatMap((r) => [r, ...flat(r.children)])
  const positions = flat(await call<MenuRow[]>('get', '/api/iam/menus')).find(
    (m) => m.routeName === 'iam-position',
  )!
  const [role] = (await call<{ items: { id: number }[] }>('get', '/api/iam/roles?code=e2e_reader'))
    .items
  const granted = await call<{ menuLink: boolean; menuIds: number[] }>(
    'get',
    `/api/iam/roles/${role!.id}/menus`,
  )

  // the reader (positions: browse only) on the positions page: no create button, no enabled switch
  await signIn(page, 'reader', '/iam/positions')
  const held = row(page, msg('seed.position.engLead'))
  await expect(held).toContainText('启用')
  const create = button(page, 'crud.action.create')
  await expect(create).toHaveCount(0)
  await expect(page.getByRole('switch')).toHaveCount(0)

  // admin: two new button menus under the positions page (create, modify), granted to the reader's role
  const added: { id: number }[] = []
  const grant = (menuIds: number[]) =>
    call('put', `/api/iam/roles/${role!.id}/menus`, { menuLink: granted.menuLink, menuIds })
  try {
    for (const perm of ['iam.position.create', 'iam.position.modify'])
      added.push(
        await call<{ id: number }>('post', '/api/iam/menus', {
          parentId: positions.id,
          kind: 'action',
          name: `e2e-perm-reload ${perm}`,
          perms: perm,
        }),
      )
    await grant([...granted.menuIds, ...added.map((m) => m.id)])

    // the reader's next request (a search) brings them: the button and the switch, same session
    await button(page, 'crud.action.search').click()
    await expect(create).toBeVisible()
    await expect(held.getByRole('switch')).toBeChecked() // modify: the switch instead of the tag

    // taken back: gone again at the next request
    await grant(granted.menuIds)
    await button(page, 'crud.action.search').click()
    await expect(create).toHaveCount(0)
    await expect(page.getByRole('switch')).toHaveCount(0)
  } finally {
    // the reader's role as it was (perm.spec relies on it), then the menus
    await grant(granted.menuIds)
    for (const m of added) await call('delete', `/api/iam/menus/${m.id}`)
  }
})
