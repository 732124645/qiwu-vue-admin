import { USERS } from './env.ts'
import { expect, msg, signIn, test, type Page } from './fixtures.ts'

const password = (page: Page) => page.getByLabel(msg('common.login.password'), { exact: true })

async function lock(page: Page) {
  await page.getByRole('button', { name: msg('common.layout.userMenu') }).click()
  await page.getByRole('menuitem', { name: msg('layout.lock.action') }).click()
  await expect(page).toHaveURL(/\/lock$/)
  await expect(page.getByRole('heading', { name: msg('layout.lock.title') })).toBeVisible()
}

async function tryUnlock(page: Page, value: string) {
  await password(page).fill(value)
  await page.getByRole('button', { name: msg('layout.lock.unlock') }).click()
}

test('while locked every page leads to /lock, also after a reload; the password unlocks', async ({
  page,
}) => {
  await signIn(page, 'admin', '/settings/dicts')
  await lock(page)
  for (const path of ['/home', '/settings/dicts', '/password-change']) {
    await page.goto(path)
    await expect(page).toHaveURL(/\/lock$/)
  }
  await page.reload()
  await expect(page).toHaveURL(/\/lock$/)

  await tryUnlock(page, 'wrong-password')
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page).toHaveURL(/\/lock$/)

  await tryUnlock(page, USERS.admin.password)
  await expect(page).toHaveURL(/\/settings\/dicts$/)
  // unlocked: /lock itself is left alone now
  await page.goto('/lock')
  await expect(page).toHaveURL(/\/home$/)
})

test('too many wrong passwords end the session and go to the sign-in page', async ({ page }) => {
  await signIn(page, 'limited', '/home')
  await lock(page)
  // lock threshold 5 (shared login security params): the fifth failure revokes the session
  for (let i = 1; i < 5; i++) {
    await tryUnlock(page, `wrong-${i}`)
    await expect(page.getByRole('alert')).toBeVisible()
  }
  await tryUnlock(page, 'wrong-5')
  await expect(page).toHaveURL(/\/login\?redirect=\/home$/)
  // the session is gone and the lock with it: a page needs a new sign-in
  await page.goto('/home')
  await expect(page).toHaveURL(/\/login\?redirect=/)
})

test('signing out from the lock screen unlocks', async ({ page }) => {
  await signIn(page, 'admin', '/home')
  await lock(page)
  await page.getByRole('button', { name: msg('common.action.signOut') }).click()
  await expect(page).toHaveURL(/\/login$/)
  await signIn(page, 'admin', '/home')
  await expect(page).toHaveURL(/\/home$/)
})
