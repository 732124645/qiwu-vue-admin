import { spawnSync } from 'node:child_process'
import type { APIRequestContext } from '@playwright/test'
import { serverDir, serverEnv, USERS } from './env.ts'
import { bearer, expect, msg, submitLogin, test } from './fixtures.ts'

async function param(request: APIRequestContext, auth: string, key: string) {
  const res = await request.get('/api/settings/params', {
    headers: { Authorization: auth },
    params: { paramKey: key },
  })
  expect(res.ok(), await res.text()).toBe(true)
  const items = (
    (await res.json()) as {
      data: { items: { id: number; paramKey: string; paramValue: string }[] }
    }
  ).data.items
  const row = items.find((item) => item.paramKey === key)
  expect(row, `seed parameter ${key}`).toBeDefined()
  return row!
}

async function setParam(request: APIRequestContext, auth: string, id: number, value: string) {
  const res = await request.put(`/api/settings/params/${id}`, {
    headers: { Authorization: auth },
    data: { paramValue: value },
  })
  expect(res.ok(), await res.text()).toBe(true)
}

const ANSWER_SCRIPT = `
import { createClient } from 'redis'
import { redisKey } from './dist/core/redis/cache-namespaces.js'
const { REDIS_HOST, REDIS_PORT, REDIS_USERNAME, REDIS_PASSWORD, REDIS_DB, CAPTCHA_ID } = process.env
const redis = createClient({ socket: { host: REDIS_HOST, port: Number(REDIS_PORT) },
  username: REDIS_USERNAME, password: REDIS_PASSWORD, database: Number(REDIS_DB) })
await redis.connect()
// a string: Playwright's FORCE_COLOR would colour a logged number
try { process.stdout.write(String(JSON.parse(await redis.get(redisKey('captcha', CAPTCHA_ID))).answer.x)) }
finally { await redis.close() }
`

function sliderAnswer(id: string) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', ANSWER_SCRIPT], {
    cwd: serverDir,
    env: { ...process.env, ...serverEnv, CAPTCHA_ID: id },
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(`captcha answer read failed: ${result.stderr}`)
  return Number(result.stdout.trim())
}

test('captcha sign-up switch hides the entry until enabled', async ({ page, request }) => {
  const auth = await bearer(request)
  const setting = await param(request, auth, 'auth.signup.enabled')
  expect(setting.paramValue).toBe('false')
  try {
    const loaded = page.waitForResponse((res) =>
      res.url().includes('/api/settings/params/public/auth.signup.enabled'),
    )
    await page.goto('/login')
    await loaded
    await expect(page.getByRole('link', { name: msg('auth.entry.createAccount') })).toHaveCount(0)
    await setParam(request, auth, setting.id, 'true')
    await page.reload()
    const link = page.getByRole('link', { name: msg('auth.entry.createAccount') })
    await expect(link).toBeVisible()
    await link.click()
    await expect(page).toHaveURL(/\/register$/)
    await expect(page.getByRole('heading', { name: msg('auth.signup.title') })).toBeVisible()
  } finally {
    await setParam(request, auth, setting.id, setting.paramValue)
  }
})

for (const width of [1280, 375]) {
  test(`captcha slider permits password sign-in after a real drag at ${width}px`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 812 })
    const auth = await bearer(request)
    const setting = await param(request, auth, 'captcha.mode')
    expect(setting.paramValue).toBe('off')
    try {
      await setParam(request, auth, setting.id, 'slider')
      await page.goto('/login')
      const challenge = page.waitForResponse((res) =>
        res.url().includes('/api/auth/captcha?scene=signin'),
      )
      await submitLogin(page, USERS.limited)
      const res = await challenge
      const data = (
        (await res.json()) as { data: { id: string; kind: string; thumbWidth: number } }
      ).data
      expect(data.kind).toBe('slider')
      const answer = sliderAnswer(data.id)
      const dialog = page.getByRole('dialog', { name: msg('captcha.title') })
      if (width === 375) {
        const body = dialog.locator('.el-dialog__body')
        const slider = dialog.locator('.go-captcha')
        await expect(slider).toBeVisible()
        const bodyBox = await body.boundingBox()
        const sliderBox = await slider.boundingBox()
        const padding = await body.evaluate((e) => {
          const css = e.ownerDocument.defaultView.getComputedStyle(e)
          return { left: parseFloat(css.paddingLeft), right: parseFloat(css.paddingRight) }
        })
        expect(sliderBox!.x).toBeGreaterThanOrEqual(bodyBox!.x + padding.left)
        expect(sliderBox!.x + sliderBox!.width).toBeLessThanOrEqual(
          bodyBox!.x + bodyBox!.width - padding.right,
        )
      }
      const handle = dialog.locator('.gc-drag-block')
      await expect(handle).toBeVisible()
      const [button, bar, picture] = await Promise.all([
        handle.boundingBox(),
        dialog.locator('.gc-drag-slide-bar').boundingBox(),
        dialog.locator('.gc-picture').boundingBox(),
      ])
      expect(button && bar && picture).toBeTruthy()
      const startX = button!.x + button!.width / 2
      const y = button!.y + button!.height / 2
      const distance = (answer * (bar!.width - button!.width)) / (picture!.width - data.thumbWidth)
      await page.mouse.move(startX, y)
      await page.mouse.down()
      await page.mouse.move(startX + distance, y, { steps: 12 })
      await page.mouse.up()
      await expect(page).toHaveURL(/\/home$/, { timeout: 5000 })
    } finally {
      await setParam(request, auth, setting.id, setting.paramValue)
    }
  })
}

test('captcha image shows the arithmetic SVG on password sign-in', async ({ page, request }) => {
  const auth = await bearer(request)
  const mode = await param(request, auth, 'captcha.mode')
  const imageType = await param(request, auth, 'captcha.image_type')
  expect(mode.paramValue).toBe('off')
  try {
    if (imageType.paramValue !== 'math') await setParam(request, auth, imageType.id, 'math')
    await setParam(request, auth, mode.id, 'image')
    await page.goto('/login')
    await submitLogin(page, USERS.limited)
    const dialog = page.getByRole('dialog', { name: msg('captcha.title') })
    await expect(dialog.getByRole('img', { name: msg('captcha.image.alt') })).toHaveAttribute(
      'src',
      /^data:image\/svg\+xml;base64,/,
    )
    await expect(dialog.getByLabel(msg('captcha.image.answer'))).toBeVisible()
  } finally {
    await setParam(request, auth, mode.id, mode.paramValue)
    if (imageType.paramValue !== 'math')
      await setParam(request, auth, imageType.id, imageType.paramValue)
  }
})
