// The generated uni-app pages (apps/server/codegen-templates/uni, the demo modules' golden files under
// pages-biz/demo, registered in pages.json) on the H5 build, over the demo APIs: a book through the list, add
// (the shared rules first), detail, edit and delete; the topic tree one level down and a child added there; an
// invoice saved with a line. Signed in as the seeded root (every permission).
import { expect, test, type Page } from '@playwright/test'
import { USERS, bearer, clientIp, data, signIn } from './env'

const field = (page: Page, label: string) => page.locator('.qw-field', { hasText: label })
const input = (page: Page, label: string) => field(page, label).locator('input')
const cell = (page: Page, label: string) => page.locator('.wd-cell', { hasText: label })
const card = (page: Page, text: string) => page.locator('.qw-card.qw-row', { hasText: text })
const button = (page: Page, text: string) =>
  page.locator('uni-button', { hasText: new RegExp(`^\\s*${text}\\s*$`) })
/** uni.showToast with `icon: 'none'` */
const toast = (page: Page) => page.locator('.uni-simple-toast__text')
/** uni-h5 hands an input's value to v-model at most every 100 ms: let the last one land before saving */
const typed = (page: Page) => page.waitForTimeout(150)
const answer = (page: Page, method: string, path: RegExp) =>
  page.waitForResponse(
    (r) => r.request().method() === method && path.test(new URL(r.url()).pathname),
  )

/** The root signs in on a fresh app (a client IP of its own) and opens `/pages-biz/demo/<path>`. */
async function openAsRoot(page: Page, path: string) {
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': clientIp() })
  await page.goto('/')
  await signIn(page, USERS.admin)
  await page.goto(`/#/pages-biz/demo/${path}`)
}

async function pick(page: Page, label: string, choice: string) {
  await field(page, label).locator('.wd-cell').click()
  await page.locator('.wd-select-picker__radio-item', { hasText: choice }).click()
  await expect(field(page, label)).toContainText(choice)
}

