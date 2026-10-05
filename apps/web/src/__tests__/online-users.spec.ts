// Online users page (iam/session): list + filters, kick one / the selected / all of a user
// after a confirm, the own session protected, perms; against a fake backend.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus'
import type { SessionVo } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import SessionList from '@/views/platform/iam/session/index.vue'
import { fail, me, mockApi, ok, type Route } from './mock-api'

const SID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`
const row = (n: number, extra: Partial<SessionVo> = {}): SessionVo => ({
  sid: SID(n),
  userId: 10 + n,
  username: `user${n}`,
  deptName: 'seed.dept.hq',
  userType: 'admin',
  clientId: 'console',
  ip: `10.0.0.${n}`,
  location: null,
  browser: 'Chrome 140',
  os: 'macOS',
  userAgent: 'Mozilla/5.0',
  keepSignedIn: false,
  loginAt: '2026-09-27T01:00:00.000Z',
  lastSeenAt: null,
  expiresAt: '2026-09-28T01:00:00.000Z',
  current: false,
  ...extra,
})
// the caller (admin, user id 1) signed in here and on a phone
const LIST = [
  row(1, { userId: 1, username: 'admin', current: true }),
  row(2),
  row(3, { userId: 1, username: 'admin', clientId: 'mobile' }),
]

function backend(extra: Record<string, Route> = {}) {
  return mockApi({
    'GET /iam/sessions': ok({ items: LIST, total: 3 }),
    [`DELETE /iam/sessions/${SID(2)}`]: ok(null),
    'POST /iam/sessions/kick': (c) => {
      const b = JSON.parse(String(c.data)) as { sids?: string[] }
      return ok({ kicked: b.sids?.length ?? 4 })
    },
    ...extra,
  })
}
const writes = (calls: { method?: string; url?: string; data?: unknown }[]) =>
  calls
    .filter((c) => c.method !== 'get')
    .map((c) => `${c.method?.toUpperCase()} ${c.url}${c.data ? ` ${String(c.data)}` : ''}`)

let page: VueWrapper
async function mountPage(perms = ['*']) {
  useAuthStore().me = me(perms)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { render: () => null } }],
  })
  await router.push('/')
  page = mount(SessionList, {
    global: { plugins: [ElementPlus, i18n, router], directives: { perm: vPerm } },
    attachTo: document.body,
  })
  await flushPromises()
}
const rows = () => page.findAll('.el-table__body .el-table__row')
const button = (text: string, root: VueWrapper | ReturnType<VueWrapper['find']> = page) =>
  root.findAll('button').find((b) => b.text() === text)

let confirm: ReturnType<typeof vi.spyOn>
let success: ReturnType<typeof vi.spyOn>
let error: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
  confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
  success = vi.spyOn(ElMessage, 'success').mockReturnValue(undefined as never)
  error = vi.spyOn(ElMessage, 'error').mockReturnValue(undefined as never)
})
afterEach(() => {
  page.unmount()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('online users', () => {
  it('lists the sessions newest first, marks the own one and filters by username, IP and client', async () => {
    const calls = backend()
    await mountPage()
    expect(calls[0]?.params).toMatchObject({ page: 1, sort: '-loginAt' })
    // selection, username, dept (seeded name as text), ip, …
    expect(rows().map((r) => r.findAll('td')[1]?.text())).toEqual(['admin', 'user2', 'admin'])
    expect(rows()[0]!.findAll('td')[2]?.text()).toBe('Headquarters')
    // the client as a computer (console) or a phone (mobile app)
    expect(rows().map((r) => r.find('.qw-session-client').text())).toEqual([
      'Computer',
      'Computer',
      'Phone',
    ])

    await page.find('input[name="username"]').setValue('adm')
    await page.find('input[name="ip"]').setValue('10.0')
    // the client filter offers the first-party clients by name and sends the raw id the server matches
    await page.find('.qw-search-panel .el-select__wrapper').trigger('click')
    await flushPromises()
    const options = document.body.querySelectorAll<HTMLElement>('.el-select-dropdown__item')
    expect([...options].map((o) => o.textContent?.trim())).toEqual(['Computer', 'Phone'])
    options[1]!.click()
    await page.find('.qw-search-panel form').trigger('submit')
    await flushPromises()
    expect(calls.at(-1)?.params).toMatchObject({
      username: 'adm',
      ip: '10.0',
      clientId: 'mobile',
      page: 1,
    })
  })

  it('filters by a typed OAuth2 client id as well', async () => {
    const calls = backend()
    await mountPage()
    const input = page.find('.qw-search-panel .el-select input')
    await input.trigger('click')
    await input.setValue('partner-app')
    // the filterable select debounces its query by a timer tick
    await new Promise((r) => setTimeout(r))
    await input.trigger('keydown', { key: 'Enter', code: 'Enter' })
    await page.find('.qw-search-panel form').trigger('submit')
    await flushPromises()
    expect(calls.at(-1)?.params).toMatchObject({ clientId: 'partner-app', page: 1 })
  })

  it('never offers to end the own session, nor every session of the own account', async () => {
    backend()
    await mountPage()
    const [own, other, ownElsewhere] = rows()
    expect(own!.find('.el-checkbox').classes()).toContain('is-disabled')
    // the own session is marked where the buttons would be
    expect(button('End session', own)).toBeUndefined()
    expect(button('End all sessions', own)).toBeUndefined()
    expect(own!.find('.el-tag').text()).toBe('This session')
    // another device of the caller: that session alone may go
    expect(button('End session', ownElsewhere)?.attributes('disabled')).toBeUndefined()
    expect(button('End all sessions', ownElsewhere)?.attributes('disabled')).toBeDefined()
    expect(button('End all sessions', other)?.attributes('disabled')).toBeUndefined()
  })

  it('signs out one session, the selected ones or all of a user after asking, then reloads', async () => {
    const calls = backend()
    await mountPage()
    await button('End session', rows()[1])!.trigger('click')
    await flushPromises()
    expect(confirm.mock.calls[0]?.[0]).toBe(
      'End the session of user2 from 10.0.0.2? They will need to sign in again.',
    )
    expect(success).toHaveBeenLastCalledWith('1 session(s) ended')

    await button('End all sessions', rows()[1])!.trigger('click')
    await flushPromises()
    expect(success).toHaveBeenLastCalledWith('4 session(s) ended')

    expect(button('End selected sessions')).toBeUndefined()
    await rows()[1]!.find('.el-checkbox input').setValue(true)
    await rows()[2]!.find('.el-checkbox input').setValue(true)
    await button('End selected sessions')!.trigger('click')
    await flushPromises()
    expect(confirm.mock.calls[2]?.[0]).toBe(
      'End the 2 selected session(s)? Affected users will need to sign in again.',
    )
    expect(success).toHaveBeenLastCalledWith('2 session(s) ended')

    expect(writes(calls)).toEqual([
      `DELETE /iam/sessions/${SID(2)}`,
      'POST /iam/sessions/kick {"userId":12}',
      `POST /iam/sessions/kick {"sids":["${SID(2)}","${SID(3)}"]}`,
    ])
    // each kick reloads the list
    expect(calls.filter((c) => c.url === '/iam/sessions')).toHaveLength(4)

    // a refused confirm sends nothing
    confirm.mockRejectedValueOnce('cancel')
    const before = calls.length
    await button('End session', rows()[1])!.trigger('click')
    await flushPromises()
    expect(calls).toHaveLength(before)
  })

  it('keeps the sign-out buttons busy until the list has reloaded', async () => {
    let release = () => {}
    let slow = false
    backend({
      'GET /iam/sessions': async () => {
        if (slow) await new Promise<void>((r) => (release = r))
        return ok({ items: LIST, total: 3 })
      },
    })
    await mountPage()
    await rows()[1]!.find('.el-checkbox input').setValue(true)
    slow = true
    await button('End selected sessions')!.trigger('click')
    await flushPromises()
    expect(success).toHaveBeenCalledWith('1 session(s) ended')
    expect(button('End selected sessions')!.classes()).toContain('is-loading')
    expect(button('End session', rows()[2])!.attributes('disabled')).toBeDefined()
    release()
    await flushPromises()
    expect(button('End session', rows()[2])!.attributes('disabled')).toBeUndefined()
  })

  it('shows a session that ended meanwhile (404) and reloads', async () => {
    const calls = backend({
      [`DELETE /iam/sessions/${SID(2)}`]: fail(404, 'A0440', 'Session not found'),
    })
    await mountPage()
    await button('End session', rows()[1])!.trigger('click')
    await flushPromises()
    expect(error).toHaveBeenCalledWith('Session not found')
    expect(success).not.toHaveBeenCalled()
    expect(calls.filter((c) => c.url === '/iam/sessions')).toHaveLength(2)
  })

  it('shows no sign-out controls without the kick perm', async () => {
    backend()
    await mountPage(['iam.session.browse'])
    // the own session's row has no buttons at all
    for (const r of rows().slice(1)) {
      expect(button('End session', r)?.isVisible()).toBe(false)
      expect(button('End all sessions', r)?.isVisible()).toBe(false)
    }
  })
})
