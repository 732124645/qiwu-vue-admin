import { expect, msg, signIn, test } from './fixtures.ts'

// apidocs: the 系统工具 → 系统接口 menu (link_type iframe) shows the Swagger UI of
// /api/docs inside the layout. With SWAGGER_ENABLED=false GET /menus leaves the menu out: core-auth.e2e.

test('API docs: the iframe menu page loads the Swagger UI from /api/docs', async ({ page }) => {
  await signIn(page, 'admin', '/home')
  const menu = page.getByRole('navigation', { name: msg('common.layout.sideMenu') })
  await menu.getByText(msg('menu.devtools.title'), { exact: true }).click()
  const loaded = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/docs' && r.ok())
  await menu.getByRole('menuitem', { name: msg('menu.devtools.apiDocs') }).click()
  await expect(page).toHaveURL(/\/devtools\/api-docs$/)
  await loaded

  const frame = page.frameLocator(`iframe[src="/api/docs"]`)
  await expect(frame.getByRole('heading', { name: /Qiwu API/ })).toBeVisible()
  // the document itself, not only a shell: operations of a known tag are listed
  await expect(frame.getByText('/api/auth/login', { exact: true }).first()).toBeVisible()
  await expect(page.locator('iframe[src="/api/docs"]')).toHaveAttribute(
    'title',
    msg('menu.devtools.apiDocs'),
  )

  // kept alive (component_name DevtoolsApiDocs): back from another tag, the same document, not a reload
  const docsFrame = page.frames().find((f) => new URL(f.url()).pathname === '/api/docs')!
  await docsFrame.evaluate(`window.qwKept = true`)
  const tags = page.getByRole('navigation', { name: msg('common.tags.label') })
  await tags.getByRole('link', { name: msg('menu.home'), exact: true }).click()
  await expect(page).toHaveURL(/\/home$/)
  // the docs page has left the screen (not just mid-transition), so it is parked for real
  await expect(page.locator('iframe[src="/api/docs"]')).toBeHidden()
  await tags.getByRole('link', { name: msg('menu.devtools.apiDocs'), exact: true }).click()
  await expect(page).toHaveURL(/\/devtools\/api-docs$/)
  expect(await docsFrame.evaluate(`window.qwKept`)).toBe(true)
})
