import { USERS } from './env.ts'
import { expect, msg, signIn, test, type Page } from './fixtures.ts'

const drawer = (page: Page) => page.getByRole('dialog', { name: msg('layout.settings.title') })
const layer = (page: Page) => page.locator('.app-layout > div[style*="background-image:"]')
const setting = (page: Page) =>
  drawer(page).getByRole('switch', { name: msg('layout.settings.watermark') })

async function openSettings(page: Page) {
  await page.getByRole('button', { name: msg('layout.settings.title') }).click()
  await expect(drawer(page)).toBeVisible()
}

async function closeSettings(page: Page) {
  await drawer(page).locator('.el-drawer__title').click()
  await page.keyboard.press('Escape')
  await expect(drawer(page)).toBeHidden()
}

async function toggleWatermark(page: Page) {
  await drawer(page).getByText(msg('layout.settings.watermark'), { exact: true }).click()
}

/** Inspect the actual repeated bitmap, including its transparent pixels when disabled. */
async function ink(page: Page) {
  return layer(page).evaluate(async (e) => {
    const doc = e.ownerDocument
    const image = new doc.defaultView.Image()
    image.src = doc.defaultView.getComputedStyle(e).backgroundImage.slice(5, -2)
    await image.decode()
    const canvas = doc.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(image, 0, 0)
    return ctx
      .getImageData(0, 0, image.width, image.height)
      .data.some((v: number, i: number) => i % 4 === 3 && v > 0)
  })
}

test('watermark: off by default, uses the signed-in username, persists and clears when disabled', async ({
  page,
}) => {
  // Observe the canvas text as well as the final bitmap: a nickname or stale username must fail.
  await page.addInitScript({
    content: `window.watermarkTexts = [];
      const fill = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function(text, ...args) {
        window.watermarkTexts.push(text);
        return fill.call(this, text, ...args);
      };`,
  })
  // An older saved object still receives watermark=false through mergeDefaults.
  await page.goto('/login')
  await page.evaluate(`localStorage.setItem('qw.app.settings', JSON.stringify({layout: 'side'}))`)
  await signIn(page, 'admin', '/home')
  await openSettings(page)
  await expect(setting(page)).not.toBeChecked()
  await expect.poll(() => ink(page)).toBe(false)
  await toggleWatermark(page)
  await expect(setting(page)).toBeChecked()
  await closeSettings(page)

  const username = async (name: string) => {
    await expect(layer(page)).toBeVisible()
    await expect.poll(() => ink(page)).toBe(true)
    await expect.poll(() => page.evaluate<string>('window.watermarkTexts.at(-1)')).toBe(name)
  }
  await username(USERS.admin.username)
  await page.reload()
  await username(USERS.admin.username)
  await openSettings(page)
  await expect(setting(page)).toBeChecked()
  await closeSettings(page)

  await signIn(page, 'limited', '/home')
  await username(USERS.limited.username)
  expect(await page.evaluate<string[]>('window.watermarkTexts')).not.toContain(USERS.admin.username)
  await openSettings(page)
  await toggleWatermark(page)
  await expect(setting(page)).not.toBeChecked()
  await closeSettings(page)
  await expect.poll(() => ink(page)).toBe(false)
  await page.reload()
  await expect.poll(() => ink(page)).toBe(false)
})

test('watermark: canvas colour follows runtime dark and light switches', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.addInitScript({
    content: `window.watermarkFills = [];
      const fill = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function(text, ...args) {
        window.watermarkFills.push({text, color: this.fillStyle});
        return fill.call(this, text, ...args);
      };`,
  })
  await signIn(page, 'admin', '/home')
  await openSettings(page)
  await toggleWatermark(page)
  await closeSettings(page)
  const currentColour = async () => {
    await expect.poll(() => ink(page)).toBe(true)
    await expect
      .poll(() =>
        page.evaluate<boolean>(`(() => {
          const ctx = document.createElement('canvas').getContext('2d');
          ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--qw-border').trim();
          const fill = window.watermarkFills.at(-1);
          return fill?.text === '${USERS.admin.username}' && fill.color === ctx.fillStyle;
        })()`),
      )
      .toBe(true)
  }
  await currentColour()
  for (const dark of [true, false, true, false]) {
    await page.evaluate('window.watermarkFills = []')
    await openSettings(page)
    await drawer(page).getByText(msg('layout.settings.dark'), { exact: true }).click()
    await closeSettings(page)
    const html = expect(page.locator('html'))
    await (dark ? html : html.not).toHaveClass(/\bdark\b/)
    await currentColour()
  }
})

