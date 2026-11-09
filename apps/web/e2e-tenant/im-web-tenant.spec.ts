// Chat and the tenant's package (multi-tenancy channel): a tenant whose package leaves out the chat group
// shows no chat entry in the header and "not enabled" on the chat page; with the group back in its
// package the entry shows again. The default tenant is not restricted by a package.
import { e2eServerEnv, serverDir, TENANT_B } from '../e2e/env.ts'
import { bearer, expect, msg, signIn, test } from '../e2e/fixtures.ts'
import {
  chatEntry,
  cleanupIm,
  desktopScript,
  imBearer,
  imSignIn,
  seedImUsers,
  type ImFixture,
} from '../e2e/im-fixtures.ts'

const run = desktopScript(serverDir, e2eServerEnv(serverDir, true))
let fixture: ImFixture
let ids: { pkg: number; im: number }
test.describe.configure({ mode: 'serial', timeout: 90_000 })

test.beforeAll(() => {
  fixture = seedImUsers(run, `e2eimt${Date.now() % 100000}`, ['emp'], TENANT_B.code)
  ids = JSON.parse(
    run(
      `
import { DataSource } from 'typeorm'
import { dataSourceOptions } from './dist/db/data-source.js'
const ds = await new DataSource(dataSourceOptions()).initialize()
try {
 const [t] = await ds.query('SELECT package_id FROM iam_tenant WHERE code = ? AND deleted_at IS NULL', [process.env.TENANT_CODE])
 const [m] = await ds.query("SELECT id FROM iam_menu WHERE route_name = 'im' AND deleted_at IS NULL")
 console.log(JSON.stringify({ pkg: Number(t.package_id), im: Number(m.id) }))
} finally { await ds.destroy() }
`,
      { TENANT_CODE: TENANT_B.code },
    )
      .trim()
      .split('\n')
      .at(-1)!,
  ) as { pkg: number; im: number }
})
test.afterAll(() => cleanupIm(run, fixture))

test('a package without chat hides the entry; with chat it shows', async ({ page, request }) => {
  const headers = { Authorization: await bearer(request) }
  const res = await request.get(`/api/iam/tenant-packages/${ids.pkg}`, { headers })
  expect(res.ok(), await res.text()).toBe(true)
  const menuIds = ((await res.json()) as { data: { menuIds: number[] } }).data.menuIds
  expect(menuIds).toContain(ids.im)
  const put = (list: number[]) =>
    request.put(`/api/iam/tenant-packages/${ids.pkg}`, { headers, data: { menuIds: list } })
  try {
    expect((await put(menuIds.filter((id) => id !== ids.im))).ok()).toBe(true)
    await imSignIn(page, fixture.users[0]!, '/', TENANT_B.code)
    await expect(page.getByRole('button', { name: msg('common.layout.userMenu') })).toBeVisible()
    await expect(chatEntry(page)).toHaveCount(0)
    await page.goto('/im/chat')
    await expect(page.getByText(msg('im.disabled'))).toBeVisible()
    const direct = await request.get('/api/im/options', {
      headers: await imBearer(request, fixture.users[0]!, TENANT_B.code),
    })
    expect(direct.status()).toBe(404)
  } finally {
    expect((await put(menuIds)).ok()).toBe(true)
  }
  await imSignIn(page, fixture.users[0]!, '/', TENANT_B.code)
  await expect(chatEntry(page)).toBeVisible()
})

test('the default tenant is not restricted by a package', async ({ page }) => {
  await signIn(page, 'admin', '/')
  await expect(chatEntry(page)).toBeVisible()
})
