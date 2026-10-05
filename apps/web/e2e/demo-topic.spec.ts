import { currentPage, bearer, expect, msg, signIn, test, type Page } from './fixtures.ts'

// The generated demo_topic page (the tree template's G0 sample): reached through 系统工具 / 生成示例
// in the side menu, then add two roots (the shared zod rules first) → add a child below one → move it
// under the other in the edit form (its own row is not offered as a parent) → delete (a row with a
// child only once the child is gone).

const [A, B, C] = ['e2e-topic-root-a', 'e2e-topic-root-b', 'e2e-topic-child']
const entity = msg('demo.topic.entity')
const field = (prop: string) => msg(`field.demo.topic.${prop}`)
const button = (page: Page, key: string) =>
  page.getByRole('button', { name: msg(key), exact: true })
const row = (page: Page, text: string) => page.getByRole('row').filter({ hasText: text })
const dialog = (page: Page, key: 'create' | 'edit') =>
  page.getByRole('dialog', { name: msg(`crud.title.${key}`, 'zh-CN', { name: entity }) })
type Dialog = ReturnType<typeof dialog>
/** The dialog's parent tree select (its wrapper: the input under a shown value takes no click). */
const parentField = (d: Dialog) =>
  d.locator('.el-form-item', { hasText: field('parentId') }).locator('.el-select__wrapper')
const options = (page: Page) => page.locator('.el-select-dropdown').filter({ visible: true })

async function addRoot(page: Page, title: string) {
  await button(page, 'crud.action.create').click()
  const create = dialog(page, 'create')
  await create.getByRole('textbox', { name: field('title') }).fill(title)
  await create.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(create).toBeHidden()
  await expect(row(page, title)).toBeVisible()
}

async function removeRow(page: Page, text: string) {
  await row(page, text)
    .getByRole('button', { name: msg('crud.action.delete'), exact: true })
    .click()
  await page
    .getByRole('dialog', { name: msg('crud.confirm.title') })
    .getByRole('button', { name: msg('crud.action.delete'), exact: true })
    .click()
  await expect(row(page, text)).toHaveCount(0)
}

test('topics: menu → add root → add child → move → delete', async ({ page, request }) => {
  await signIn(page, 'admin', '/home')
  const menu = page.getByRole('navigation', { name: msg('common.layout.sideMenu') })
  await menu.getByText(msg('menu.devtools.title')).click()
  await menu.getByText(msg('menu.demo.title')).click()
  await menu.getByRole('menuitem', { name: msg('menu.demo.topic') }).click()
  await expect(page).toHaveURL(/\/demo\/topics$/)
  await expect(currentPage(page, 'menu.demo.topic')).toBeVisible()

  // add a root: the shared zod rules are checked first; the parent starts empty (top level)
  await button(page, 'crud.action.create').click()
  const create = dialog(page, 'create')
  await expect(parentField(create)).toContainText(msg('crud.tree.topLevel'))
  await create.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(
    create.getByText(msg('validation.required', 'zh-CN', { field: field('title') })),
  ).toBeVisible()
  await create.getByRole('textbox', { name: field('title') }).fill(A)
  await create.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(page.getByText(msg('crud.msg.created'))).toBeVisible()
  await expect(create).toBeHidden()
  await addRoot(page, B)

  // add a child below A: the parent is preset
  await row(page, A)
    .getByRole('button', { name: msg('crud.action.addChild') })
    .click()
  const child = dialog(page, 'create')
  await expect(parentField(child)).toContainText(A)
  await child.getByRole('textbox', { name: field('title') }).fill(C)
  await child.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(child).toBeHidden()
  await expect(row(page, C)).toBeVisible()
  // a row with a child is not deleted
  await expect(
    row(page, A).getByRole('button', { name: msg('crud.action.delete'), exact: true }),
  ).toBeDisabled()

  // move C under B in the edit form: the picker leaves out C itself
  await row(page, C)
    .getByRole('button', { name: msg('crud.action.edit') })
    .click()
  const edit = dialog(page, 'edit')
  await expect(edit.getByRole('textbox', { name: field('title') })).toHaveValue(C)
  await expect(parentField(edit)).toContainText(A)
  await parentField(edit).click()
  await expect(options(page).getByText(B, { exact: true })).toBeVisible()
  await expect(options(page).getByText(C, { exact: true })).toHaveCount(0)
  await options(page).getByText(B, { exact: true }).click()
  await edit.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(edit).toBeHidden()

  // the stored tree: C under B with B's path
  interface Topic {
    id: number
    title: string
    treePath: string
    children: Topic[]
  }
  const res = await request.get('/api/demo/topics', {
    headers: { Authorization: await bearer(request) },
    params: { title: 'e2e-topic-' },
  })
  expect(res.ok(), await res.text()).toBe(true)
  const forest = ((await res.json()) as { data: Topic[] }).data
  const [a, b] = [A, B].map((t) => forest.find((n) => n.title === t)!)
  expect(a!.children).toEqual([])
  expect(b!.children.map((n) => n.title)).toEqual([C])
  expect(b!.children[0]!.treePath).toBe(`${b!.treePath}${b!.children[0]!.id}/`)
  await expect(
    row(page, A).getByRole('button', { name: msg('crud.action.delete'), exact: true }),
  ).toBeEnabled()
  await expect(
    row(page, B).getByRole('button', { name: msg('crud.action.delete'), exact: true }),
  ).toBeDisabled()

  // delete: the child first, then the roots
  await removeRow(page, C)
  await expect(page.getByText(msg('crud.msg.deleted'))).toBeVisible()
  await removeRow(page, B)
  await removeRow(page, A)
})
