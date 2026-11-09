// Acceptance of group chats in the browser: the owner creates a group from the directory, names a
// moderator and renames it; the settings drawer shows each member only the buttons of their role
// (owner: all; moderator: rename, add, remove members; member: leave) while the server still refuses a
// member who calls the API directly; ownership moves, the old owner leaves, the new owner closes the
// group and nobody can send any more. Screenshots in both languages and both appearances.
import type { BrowserContext, Page } from '@playwright/test'
import { serverDir, serverEnv } from './env.ts'
import { expect, msg, test } from './fixtures.ts'
import {
  cleanupIm,
  desktopScript,
  imBearer,
  imSignIn,
  messages,
  newChatPage,
  roomItem,
  seedImUsers,
  sendText,
  localRooms,
  tm,
  type ImFixture,
  type ImUser,
} from './im-fixtures.ts'

const run = desktopScript(serverDir, serverEnv)
let fixture: ImFixture
const contexts: BrowserContext[] = []
test.describe.configure({ mode: 'serial', timeout: 120_000 })
test.use({ actionTimeout: 10_000 })

const user = (i: number) => fixture.users[i]!
const drawer = (page: Page) => page.getByRole('dialog', { name: msg('im.group.title') })
const member = (page: Page, u: ImUser) =>
  drawer(page).getByRole('listitem').filter({ hasText: u.username })

/** A signed-in page of `u` on its own browser context, the group `label` open. */
async function openAs(browser: import('@playwright/test').Browser, u: ImUser, label?: string) {
  const ctx = await browser.newContext()
  contexts.push(ctx)
  const { page, problems } = await newChatPage(ctx)
  await imSignIn(page, u)
  if (label) await roomItem(page, label).click()
  return { page, problems }
}

/** Picks `names` in the multiple select labelled `label`. */
async function pick(page: Page, label: string, names: string[]) {
  const select = page.getByRole('combobox', { name: label })
  for (const name of names) {
    await select.click({ force: true })
    await select.fill(name)
    await page.getByRole('option', { name, exact: true }).click()
  }
  // the first Escape clears the kept filter text, the second closes the list
  await select.press('Escape')
  await select.press('Escape')
  await expect(page.getByRole('listbox', { name: label })).toBeHidden()
}

async function settings(page: Page) {
  await page.getByRole('button', { name: msg('im.group.title') }).click()
  await expect(drawer(page)).toBeVisible()
}

/** Confirms the message box. */
const confirm = (page: Page) =>
  page
    .getByRole('dialog')
    .getByRole('button', { name: msg('im.action.confirm') })
    .click()

test.beforeAll(() => {
  fixture = seedImUsers(run, `e2eimg${Date.now() % 100000}`, ['own', 'mod', 'par', 'ext'])
})
test.afterAll(async () => {
  for (const c of contexts) await c.close()
  cleanupIm(run, fixture)
})

