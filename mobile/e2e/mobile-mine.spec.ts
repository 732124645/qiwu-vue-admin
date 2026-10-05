// "Me" on the H5 build: who I am, my profile (edits under the shared rules, read-only dept / roles), the
// avatar picked and sent with uni.uploadFile to the backend upload (served back through /files), the password
// change (form rules, the server's wrong-old-password message, sign-in with the new one), an initial password
// that must be changed first, the language (this device and the account), about, and sign-out.
import { expect, test, type Page } from '@playwright/test'
import { HOME, clientIp, serverScript, signIn, tab, type User } from './env'

/** role `demo`, dept support: one for profile / language / sign-out, one whose password changes */
const USER: User = { username: 'm_mine', password: 'E2e-Pass@2026' }
const PASS: User = { username: 'm_pass', password: 'E2e-Pass@2026' }
/** never changed its password (password_changed_at NULL): the server allows only the change and sign-out */
const INITIAL: User & { initial: true } = {
  username: 'm_initial',
  password: 'E2e-Pass@2026',
  initial: true,
}
const NEW_PASSWORD = 'E2e-Next@2026'
/** a 4×4 PNG: the server turns it into a 256×256 webp */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVQImWOQz38NRwzEcQBYMheR5d2h5wAAAABJRU5ErkJggg==',
  'base64',
)

// straight into the throwaway database
const SEED = `
import { DataSource } from 'typeorm'
import { dataSourceOptions } from './dist/db/data-source.js'
import { seedLimitedUser } from './dist/db/seeds/iam/iam.seed.js'
const ds = await new DataSource(dataSourceOptions()).initialize()
try {
  await ds.transaction(async (q) => {
    for (const user of JSON.parse(process.env.USERS)) {
      const id = await seedLimitedUser(q, user.username, user.password)
      if (user.initial) await q.query('UPDATE iam_user SET password_changed_at = NULL WHERE id = ?', [id])
    }
  })
} finally {
  await ds.destroy()
}
`

const cell = (page: Page, text: string) => page.locator('.wd-cell', { hasText: text })
/** a row of the "Me" menu: profile, password, language, appearance, about */
const menu = (page: Page, name: string) => page.locator(`.qw-menu__item.qw-mine__${name}`)
const input = (page: Page, name: string) => page.locator(`.qw-${name} input`)
const fieldError = (page: Page, name: string) => page.locator(`.qw-${name} .qw-field__error`)
/** uni.showToast with `icon: 'none'` */
const toast = (page: Page) => page.locator('.uni-simple-toast__text')
/**
 * uni-h5 hands an input's value to v-model at most every 100 ms, and a refilled field fires two input events:
 * let the last one land before submitting (a user's tap comes later than that).
 */
const typed = (page: Page) => page.waitForTimeout(150)
const answer = (page: Page, method: string, path: string) =>
  page.waitForResponse((r) => r.request().method() === method && r.url().endsWith(`/api${path}`))

