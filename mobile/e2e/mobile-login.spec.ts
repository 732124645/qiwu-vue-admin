// Sign-in page on the H5 build: password (captcha off / slider / image), SMS, remember username, language;
// The frame: title tabs, our own show-password eye, the compact header on a short window.
// The captcha tests switch `captcha.mode` and come last: one that times out cannot restore it.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { USERS, serverScript } from './env'

const HOME = /#\/pages\/home\/index$/
const NOBODY = { username: 'm_nobody', password: 'Wrong-Pass1' }

const field = (page: Page, name: string) => page.locator(`.qw-login__${name} input`)
const remember = (page: Page) => page.locator('.wd-checkbox')
const loginTab = (page: Page, text: string) => page.locator('.qw-login__tab', { hasText: text })
const sendCode = (page: Page, text: string | RegExp) =>
  page.locator('.qw-sms__send', { hasText: text })
const button = (page: Page, text: string | RegExp) => page.locator('uni-button', { hasText: text })
const signInResponse = (page: Page) =>
  page.waitForResponse((r) => r.url().endsWith('/api/auth/login'))

async function signIn(page: Page, user: { username: string; password: string }) {
  await field(page, 'username').fill(user.username)
  await field(page, 'password').fill(user.password)
  await button(page, /^(登录|Sign in)$/).click()
}

/** Popups slide in: boxes are measured once the finite animations end (loading spinners never do). */
const settled = (page: Page) =>
  page.evaluate(
    'Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished))',
  )

/** The stored answer of a captcha challenge (Redis), as the server compares it. */
function captchaAnswer(id: string): unknown {
  const out = serverScript(
    `
import { createClient } from 'redis'
import { redisKey } from './dist/core/redis/cache-namespaces.js'
const { REDIS_HOST, REDIS_PORT, REDIS_USERNAME, REDIS_PASSWORD, REDIS_DB, CAPTCHA_ID } = process.env
const redis = createClient({ socket: { host: REDIS_HOST, port: Number(REDIS_PORT) },
  username: REDIS_USERNAME, password: REDIS_PASSWORD, database: Number(REDIS_DB) })
await redis.connect()
try { process.stdout.write(JSON.stringify(JSON.parse(await redis.get(redisKey('captcha', CAPTCHA_ID))).answer)) }
finally { await redis.close() }
`,
    { CAPTCHA_ID: id },
  )
  return JSON.parse(out)
}

/** The newest sign-in code sent to `mobile` ('' until the async delivery wrote it). */
const smsCode = (mobile: string) =>
  serverScript(
    `
import { DataSource } from 'typeorm'
import { dataSourceOptions } from './dist/db/data-source.js'
const ds = await new DataSource(dataSourceOptions()).initialize()
try {
  const [row] = await ds.query("SELECT code FROM msg_sms_otp WHERE mobile = ? AND scene = 'signin' ORDER BY id DESC LIMIT 1", [process.env.MOBILE])
  process.stdout.write(row?.code ?? '')
} finally { await ds.destroy() }
`,
    { MOBILE: mobile },
  )

/** Runs `body` with the runtime parameter `key` set to `value` (through the admin API: it drops the cache). */
async function withParam(
  request: APIRequestContext,
  key: string,
  value: string,
  body: () => Promise<void>,
) {
  const login = await request.post('/api/auth/login', { data: USERS.admin })
  expect(login.ok(), await login.text()).toBe(true)
  const headers = { Authorization: `Bearer ${(await login.json()).data.accessToken}` }
  const list = await request.get('/api/settings/params', { headers, params: { paramKey: key } })
  const items = (await list.json()).data.items as {
    id: number
    paramKey: string
    paramValue: string
  }[]
  const row = items.find((item) => item.paramKey === key)!
  const set = async (paramValue: string) =>
    expect(
      (await request.put(`/api/settings/params/${row.id}`, { headers, data: { paramValue } })).ok(),
    ).toBe(true)
  await set(value)
  try {
    await body()
  } finally {
    await set(row.paramValue)
  }
}

