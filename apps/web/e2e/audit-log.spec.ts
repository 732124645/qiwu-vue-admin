import { bearer, expect, msg, signIn, test } from './fixtures.ts'

for (const kind of ['signin', 'action'] as const) {
  test(`${kind} log: the user type dict labels switch in the list and detail`, async ({ page }) => {
    // Login writes a sign-in row; exporting writes an action row. Both carry the trusted admin type.
    if (kind === 'action') {
      const Authorization = await bearer(page.request)
      const res = await page.request.get('/api/audit/action-logs/export', {
        headers: { Authorization },
      })
      expect(res.ok()).toBe(true)
    }
    await signIn(page, 'admin', `/audit/${kind}-logs`)
    const field = `field.audit.${kind}Log.userType`
    const link = kind === 'signin' ? 'admin' : 'audit.actionLog'
    const row = page.locator('.el-table__body .el-table__row').filter({ hasText: link }).first()
    await expect(row).toBeVisible()
    for (const [locale, label] of [
      ['zh-CN', '管理员'],
      ['en-US', 'Administrator'],
    ] as const) {
      if (locale === 'en-US') {
        await page.getByRole('button', { name: msg('common.layout.language') }).click()
        await page.getByRole('menuitem', { name: msg('common.language.enUS') }).click()
        await expect(page.locator('html')).toHaveAttribute('lang', locale)
      }
      await expect(row.getByRole('cell', { name: label, exact: true })).toBeVisible()
      await row.getByRole('button', { name: link, exact: true }).click()
      const drawer = page.getByRole('dialog', {
        name: msg('crud.title.detail', locale, { name: msg(`audit.${kind}Log.entity`, locale) }),
      })
      await expect(drawer).toBeVisible()
      const detail = drawer
        .locator('.el-descriptions__body tr')
        .filter({ hasText: msg(field, locale) })
      await expect(detail.locator('.el-descriptions__content')).toHaveText(label)
      await drawer.getByRole('button', { name: /close|关闭/i }).click()
      await expect(drawer).toBeHidden()
    }
  })
}