test('book: list → add (rules first) → detail → edit → delete', async ({ page }) => {
  test.slow()
  await openAsRoot(page, 'book/index')
  await expect(page).toHaveTitle('图书')
  // the search binds the label column: nothing matches yet
  await page.locator('.wd-search input').fill('m-cg-none')
  await page.locator('.wd-search input').press('Enter')
  await expect(page.locator('.qw-empty')).toContainText('暂无数据')
  await page.locator('.wd-search input').fill('')
  await page.locator('.wd-search input').press('Enter')

  await button(page, '新增').click()
  await expect(page).toHaveURL(/#\/pages-biz\/demo\/book\/form$/)
  await expect(page).toHaveTitle('新增图书')
  // nothing is posted until the shared rules pass
  let posts = 0
  page.on(
    'request',
    (r) => void (r.method() === 'POST' && r.url().endsWith('/api/demo/books') && posts++),
  )
  await button(page, '保存').click()
  for (const [label, message] of [
    ['ISBN', 'ISBN不能为空'],
    ['书名', '书名不能为空'],
    ['分类', '分类不能为空'],
  ])
    await expect(field(page, label!).locator('.qw-field__error')).toHaveText(message!)
  expect(posts).toBe(0)

  await input(page, 'ISBN').fill('978-7-m-cg-01')
  await input(page, '书名').fill('m-cg Mobile book')
  await input(page, '作者').fill('m-cg author')
  await pick(page, '分类', '小说')
  await expect(page.locator('.qw-form .qw-field__error')).toHaveCount(0)
  await typed(page)
  const created = answer(page, 'POST', /^\/api\/demo\/books$/)
  await button(page, '保存').click()
  const res = await created
  expect(res.status(), await res.text()).toBe(201)
  expect(res.request().postDataJSON()).toMatchObject({
    isbn: '978-7-m-cg-01',
    title: 'm-cg Mobile book',
    author: 'm-cg author',
    genre: 'fiction',
    price: 0,
    enabled: true,
  })
  const { id } = ((await res.json()) as { data: { id: number } }).data
  await expect(toast(page)).toHaveText('新增成功')
  // back on the list, refreshed
  await expect(page).toHaveURL(/#\/pages-biz\/demo\/book\/index$/)
  await expect(card(page, 'm-cg Mobile book')).toContainText('978-7-m-cg-01 · m-cg author')

  await card(page, 'm-cg Mobile book').click()
  await expect(page).toHaveURL(new RegExp(`#/pages-biz/demo/book/detail\\?id=${id}$`))
  await expect(page).toHaveTitle('查看图书')
  await expect(cell(page, '书名')).toContainText('m-cg Mobile book')
  await expect(cell(page, '分类')).toContainText('小说')
  await expect(cell(page, '定价')).toContainText('0.00')

  await button(page, '编辑').click()
  await expect(page).toHaveURL(new RegExp(`#/pages-biz/demo/book/form\\?id=${id}$`))
  await expect(page).toHaveTitle('编辑图书')
  await expect(input(page, '书名')).toHaveValue('m-cg Mobile book')
  await expect(field(page, '分类')).toContainText('小说')
  await input(page, '书名').fill('m-cg Mobile book 2')
  await typed(page)
  const updated = answer(page, 'PUT', new RegExp(`^/api/demo/books/${id}$`))
  await button(page, '保存').click()
  expect((await updated).status()).toBe(200)
  await expect(toast(page)).toHaveText('保存成功')
  // back on the detail, reloaded
  await expect(page).toHaveURL(new RegExp(`#/pages-biz/demo/book/detail\\?id=${id}$`))
  await expect(cell(page, '书名')).toContainText('m-cg Mobile book 2')

  await button(page, '删除').click()
  const removed = answer(page, 'DELETE', new RegExp(`^/api/demo/books/${id}$`))
  await page.locator('.uni-modal__btn_primary').click()
  expect((await removed).status()).toBe(200)
  await expect(toast(page)).toHaveText('删除成功')
  await expect(page).toHaveURL(/#\/pages-biz\/demo\/book\/index$/)
  await expect(card(page, 'm-cg Mobile book')).toHaveCount(0)
})

test('topic: a node with children drills one level down; a child added there', async ({
  page,
  request,
}) => {
  const admin = await bearer(request, USERS.admin)
  const add = (body: object) =>
    data<{ id: number }>(request.post('/api/demo/topics', { headers: admin, data: body }))
  const top = await add({ title: 'm-cg Top' })
  const child = await add({ title: 'm-cg Child', parentId: top.id })

  await openAsRoot(page, 'topic/index')
  await expect(page).toHaveTitle('知识主题')
  await expect(card(page, 'm-cg Child')).toHaveCount(0)
  await card(page, 'm-cg Top').locator('.qw-sec__link').click()
  await expect(page).toHaveURL(new RegExp(`#/pages-biz/demo/topic/index\\?parentId=${top.id}$`))
  await expect(page).toHaveTitle('m-cg Top')
  await expect(card(page, 'm-cg Top')).toHaveCount(0)
  await expect(card(page, 'm-cg Child')).not.toContainText('下级')

  await card(page, 'm-cg Child').click()
  await expect(page).toHaveURL(new RegExp(`#/pages-biz/demo/topic/detail\\?id=${child.id}$`))
  await expect(cell(page, '主题名称')).toContainText('m-cg Child')
  await button(page, '新增下级').click()
  await expect(page).toHaveURL(new RegExp(`#/pages-biz/demo/topic/form\\?parentId=${child.id}$`))
  // the parent comes from the page's query, read-only (moving a node stays on the web)
  await expect(cell(page, '上级主题')).toContainText('m-cg Child')
  await input(page, '主题名称').fill('m-cg Grandchild')
  await typed(page)
  const created = answer(page, 'POST', /^\/api\/demo\/topics$/)
  await button(page, '保存').click()
  const res = await created
  expect(res.status(), await res.text()).toBe(201)
  expect(res.request().postDataJSON()).toMatchObject({
    parentId: child.id,
    title: 'm-cg Grandchild',
  })
  await expect(page).toHaveURL(new RegExp(`#/pages-biz/demo/topic/detail\\?id=${child.id}$`))
})

test('invoice: saved with one line, shown on its detail', async ({ page }) => {
  await openAsRoot(page, 'invoice/index')
  await expect(page).toHaveTitle('发票')
  await button(page, '新增').click()
  await expect(page).toHaveURL(/#\/pages-biz\/demo\/invoice\/form$/)
  await input(page, '发票号码').fill('M-CG-0001')
  await input(page, '购买方').fill('m-cg buyer')
  await expect(page.locator('.qw-form__hint')).toHaveText('暂无明细，点击下方按钮添加')
  await button(page, '添加一行').click()
  await expect(page.locator('.qw-sec', { hasText: '第 1 行' })).toBeVisible()
  await input(page, '品名').fill('m-cg pen')
  await field(page, '单价').locator('input').fill('12.5')
  await field(page, '单价').locator('input').blur()
  await typed(page)
  const created = answer(page, 'POST', /^\/api\/demo\/invoices$/)
  await button(page, '保存').click()
  const res = await created
  expect(res.status(), await res.text()).toBe(201)
  expect(res.request().postDataJSON()).toMatchObject({
    invoiceNo: 'M-CG-0001',
    buyer: 'm-cg buyer',
    state: 'draft',
    lines: [{ item: 'm-cg pen', qty: 1, unitPrice: 12.5 }],
  })
  await expect(page).toHaveURL(/#\/pages-biz\/demo\/invoice\/index$/)

  await card(page, 'M-CG-0001').click()
  await expect(page).toHaveTitle('查看发票')
  await expect(cell(page, '购买方')).toContainText('m-cg buyer')
  await expect(cell(page, '状态')).toContainText('草稿')
  await expect(page.locator('.wd-cell-group', { hasText: '第 1 行' })).toContainText('m-cg pen')
  await expect(cell(page, '单价')).toContainText('12.50')
})

test('browse without view: a book card stays on the list', async ({ page, request }) => {
  type Menu = { id: number; perms: string | null; children: Menu[] }
  const admin = await bearer(request, USERS.admin)
  const role = await data<{ id: number }>(request.post('/api/iam/roles', {
    headers: admin, data: { name: 'M-cg browse', code: 'm_cg_browse' },
  }))
  const menus = await data<Menu[]>(request.get('/api/iam/roles/menu-tree', { headers: admin }))
  const flatten = (nodes: Menu[]): Menu[] => nodes.flatMap((n) => [n, ...flatten(n.children)])
  const browse = flatten(menus).find((n) => n.perms === 'demo.book.browse')!
  expect(browse).toBeDefined()
  await data(request.put(`/api/iam/roles/${role.id}/menus`, {
    headers: admin, data: { menuLink: false, menuIds: [browse.id] },
  }))
  await data(request.put(`/api/iam/roles/${role.id}/data-scope`, {
    headers: admin, data: { dataScope: 'all', deptLink: false, deptIds: [] },
  }))
  const user = { username: 'm_cg_browse', password: 'E2e-Pass@2026' }
  await data(request.post('/api/iam/users', {
    headers: admin, data: { ...user, displayName: 'M-cg browse', roleIds: [role.id] },
  }))
  const headers = await bearer(request, user)
  const password = 'E2e-NewPass@2026'
  await data(request.put('/api/iam/profile/password', {
    headers, data: { oldPassword: user.password, newPassword: password, confirmPassword: password },
  }))
  const reader = { ...user, password }
  const session = await bearer(request, reader)
  const me = await data<{ perms: string[] }>(request.get('/api/auth/me', { headers: session }))
  expect(me.perms).toContain('demo.book.browse')
  expect(me.perms).not.toContain('demo.book.view')
  const book = await data<{ id: number }>(request.post('/api/demo/books', {
    headers: admin, data: { isbn: '978-7-m-cg-browse', title: 'm-cg Browse only', genre: 'fiction' },
  }))
  expect((await request.get(`/api/demo/books/${book.id}`, { headers: session })).status()).toBe(403)

  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': clientIp() })
  await page.goto('/')
  await signIn(page, reader)
  await page.goto('/#/pages-biz/demo/book/index')
  const row = card(page, 'm-cg Browse only')
  await expect(row).toBeVisible()
  await expect(row).not.toHaveAttribute('role', 'link')
  let details = 0
  page.on('request', (r) => void (r.url().endsWith(`/api/demo/books/${book.id}`) && details++))
  await row.click()
  await page.waitForTimeout(300)
  await expect(page).toHaveURL(/#\/pages-biz\/demo\/book\/index$/)
  expect(details).toBe(0)
})