test('password sign-in starts a mobile session, the next start resumes it; remember username', async ({
  page,
}) => {
  await page.goto('/')
  await expect(field(page, 'username')).toHaveValue('')
  await remember(page).click()
  const [res] = await Promise.all([signInResponse(page), signIn(page, USERS.admin)])
  expect(res.request().postDataJSON()).toMatchObject({ clientId: 'mobile', keepSignedIn: true })
  expect((await res.json()).data.refreshToken).toBeTruthy()
  await expect(page).toHaveURL(HOME)

  // the stored refresh token skips the sign-in page; the workbench's /auth/me answers after the refresh
  // rotated it (stored before the replay), so removing it below cannot race that write
  const me = page.waitForResponse((r) => r.url().endsWith('/api/auth/me') && r.ok())
  await page.goto('/')
  await expect(page).toHaveURL(HOME)
  await me

  // signed out: the remembered username is filled in; unchecking forgets it
  await page.evaluate(() => localStorage.removeItem('qw.auth.rt'))
  await page.goto('/')
  await expect(field(page, 'username')).toHaveValue(USERS.admin.username)
  await expect(remember(page)).toHaveClass(/is-checked/)
  await remember(page).click()
  await signIn(page, USERS.admin)
  await expect(page).toHaveURL(HOME)
  expect(await page.evaluate(() => localStorage.getItem('qw.login.username'))).toBeNull()
})

test('empty fields show the shared messages; a wrong password the server message', async ({
  page,
}) => {
  await page.goto('/')
  await button(page, '登录').click()
  await expect(page.getByText('用户名不能为空')).toBeVisible()
  await expect(page.getByText('密码不能为空')).toBeVisible()
  await signIn(page, NOBODY)
  await expect(page.locator('.qw-login__error')).toHaveText('用户名或密码错误')
  await expect(page).not.toHaveURL(HOME)

  // the eye shows the password and masks it again
  const eye = page.locator('.qw-login__eye')
  await expect(field(page, 'password')).toHaveAttribute('type', 'password')
  await eye.click()
  await expect(field(page, 'password')).toHaveAttribute('type', 'text')
  await expect(field(page, 'password')).toHaveValue(NOBODY.password)
  await eye.click()
  await expect(field(page, 'password')).toHaveAttribute('type', 'password')
})

test('the full header on a tall window, the compact one on a short window', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.qw-login__slogan')).toBeVisible()
  await expect(page.locator('.qw-login')).not.toHaveClass(/is-compact/)
  await page.setViewportSize({ width: 402, height: 640 })
  await expect(page.locator('.qw-login')).toHaveClass(/is-compact/)
  await expect(page.locator('.qw-login__slogan')).toBeHidden()
  // the form and the footer still fit
  await expect(page.locator('.qw-login__submit')).toBeInViewport()
  await expect(page.locator('.qw-login__lang')).toBeInViewport()
})

test('the WeChat bind page: the compact frame with its title, back to the sign-in page', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.locator('.qw-login__slogan')).toBeVisible()
  // reached from the sign-in page in the mini program only: push it on top the same way
  await page.evaluate("location.hash = '#/pages-sys/wx-bind/index'")
  const bind = page.locator('.qw-login.is-fixed')
  await expect(bind.locator('.qw-login__wordmark')).toHaveText('绑定微信')
  await bind.getByRole('button', { name: '返回' }).click()
  await expect(bind).toHaveCount(0)
  await expect(page.locator('.qw-login__slogan')).toBeVisible()
})

test('SMS sign-in: a code sent to the number signs in a mobile session', async ({ page }) => {
  await page.goto('/')
  await loginTab(page, '短信登录').click()
  await expect(loginTab(page, '短信登录')).toHaveAttribute('aria-selected', 'true')
  await page.locator('.qw-sms__mobile input').fill(USERS.sms.mobile)
  await sendCode(page, '获取验证码').click()
  await expect(page.getByText('若该手机号已关联账号，验证码将稍后送达。')).toBeVisible()
  await expect(sendCode(page, /\d+ 秒后重发/)).toHaveAttribute('aria-disabled', 'true')
  let code = ''
  await expect.poll(() => (code = smsCode(USERS.sms.mobile))).toMatch(/^\d{6}$/)
  await page.locator('.qw-sms__code input').fill(code)
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/auth/sms/login')),
    button(page, /^登录$/).click(),
  ])
  expect(res.request().postDataJSON()).toMatchObject({
    mobile: USERS.sms.mobile,
    clientId: 'mobile',
  })
  await expect(page).toHaveURL(HOME)
})

