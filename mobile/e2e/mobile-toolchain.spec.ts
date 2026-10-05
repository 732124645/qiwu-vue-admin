// Harness smoke (toolchain): the H5 build starts without errors (the sign-in page runs the @qiwu/shared
// schemas: mobile-login.spec), and /api reaches the mobile e2e server through the preview proxy.
import { expect, test } from '@playwright/test'

test('H5 build starts and proxies /api to the mobile e2e server', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await expect(page.locator('.qw-login__title')).toBeVisible()
  const health = await page.request.get('/api/health')
  // the backend's envelope, not the preview's SPA fallback page
  expect(await health.json()).toMatchObject({ code: 0, data: { status: 'ok' } })
  expect(errors).toEqual([])
})
