import { createRequire } from 'node:module'
import { USERS } from './env.ts'
import { currentPage, bearer, expect, msg, signIn, test } from './fixtures.ts'

// The personal center (acceptance): the header avatar follows a cropped upload; changing the password
// ends the other sessions; the chosen language survives a reload (and is saved to the account).

const EN = 'en-US'
const NEW_PASSWORD = 'E2e-Profile@2026'

/** sharp from the server's dependencies draws the image to crop (no web dependency for a test) */
const sharp = createRequire(new URL('../../server/package.json', import.meta.url))('sharp') as (o: {
  create: { width: number; height: number; channels: 3; background: object }
}) => { png(): { toBuffer(): Promise<Buffer> } }

test('profile: read-only org data, name and cropped avatar reach the header', async ({ page }) => {
  await signIn(page, 'profile', '/profile')
  await expect(currentPage(page, 'profile.title')).toBeVisible()
  // dept, roles and positions are shown, not editable (seeded names follow the language)
  for (const key of ['seed.dept.support', 'seed.role.demo', 'seed.position.support'])
    await expect(page.getByText(msg(key), { exact: true })).toBeVisible()

  await page.getByRole('textbox', { name: msg('field.iam.user.displayName') }).fill('E2E Profile')
  await page.getByRole('button', { name: msg('crud.action.save'), exact: true }).click()
  await expect(page.getByText(msg('profile.saved'))).toBeVisible()
  const header = page.getByRole('button', { name: msg('common.layout.userMenu') })
  await expect(header).toContainText('E2E Profile')

  // crop and upload: the header avatar becomes the stored 256×256 webp
  await expect(header.locator('img')).toHaveCount(0)
  await page.getByRole('button', { name: msg('profile.changeAvatar') }).click()
  const dialog = page.getByRole('dialog', { name: msg('upload.avatar.title') })
  const png = await sharp({
    create: { width: 320, height: 240, channels: 3, background: { r: 31, g: 111, b: 235 } },
  })
    .png()
    .toBuffer()
  await dialog
    .locator('input[type=file]')
    .setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: png })
  await expect(dialog.locator('cropper-canvas')).toBeVisible()
  await dialog.getByRole('button', { name: msg('crud.action.save'), exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText(msg('profile.avatarDone'))).toBeVisible()
  const avatar = header.locator('img')
  await expect(avatar).toHaveAttribute('src', /^\/files\/.+\.webp$/)
  const file = await page.request.get((await avatar.getAttribute('src'))!)
  expect(file.headers()['content-type']).toBe('image/webp')
  // the page shows the same image
  await expect(page.locator('.profile__avatar img')).toHaveAttribute(
    'src',
    (await avatar.getAttribute('src'))!,
  )
})

test('language: switched in the profile, still that language after a reload and saved to the account', async ({
  page,
  request,
}) => {
  await signIn(page, 'profile', '/profile')
  await page.getByRole('tab', { name: msg('profile.tabs.prefs') }).click()
  const [saved] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/iam/profile/locale')),
    page.getByRole('radio', { name: msg('common.language.enUS') }).check({ force: true }),
  ])
  expect(saved.ok()).toBe(true)
  await expect(page.locator('html')).toHaveAttribute('lang', EN)
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('lang', EN)
  await expect(currentPage(page, 'profile.title', EN)).toBeVisible()
  const me = await request.get('/api/iam/profile', {
    headers: { Authorization: await bearer(request, USERS.profile) },
  })
  expect(((await me.json()) as { data: { locale: string } }).data.locale).toBe(EN)
})

test('password: changing it in the profile ends the other sessions, not this one', async ({
  page,
  browser,
  request,
}) => {
  const other = await browser.newContext()
  try {
    const old = await bearer(other.request, USERS.profile)
    const me = () => other.request.get('/api/auth/me', { headers: { Authorization: old } })
    expect((await me()).status()).toBe(200)

    await signIn(page, 'profile', '/profile')
    await page.getByRole('tab', { name: msg('profile.tabs.password') }).click()
    const label = (key: string) =>
      page.getByLabel(msg(`common.passwordChange.${key}`), { exact: true })
    await label('oldPassword').fill(USERS.profile.password)
    await label('newPassword').fill(NEW_PASSWORD)
    await label('confirmPassword').fill(NEW_PASSWORD)
    await page.getByRole('button', { name: msg('common.passwordChange.submit') }).click()
    await expect(page.getByText(msg('common.passwordChange.done'))).toBeVisible()
    await expect(label('oldPassword')).toHaveValue('')

    expect((await me()).status()).toBe(401)
    // this session stays signed in
    await page.reload()
    await expect(currentPage(page, 'profile.title')).toBeVisible()
  } finally {
    await other.close()
  }

  // back to the seeded password, so a rerun on the same database signs in again
  const res = await request.put('/api/iam/profile/password', {
    headers: {
      Authorization: await bearer(request, { ...USERS.profile, password: NEW_PASSWORD }),
    },
    data: { oldPassword: NEW_PASSWORD, newPassword: USERS.profile.password },
  })
  expect(res.ok(), await res.text()).toBe(true)
})