test('group roles: buttons follow the role, the server stays the judge', async ({
  browser,
  request,
}) => {
  const [own, mod, par, ext] = [user(0), user(1), user(2), user(3)]
  const o = await openAs(browser, own)

  // the owner creates the group from the directory
  await o.page.getByRole('tab', { name: msg('im.tabs.directory') }).click()
  await o.page.getByRole('button', { name: msg('im.directory.createGroup') }).click()
  const dialog = o.page.getByRole('dialog', { name: msg('im.directory.createGroup') })
  await dialog.getByRole('textbox').first().fill('Team')
  await pick(o.page, msg('im.group.pickMembers'), [mod.username, par.username])
  await dialog.getByRole('button', { name: msg('im.group.create') }).click()
  await expect(o.page.getByRole('heading', { level: 2, name: 'Team' })).toBeVisible()
  await expect(messages(o.page)).toContainText(
    tm('im.event.room.create', { actor: own.username, label: 'Team' }),
  )

  // a moderator and a new name
  await settings(o.page)
  await member(o.page, mod)
    .getByRole('button', { name: msg('im.group.setModerator') })
    .click()
  await expect(member(o.page, mod)).toContainText(msg('im.group.role.moderator'))
  await drawer(o.page)
    .getByRole('textbox', { name: msg('im.group.name') })
    .fill('Team 2')
  await drawer(o.page)
    .getByRole('button', { name: msg('im.group.rename') })
    .click()
  await expect(o.page.getByRole('heading', { level: 2, name: 'Team 2' })).toBeVisible()
  await expect(drawer(o.page).getByRole('button', { name: msg('im.group.close') })).toBeVisible()
  await o.page.keyboard.press('Escape')

  // the moderator: rename and add, remove members only; no ownership, roles or closing
  const m = await openAs(browser, mod, 'Team 2')
  await settings(m.page)
  await expect(drawer(m.page).getByRole('textbox', { name: msg('im.group.name') })).toBeVisible()
  await expect(
    member(m.page, par).getByRole('button', { name: msg('im.group.remove') }),
  ).toBeVisible()
  await expect(member(m.page, own).getByRole('button')).toHaveCount(0)
  await expect(drawer(m.page).getByRole('button', { name: msg('im.group.transfer') })).toHaveCount(
    0,
  )
  await expect(
    drawer(m.page).getByRole('button', { name: msg('im.group.setModerator') }),
  ).toHaveCount(0)
  await expect(drawer(m.page).getByRole('button', { name: msg('im.group.close') })).toHaveCount(0)
  await pick(m.page, msg('im.group.pickMembers'), [ext.username])
  await drawer(m.page)
    .getByRole('button', { name: msg('im.group.add'), exact: true })
    .click()
  await expect(member(m.page, ext)).toBeVisible()
  await m.page.keyboard.press('Escape')

  // the member: leave only; a direct API call is refused all the same
  const p = await openAs(browser, par, 'Team 2')
  await expect(messages(p.page)).toContainText(
    tm('im.event.member.add', { actor: mod.username, users: ext.username }),
  )
  await settings(p.page)
  await expect(drawer(p.page).getByRole('textbox', { name: msg('im.group.name') })).toHaveCount(0)
  await expect(drawer(p.page).getByRole('button', { name: msg('im.group.remove') })).toHaveCount(0)
  await expect(
    drawer(p.page).getByRole('button', { name: msg('im.group.add'), exact: true }),
  ).toHaveCount(0)
  await expect(drawer(p.page).getByRole('button', { name: msg('im.group.leave') })).toBeVisible()
  await p.page.keyboard.press('Escape')
  const roomId = (await localRooms(p.page)).find((r) => r.detail?.label === 'Team 2')!.roomId
  const parHeaders = await imBearer(request, par)
  const rename = await request.put(`/api/im/rooms/${roomId}/label`, {
    headers: parHeaders,
    data: { label: 'Mine now' },
  })
  expect(rename.status()).toBe(403)
  expect(((await rename.json()) as { code: string }).code).toBe('B5004')
  const kick = await request.delete(`/api/im/rooms/${roomId}/members/${own.id}`, {
    headers: parHeaders,
  })
  expect(kick.status()).toBe(403)

  // screenshots: English and dark, then Chinese and light
  await p.page.evaluate(`localStorage.setItem('qw.locale', 'en-US')`)
  await p.page.reload()
  await p.page.getByRole('button', { name: /^Team 2/ }).click()
  await p.page.evaluate(`document.documentElement.classList.add('dark')`)
  await expect(p.page.getByRole('heading', { level: 2, name: 'Team 2' })).toBeVisible()
  await expect(p.page.getByRole('tab', { name: msg('im.tabs.chats', 'en-US') })).toBeVisible()
  await p.page.screenshot({ path: test.info().outputPath('im-group-en-dark.png') })
  await p.page.evaluate(`document.documentElement.classList.remove('dark')`)
  await p.page.evaluate(`localStorage.setItem('qw.locale', 'zh-CN')`)
  await p.page.reload()
  await roomItem(p.page, 'Team 2').click()
  await p.page.screenshot({ path: test.info().outputPath('im-group-zh-light.png') })

  // ownership moves to the moderator; the old owner leaves; the new owner closes the group
  await settings(o.page)
  await member(o.page, mod)
    .getByRole('button', { name: msg('im.group.transfer') })
    .click()
  await confirm(o.page)
  await expect(drawer(o.page).getByRole('button', { name: msg('im.group.close') })).toHaveCount(0)
  await drawer(o.page)
    .getByRole('button', { name: msg('im.group.leave') })
    .click()
  await confirm(o.page)
  await expect(roomItem(o.page, 'Team 2')).toHaveCount(0)

  await settings(m.page)
  await expect(drawer(m.page).getByRole('button', { name: msg('im.group.close') })).toBeVisible()
  await drawer(m.page)
    .getByRole('button', { name: msg('im.group.close') })
    .click()
  await confirm(m.page)
  await m.page.keyboard.press('Escape')
  await expect(p.page.getByText(msg('im.composer.closed'))).toBeVisible()
  await expect(p.page.getByRole('textbox', { name: msg('im.composer.label') })).toHaveCount(0)
  const late = await request.post(`/api/im/rooms/${roomId}/entries`, {
    headers: parHeaders,
    data: { clientEntryId: `late-${Date.now()}`, kind: 'text', text: 'too late' },
  })
  expect(late.status()).toBe(409)
  // the history stays readable
  await expect(messages(p.page)).toContainText(tm('im.event.room.close', { actor: mod.username }))
  expect([...o.problems, ...m.problems, ...p.problems]).toEqual([])
})

test('a group member chats and sees the others in the room', async ({ browser }) => {
  const [own, mod] = [user(0), user(1)]
  const o = await openAs(browser, own)
  await o.page.getByRole('tab', { name: msg('im.tabs.directory') }).click()
  await o.page.getByRole('button', { name: msg('im.directory.createGroup') }).click()
  const dialog = o.page.getByRole('dialog', { name: msg('im.directory.createGroup') })
  await dialog.getByRole('textbox').first().fill('Lunch')
  await pick(o.page, msg('im.group.pickMembers'), [mod.username])
  await dialog.getByRole('button', { name: msg('im.group.create') }).click()
  await sendText(o.page, 'noodles?')
  const m = await openAs(browser, mod, 'Lunch')
  await expect(messages(m.page).getByText('noodles?', { exact: true })).toBeVisible()
  await expect(m.page.getByText(tm('im.group.memberCount', { count: 2 }))).toBeVisible()
})