test('watermark: layout switches and the narrow menu drawer keep working while enabled', async ({
  page,
}) => {
  await signIn(page, 'admin', '/home')
  await openSettings(page)
  await toggleWatermark(page)
  for (const mode of ['side', 'top', 'mix']) {
    await drawer(page)
      .getByRole('radio', { name: msg(`layout.settings.layouts.${mode}`) })
      .check({ force: true })
    await closeSettings(page)
    await expect.poll(() => ink(page)).toBe(true)
    await expect(page.getByRole('navigation', { name: msg('common.layout.sideMenu') })).toHaveCount(
      mode === 'side' ? 1 : 0,
    )
    await expect(page.getByRole('navigation', { name: msg('layout.topMenu') })).toHaveCount(
      mode === 'side' ? 0 : 1,
    )
    await openSettings(page)
  }
  await closeSettings(page)
  await page.setViewportSize({ width: 375, height: 812 })
  await page.getByRole('button', { name: msg('common.layout.expand') }).click()
  const menu = page.getByRole('navigation', { name: msg('common.layout.sideMenu') })
  await expect(menu).toBeVisible()
  await menu.getByText(msg('menu.system.title')).click()
  await menu.getByRole('menuitem', { name: msg('menu.settings.dict') }).click()
  await expect(page).toHaveURL(/\/settings\/dicts$/)
  await expect(menu).toBeHidden()
  await expect.poll(() => ink(page)).toBe(true)
})

test('watermark: toggling keeps the iframe document mounted', async ({ page }) => {
  await signIn(page, 'admin', '/devtools/api-docs')
  const frame = page.frameLocator('iframe[src="/api/docs"]')
  await expect(frame.getByRole('heading', { name: /Qiwu API/ })).toBeVisible()
  const document = page.frames().find((f) => new URL(f.url()).pathname === '/api/docs')!
  await document.evaluate('window.qwKept = true')
  for (const enabled of [true, false]) {
    await openSettings(page)
    await toggleWatermark(page)
    await closeSettings(page)
    await expect.poll(() => ink(page)).toBe(enabled)
    expect(await document.evaluate('window.qwKept')).toBe(true)
    await expect(frame.getByRole('heading', { name: /Qiwu API/ })).toBeVisible()
  }
})

/** Composite the computed browser colours, including icon / suffix opacity, over ancestor surfaces. */
async function readable(locator: import('@playwright/test').Locator, minimum = 4.5) {
  await expect(locator).toBeVisible()
  await expect
    .poll(() =>
      locator.evaluate((node) => {
        const doc = node.ownerDocument
        const css = (e: typeof node) => doc.defaultView.getComputedStyle(e)
        const ctx = doc.createElement('canvas').getContext('2d')
        const rgba = (value: string): number[] => {
          ctx.clearRect(0, 0, 1, 1)
          ctx.fillStyle = value
          ctx.fillRect(0, 0, 1, 1)
          const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
          return [r, g, b, a / 255]
        }
        const over = (fg: number[], bg: number[]) =>
          fg.slice(0, 3).map((c, i) => c * fg[3] + bg[i] * (1 - fg[3]))
        const ancestors = []
        let opacity = 1
        for (let e = node; e; e = e.parentElement) {
          ancestors.unshift(e)
          opacity *= Number(css(e).opacity)
        }
        let bg = [255, 255, 255]
        for (const e of ancestors) bg = over(rgba(css(e).backgroundColor), bg)
        const fg = rgba(css(node).color)
        fg[3] *= opacity
        const lum = (rgb: number[]) =>
          rgb.reduce((sum, c, i) => {
            const s = c / 255
            return (
              sum +
              [0.2126, 0.7152, 0.0722][i] *
                (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4)
            )
          }, 0)
        const [a, b] = [lum(over(fg, bg)), lum(bg)].sort((x, y) => y - x)
        return (a + 0.05) / (b + 0.05)
      }),
    )
    .toBeGreaterThanOrEqual(minimum)
}