async function openMine(page: Page, user: User) {
  await page.goto('/')
  await signIn(page, user)
  await tab(page, '我的').click()
  await expect(page).toHaveURL(/#\/pages\/mine\/index$/)
  await expect(page).toHaveTitle('我的')
}

test.beforeAll(() => {
  serverScript(SEED, { USERS: JSON.stringify([USER, PASS, INITIAL]) })
})
// each test signs in as a client of its own: the suite's earlier specs use up the per-IP sign-in limit
test.beforeEach(({ page }) => page.setExtraHTTPHeaders({ 'X-Forwarded-For': clientIp() }))

test('profile: names, edits under the shared rules, avatar through the backend upload', async ({
  page,
}) => {
  await openMine(page, USER)
  await expect(page.locator('.qw-mine__name')).toHaveText(USER.username)
  await expect(page.locator('.qw-mine__chip')).toHaveText(['客户支持组', '演示角色'])

  await page.locator('.qw-mine__card').click()
  await expect(page).toHaveURL(/#\/pages-sys\/profile\/index$/)
  await expect(page).toHaveTitle('个人资料')
  await expect(cell(page, '用户名')).toContainText(USER.username)
  await expect(cell(page, '部门')).toContainText('客户支持组')
  await expect(cell(page, '手机号')).toContainText('请在电脑端修改手机号')

  // the shared rules, with the field labels
  await input(page, 'profile__displayName').fill('')
  await input(page, 'profile__email').fill('not-an-email')
  await page.locator('.qw-profile__save').click()
  await expect(fieldError(page, 'profile__displayName')).toContainText('显示名')
  await expect(fieldError(page, 'profile__email')).toHaveText('邮箱不是有效的邮箱地址')

  await input(page, 'profile__displayName').fill('Mine Tester')
  await input(page, 'profile__email').fill('mine@example.com')
  await page.locator('.qw-profile__gender .wd-radio', { hasText: '女' }).click()
  await typed(page)
  const saved = answer(page, 'PUT', '/iam/profile')
  await page.locator('.qw-profile__save').click()
  const body = (await (await saved).json()).data
  expect(body).toMatchObject({
    displayName: 'Mine Tester',
    email: 'mine@example.com',
    gender: 'female',
  })
  await expect(toast(page)).toHaveText('资料已保存')
  await expect(fieldError(page, 'profile__email')).toHaveCount(0)

  // the avatar: picked, sent as multipart `file`, stored as a public webp, served through /files
  const chooser = page.waitForEvent('filechooser')
  await page.locator('.qw-profile__avatar').click()
  const uploaded = answer(page, 'POST', '/iam/profile/avatar')
  await (await chooser).setFiles({ name: 'me.png', mimeType: 'image/png', buffer: PNG })
  const res = await uploaded
  expect(res.status()).toBe(201)
  const { avatarUrl } = (await res.json()).data as { avatarUrl: string }
  expect(avatarUrl).toMatch(/^\/files\/.+\.webp$/)
  await expect(toast(page)).toHaveText('头像已更新')
  const img = page.locator('.qw-profile__avatar img')
  await expect(img).toHaveAttribute('src', avatarUrl)
  // served on the H5 origin by its /files proxy
  const file = await page.request.get(avatarUrl)
  expect(file.headers()['content-type']).toBe('image/webp')

  // the "Me" card follows
  await page.goBack()
  await expect(page).toHaveURL(/#\/pages\/mine\/index$/)
  await expect(page.locator('.qw-mine__name')).toHaveText('Mine Tester')
  await expect(page.locator('.qw-mine__card img')).toHaveAttribute('src', avatarUrl)
})

test('password: form rules, wrong old password, change, sign in with the new one', async ({
  page,
}) => {
  await openMine(page, PASS)
  await menu(page, 'password').click()
  await expect(page).toHaveURL(/#\/pages-sys\/password\/index$/)
  await expect(page).toHaveTitle('修改密码')
  const submit = page.locator('.qw-password__submit')

  await submit.click()
  await expect(fieldError(page, 'password__oldPassword')).toContainText('旧密码')
  await input(page, 'password__oldPassword').fill(PASS.password)
  await input(page, 'password__newPassword').fill(PASS.password)
  await input(page, 'password__confirmPassword').fill('Other-Pass@2026')
  await typed(page)
  await submit.click()
  await expect(fieldError(page, 'password__newPassword')).toHaveText('新密码不能与旧密码相同')
  await expect(fieldError(page, 'password__confirmPassword')).toHaveText('两次输入的新密码不一致')

  // the server's message for a wrong old password
  await input(page, 'password__oldPassword').fill('Wrong-Pass@2026')
  await input(page, 'password__newPassword').fill(NEW_PASSWORD)
  await input(page, 'password__confirmPassword').fill(NEW_PASSWORD)
  await typed(page)
  await submit.click()
  await expect(page.locator('.qw-form__error')).toHaveText('旧密码不正确')

  await input(page, 'password__oldPassword').fill(PASS.password)
  await typed(page)
  const changed = answer(page, 'PUT', '/iam/profile/password')
  await submit.click()
  expect((await changed).ok()).toBe(true)
  await expect(page).toHaveURL(/#\/pages\/mine\/index$/)
  await expect(toast(page)).toHaveText('密码已修改')

  // this session goes on; after signing out only the new password signs in
  await page.locator('.qw-mine__sign-out').click()
  await page.locator('.uni-modal__btn_primary').click()
  await expect(page.locator('.qw-login__title')).toBeVisible()
  await signIn(page, { ...PASS, password: NEW_PASSWORD })
  await expect(page).toHaveURL(HOME)
})

test('an initial password: only the change page until it is changed, sign-out stays open', async ({
  page,
}) => {
  const passwordPage = /#\/pages-sys\/password\/index$/
  const due = page.locator('.qw-password__due')
  const signInAs = async (user: User) => {
    await page.locator('.qw-login__username input').fill(user.username)
    await page.locator('.qw-login__password input').fill(user.password)
    await page.locator('uni-button', { hasText: /^登录$/ }).click()
  }
  await page.goto('/')
  await signInAs(INITIAL)
  // the workbench's /auth/me sends the session on
  await expect(page).toHaveURL(passwordPage)
  await expect(due).toHaveText('为了账号安全，请先修改初始密码再继续使用。')

  // the app started on a tab page (no /auth/me yet): its own call is refused (403 A1004), back here, no toast
  await page.goto('about:blank')
  await page.goto('/#/pages/message/index')
  await expect(page).toHaveURL(passwordPage)
  await expect(due).toBeVisible()
  await expect(toast(page)).toBeHidden()

  const logout = answer(page, 'POST', '/auth/logout')
  await page.locator('.qw-password__sign-out').click()
  expect((await logout).ok()).toBe(true)
  await expect(page.locator('.qw-login__title')).toBeVisible()
  await signInAs(INITIAL)
  await expect(page).toHaveURL(passwordPage)

  await input(page, 'password__oldPassword').fill(INITIAL.password)
  await input(page, 'password__newPassword').fill(NEW_PASSWORD)
  await input(page, 'password__confirmPassword').fill(NEW_PASSWORD)
  await typed(page)
  const changed = answer(page, 'PUT', '/iam/profile/password')
  await page.locator('.qw-password__submit').click()
  expect((await changed).ok()).toBe(true)
  await expect(page).toHaveURL(HOME)
  await expect(page.locator('.qw-home__name')).toHaveText(`你好，${INITIAL.username}`)
  // the tab pages work now
  await tab(page, '消息').click()
  await expect(page).toHaveURL(/#\/pages\/message\/index$/)
  await expect(page).toHaveTitle('消息')
})

test('language for this device and the account, about, sign out', async ({ page }) => {
  await openMine(page, USER)
  await expect(page.locator('.qw-mine__language')).toContainText('简体中文')
  await page.locator('.qw-mine__language').click()
  const saved = answer(page, 'PUT', '/iam/profile/locale')
  await page.locator('.wd-action-sheet__action', { hasText: 'English' }).click()
  expect((await saved).request().postDataJSON()).toEqual({ locale: 'en-US' })
  expect((await saved).ok()).toBe(true)
  await expect(page).toHaveTitle('Me')
  await expect(page.locator('.qw-tabbar')).toContainText('Workbench')
  await expect(page.locator('.qw-mine__language')).toContainText('English')

  await expect(menu(page, 'about')).toContainText('1.0.0')
  await menu(page, 'about').click()
  await expect(page).toHaveURL(/#\/pages-sys\/about\/index$/)
  await expect(page).toHaveTitle('About')
  await expect(page.locator('.qw-about__version')).toContainText('1.0.0')
  await page.goBack()

  // cancel keeps the session; confirm ends it and forgets the stored refresh token
  await page.locator('.qw-mine__sign-out').click()
  await page.locator('.uni-modal__btn_default').click()
  await expect(page).toHaveURL(/#\/pages\/mine\/index$/)
  await page.locator('.qw-mine__sign-out').click()
  const logout = answer(page, 'POST', '/auth/logout')
  await page.locator('.uni-modal__btn_primary', { hasText: 'Sign out' }).click()
  expect((await logout).ok()).toBe(true)
  await expect(page.locator('.qw-login__title')).toHaveText('Sign in')
  await page.goto('/#/pages/mine/index')
  await expect(page.locator('.qw-login__title')).toBeVisible()
})

test('appearance: dark at once and after a restart; following the system again', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await openMine(page, USER)
  const option = (name: string) =>
    page
      .locator('.wd-action-sheet__action')
      .filter({ has: page.locator('.wd-action-sheet__name', { hasText: new RegExp(`^${name}$`) }) })
  const dark = /(^|\s)qw-dark(\s|$)/

  await expect(page.locator('.qw-mine__appearance')).toContainText('跟随系统')
  await page.locator('.qw-mine__appearance').click()
  await expect(option('跟随系统')).toContainText('当前为浅色')
  await option('深色').click()
  await expect(page.locator('html')).toHaveClass(dark)
  // the dark canvas
  await expect(page.locator('uni-page-body')).toHaveCSS('background-color', 'rgb(8, 13, 22)')
  await expect(page.locator('.qw-mine__appearance')).toContainText('深色')
  // a sub-page's native bar follows the choice, not the light system
  await menu(page, 'about').click()
  await expect(page.locator('.uni-page-head')).toHaveCSS('background-color', 'rgb(15, 22, 36)')
  await page.goBack()

  await page.reload()
  await expect(page.locator('html')).toHaveClass(dark)
  await page.locator('.qw-mine__appearance').click()
  await option('跟随系统').click()
  await expect(page.locator('html')).not.toHaveClass(dark)
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveClass(dark)

  // a sub-page opened by its URL: its native bar is dark from its very first frame (sampled per frame)
  await page.addInitScript(`{
    const seen = (window.qwBars = [])
    const frame = () => {
      const bar = document.querySelector('.uni-page-head')
      const bg = bar && getComputedStyle(bar).backgroundColor
      if (bg && seen.at(-1) !== bg) seen.push(bg)
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }`)
  await page.goto('about:blank')
  await page.goto('/#/pages-sys/about/index')
  await expect(page.locator('.uni-page-head')).toHaveCSS('background-color', 'rgb(15, 22, 36)')
  expect(await page.evaluate('window.qwBars')).toEqual(['rgb(15, 22, 36)'])
})