test('language switch: the texts, the API language, and the choice survives a restart', async ({
  page,
}) => {
  await page.goto('/')
  await page.locator('.qw-login__lang').click()
  await page.locator('.wd-action-sheet__action', { hasText: 'English' }).click()
  await expect(page.locator('.qw-login__title')).toHaveText('Sign in')
  await expect(page.locator('.qw-login__lang')).toContainText('English')
  const [res] = await Promise.all([signInResponse(page), signIn(page, NOBODY)])
  expect(res.request().headers()['accept-language']).toBe('en-US')
  const { msg } = await res.json()
  expect(msg).toMatch(/^[\x20-\x7e]+$/)
  await expect(page.locator('.qw-login__error')).toHaveText(msg)

  await page.reload()
  await expect(page.locator('.qw-login__title')).toHaveText('Sign in')
})

test('slider captcha: the server slider in go-captcha-uni, dragged into place', async ({
  page,
  request,
}) => {
  await withParam(request, 'captcha.mode', 'slider', async () => {
    await page.goto('/')
    const challenge = page.waitForResponse((r) => r.url().includes('/api/auth/captcha?'))
    await signIn(page, USERS.sms)
    const data = (await (await challenge).json()).data
    expect(data.kind).toBe('slider')
    const { x } = captchaAnswer(data.id) as { x: number }
    const block = page.locator('.gc-drag-block')
    await expect(block).toBeVisible()
    await settled(page)
    const [handle, bar, picture] = await Promise.all(
      [block, page.locator('.gc-drag-slide-bar'), page.locator('.gc-body')].map((l) =>
        l.boundingBox(),
      ),
    )
    // the piece moves (picture - piece) while the handle moves (bar - handle)
    const distance =
      ((x - data.thumbX) * (bar!.width - handle!.width)) /
      (picture!.width - data.thumbWidth - data.thumbX)
    const startX = handle!.x + handle!.width / 2
    const y = handle!.y + handle!.height / 2
    // a real touch drag (the H5 build on a phone listens to touch events)
    const cdp = await page.context().newCDPSession(page)
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', px: number) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: type === 'touchEnd' ? [] : [{ x: px, y }],
      })
    await touch('touchStart', startX)
    for (let step = 1; step <= 12; step++) await touch('touchMove', startX + (distance * step) / 12)
    await touch('touchEnd', startX + distance)
    await expect(page).toHaveURL(HOME)
  })
})

test('image captcha: a PNG; a wrong answer loads a new one', async ({ page, request }) => {
  await withParam(request, 'captcha.mode', 'image', async () => {
    await page.goto('/')
    let challenge = page.waitForResponse((r) => r.url().includes('/api/auth/captcha?'))
    await signIn(page, USERS.sms)
    let res = await challenge
    expect(new URL(res.url()).searchParams.get('format')).toBe('png')
    let data = (await res.json()).data
    expect(data.image).toMatch(/^data:image\/png;base64,/)
    await expect(page.locator('.qw-captcha__image img')).toHaveAttribute('src', data.image)

    const answer = page.locator('.qw-captcha__answer input')
    challenge = page.waitForResponse((r) => r.url().includes('/api/auth/captcha?'))
    await answer.fill('wrong')
    await button(page, '确认').click()
    res = await challenge
    await expect(page.locator('.qw-captcha__error')).toBeVisible()
    data = (await res.json()).data
    await answer.fill(String(captchaAnswer(data.id)))
    await button(page, '确认').click()
    await expect(page).toHaveURL(HOME)
  })
})