for (const dark of [false, true]) {
  test(`sidebar: ${dark ? 'dark' : 'light'} global theme keeps both appearances readable and persistent`, async ({
    page,
  }, info) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/login')
    // Older saved objects acquire sideTheme=dark without changing their layout.
    await page.evaluate(`localStorage.setItem('qw.app.settings', JSON.stringify({layout: 'side'}))`)
    await signIn(page, 'admin', '/iam/positions')
    await openSettings(page)
    const appearances = drawer(page).getByRole('radiogroup', {
      name: msg('layout.settings.sideTheme'),
    })
    await expect(
      appearances.getByRole('radio', { name: msg('layout.settings.sideThemes.dark'), exact: true }),
    ).toBeChecked()
    if (dark) await drawer(page).getByText(msg('layout.settings.dark'), { exact: true }).click()
    await closeSettings(page)
    const aside = page.locator('.app-layout__aside')
    const menu = aside.getByRole('navigation')
    const group = menu.locator('.el-sub-menu.is-active > .el-sub-menu__title').first()
    const active = menu.locator('.el-menu-item.is-active')
    const plain = menu.getByRole('menuitem', { name: msg('menu.home'), exact: true })
    for (const appearance of ['dark', 'light']) {
      await openSettings(page)
      await appearances
        .getByRole('radio', { name: msg(`layout.settings.sideThemes.${appearance}`), exact: true })
        .check({ force: true })
      await closeSettings(page)
      if (appearance === 'light') {
        await expect(aside).toHaveClass(/qw-side-light/)
        const surface = await page
          .locator('.app-layout__header')
          .evaluate((e) => e.ownerDocument.defaultView.getComputedStyle(e).backgroundColor)
        await expect(aside).toHaveCSS('background-color', surface)
        await expect(aside).toHaveCSS('box-shadow', /inset/)
      } else await expect(aside).not.toHaveClass(/qw-side-light/)
      await readable(plain)
      await readable(plain.locator('.el-icon').first(), 3)
      await readable(group)
      await readable(group.locator('.el-sub-menu__icon-arrow'), 3)
      await readable(active)
      await readable(aside.locator('.app-logo__text'))
      await readable(aside.locator('.app-logo__suffix'))
      await plain.hover()
      if (appearance === 'light') {
        const hover = await aside.evaluate((e) => {
          const doc = e.ownerDocument
          const probe = doc.createElement('div')
          probe.style.backgroundColor = 'var(--qw-brand-weak)'
          e.append(probe)
          const color = doc.defaultView.getComputedStyle(probe).backgroundColor
          probe.remove()
          return color
        })
        await expect(plain).toHaveCSS('background-color', hover)
        await expect(group).toHaveCSS('background-color', hover)
      }
      await readable(plain)
      await group.hover()
      await readable(group)
      await aside.screenshot({ path: info.outputPath(`sidebar-${appearance}.png`) })
    }
    // A preset updates the solid selected fill while the light surface and logo stay readable.
    await openSettings(page)
    await drawer(page)
      .getByRole('button', { name: msg('layout.settings.primary') })
      .click()
    await page.getByRole('button', { name: /#0f766e/i }).click()
    await page.getByRole('button', { name: /OK|确定/ }).click()
    await closeSettings(page)
    await readable(active)
    await readable(group)
    await page.reload()
    await expect(aside).toHaveClass(/qw-side-light/)
    if (dark) await expect(page.locator('html')).toHaveClass(/\bdark\b/)
    else await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
    await openSettings(page)
    await expect(
      appearances.getByRole('radio', {
        name: msg('layout.settings.sideThemes.light'),
        exact: true,
      }),
    ).toBeChecked()
    await closeSettings(page)
    await readable(active)
  })
}

test('sidebar: light appearance scopes to side / mix aside and the narrow drawer, keeping top navigation navy', async ({
  page,
}) => {
  await signIn(page, 'admin', '/iam/positions')
  await openSettings(page)
  await drawer(page)
    .getByRole('radiogroup', { name: msg('layout.settings.sideTheme') })
    .getByRole('radio', { name: msg('layout.settings.sideThemes.light'), exact: true })
    .check({ force: true })
  for (const mode of ['side', 'top', 'mix']) {
    await drawer(page)
      .getByRole('radio', { name: msg(`layout.settings.layouts.${mode}`) })
      .check({ force: true })
    await closeSettings(page)
    if (mode !== 'top')
      await expect(page.locator('.app-layout__aside')).toHaveClass(/qw-side-light/)
    if (mode !== 'side') {
      const navy = await page.locator('.app-layout__header--nav').evaluate((e) => {
        const css = (node: typeof e) => e.ownerDocument.defaultView.getComputedStyle(node)
        const probe = e.ownerDocument.createElement('div')
        probe.style.background = css(e.ownerDocument.documentElement).getPropertyValue(
          '--qw-side-bg',
        )
        e.append(probe)
        const color = css(probe).backgroundColor
        probe.remove()
        return color
      })
      await expect(page.locator('.app-layout__header--nav')).toHaveCSS('background-color', navy)
      await readable(page.locator('.header-bar__logo .app-logo__text'))
    }
    await openSettings(page)
  }
  await closeSettings(page)
  await page.setViewportSize({ width: 375, height: 812 })
  await page.getByRole('button', { name: msg('common.layout.expand') }).click()
  const narrow = page.locator('.app-layout__drawer')
  await expect(narrow).toHaveClass(/qw-side-light/)
  await expect(narrow).not.toHaveCSS('box-shadow', /inset/)
  await readable(narrow.locator('.app-logo__text'))
  await readable(narrow.getByRole('menuitem', { name: msg('menu.home'), exact: true }))
  await page.keyboard.press('Escape')
  await expect(narrow).toBeHidden()
})

test('dialogs: a narrow viewport keeps the OAuth fields and save button inside its margins', async ({
  page,
}, info) => {
  await signIn(page, 'admin', '/oauth/clients')
  await page.setViewportSize({ width: 375, height: 812 })
  await page.getByRole('button', { name: msg('crud.action.create'), exact: true }).click()
  const dialog = page.getByRole('dialog', {
    name: msg('crud.title.create', 'zh-CN', { name: msg('oauth.client.entity') }),
  })
  await expect(dialog).toBeVisible()
  await expect
    .poll(async () => {
      const box = await dialog.locator('.el-dialog').boundingBox()
      return box && box.x >= 16 && box.x + box.width <= 359
    })
    .toBe(true)
  const field = (prop: string) => msg(`field.oauth.client.${prop}`)
  const id = dialog.getByRole('textbox', { name: field('clientId') })
  const name = dialog.getByRole('textbox', { name: field('name') })
  await id.fill('narrow-client')
  await name.fill('Narrow client')
  const idBox = await id.boundingBox()
  const nameBox = await name.boundingBox()
  expect(nameBox!.x).toBe(idBox!.x)
  expect(nameBox!.y).toBeGreaterThanOrEqual(idBox!.y + idBox!.height)
  for (const input of [id, name, ...(await dialog.locator('.el-input-number').all())]) {
    const box = await input.boundingBox()
    expect(box!.width).toBeGreaterThanOrEqual(120)
    expect(box!.x + box!.width).toBeLessThanOrEqual(335)
  }
  const dialogBox = await dialog.locator('.el-dialog').boundingBox()
  for (const checkbox of await dialog.locator('.el-checkbox').all()) {
    const box = await checkbox.boundingBox()
    expect(box!.x + box!.width).toBeLessThanOrEqual(dialogBox!.x + dialogBox!.width)
  }
  const save = dialog.getByRole('button', { name: msg('crud.action.save'), exact: true })
  await save.scrollIntoViewIfNeeded()
  await expect(save).toBeInViewport({ ratio: 1 })
  const box = await save.boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(16)
  expect(box!.x + box!.width).toBeLessThanOrEqual(359)
  await dialog
    .locator('.el-dialog')
    .screenshot({ path: info.outputPath('oauth-client-narrow.png') })
})
