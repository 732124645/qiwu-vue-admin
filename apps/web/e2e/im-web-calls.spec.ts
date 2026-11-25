import { expect, test, msg } from './fixtures.ts'
import { serverDir, serverEnv } from './env.ts'
import { cleanupIm, desktopScript, imSignIn, seedImUsers, type ImFixture } from './im-fixtures.ts'
import type { ImCall } from '@qiwu/shared'

const run = desktopScript(serverDir, serverEnv)
let fixture: ImFixture
test.beforeAll(() => {
  fixture = seedImUsers(run, `calls${Date.now() % 100000}`, ['ann', 'ben'])
})
test.afterAll(() => cleanupIm(run, fixture))

test('a foreground invitation can be declined without opening media or claiming a connection', async ({
  page,
}) => {
  const call: ImCall = {
    id: 81,
    roomId: 82,
    mode: 'audio',
    state: 'ringing',
    callerId: fixture.users[1]!.id,
    rev: 1,
    createdAt: new Date().toISOString(),
    startedAt: null,
    endedAt: null,
    inviteExpiresAt: new Date(Date.now() + 45000).toISOString(),
    endReason: null,
    members: fixture.users.map((u, i) => ({
      userId: u.id,
      displayName: u.username,
      identity: `u${u.id}`,
      state: i ? 'accepted' : 'invited',
    })),
    canAccept: true,
    canDecline: true,
    canJoin: false,
    canLeave: false,
    canEnd: false,
  }
  let declined = false,
    grants = 0
  await page.route('**/api/im/options', async (route) => {
    const response = await route.fetch(),
      body = await response.json()
    body.data.callEnabled = body.data.callConfigured = true
    await route.fulfill({ response, json: body })
  })
  await page.route('**/api/im/calls/active', (route) =>
    route.fulfill({ json: { code: 0, msg: 'ok', data: declined ? [] : [call] } }),
  )
  await page.route('**/api/im/calls/81/decline', (route) => {
    declined = true
    return route.fulfill({
      json: {
        code: 0,
        msg: 'ok',
        data: {
          ...call,
          rev: 2,
          state: 'ended',
          canAccept: false,
          canDecline: false,
          endReason: 'declined',
        },
      },
    })
  })
  page.on('request', (request) => {
    if (/\/im\/calls\/\d+\/join$/.test(request.url())) grants++
  })
  await imSignIn(page, fixture.users[0]!, '/')
  const dialog = page.getByRole('dialog', { name: msg('im.calls.title') })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(msg('im.calls.media.connected'))).toHaveCount(0)
  await dialog.getByRole('button', { name: msg('im.calls.decline'), exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect(declined).toBe(true)
  expect(grants).toBe(0)
})

test('an unconfigured media service is explicit and never enables capture', async ({ page }) => {
  await page.route('**/api/im/options', async (route) => {
    const response = await route.fetch(),
      body = await response.json()
    body.data.callEnabled = true
    body.data.callConfigured = false
    await route.fulfill({ response, json: body })
  })
  await imSignIn(page, fixture.users[0]!)
  await page.getByRole('tab', { name: msg('im.tabs.directory') }).click()
  await page
    .getByRole('button', {
      name: msg('im.directory.chatWith', 'zh-CN', { name: fixture.users[1]!.username }),
    })
    .click()
  await expect(page.getByText(msg('im.calls.unconfigured'), { exact: true }).first()).toBeVisible()
  await expect(
    page.getByRole('button', { name: msg('im.calls.audio'), exact: true }),
  ).toBeDisabled()
  await expect(
    page.getByRole('button', { name: msg('im.calls.video'), exact: true }),
  ).toBeDisabled()
})

test('only the primary chat tab can start media and a second tab makes no call writes', async ({
  page,
  context,
}) => {
  await context.route('**/api/im/options', async (route) => {
    const response = await route.fetch(),
      body = await response.json()
    body.data.callEnabled = body.data.callConfigured = true
    await route.fulfill({ response, json: body })
  })
  await context.route('**/api/im/calls/active', (route) =>
    route.fulfill({ json: { code: 0, msg: 'ok', data: [] } }),
  )
  await imSignIn(page, fixture.users[0]!)
  await page.getByRole('tab', { name: msg('im.tabs.directory') }).click()
  await page
    .getByRole('button', {
      name: msg('im.directory.chatWith', 'zh-CN', { name: fixture.users[1]!.username }),
    })
    .click()
  await expect(page.getByRole('button', { name: msg('im.calls.audio'), exact: true })).toBeEnabled()
  const second = await context.newPage()
  let writes = 0
  second.on('request', (request) => {
    if (request.method() === 'POST' && /\/im\/(?:rooms\/\d+\/calls|calls\/)/.test(request.url()))
      writes++
  })
  try {
    await imSignIn(second, fixture.users[0]!)
    await second.getByRole('tab', { name: msg('im.tabs.directory') }).click()
    await second
      .getByRole('button', {
        name: msg('im.directory.chatWith', 'zh-CN', { name: fixture.users[1]!.username }),
      })
      .click()
    await expect(second.getByText(msg('im.calls.otherTab'), { exact: true })).toBeVisible()
    await expect(
      second.getByRole('button', { name: msg('im.calls.audio'), exact: true }),
    ).toBeDisabled()
    await expect(
      second.getByRole('button', { name: msg('im.calls.video'), exact: true }),
    ).toBeDisabled()
    expect(writes).toBe(0)
  } finally {
    await second.close()
  }
})
