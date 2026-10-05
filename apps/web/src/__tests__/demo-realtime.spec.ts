// Realtime push demo page: the connection badge, the send form (users picked in
// UserPicker, roles, everyone with the broadcast permission; 500-character text), the received log
// (newest first, 100 kept, plain text, clear) and the subscription ending with the page; against a fake
// backend and a fake realtime socket.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessage } from 'element-plus'
import dayjs from 'dayjs'
import { demoRealtimePerms, RT, type RealtimePayloads, type UserOption } from '@qiwu/shared'
import UserPicker from '@/core/components/UserPicker.vue'
import { openDialog } from '@/core/dialog'
import { i18n, setLocale } from '@/core/i18n'
import { realtimeStatus } from '@/core/realtime/socket'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import DemoRealtime from '@/views/demo/realtime/index.vue'
import { me, mockApi, ok, type Route } from './mock-api'

/**
 * The fake socket: `realtimeStatus` as a plain ref; subscriptions kept by type (so a test can push) and
 * dropped when the subscribing scope ends, like the real `onRealtime`.
 */
const pushes = vi.hoisted(() => new Map<string, (payload: unknown) => void>())
vi.mock('@/core/realtime/socket', async () => {
  const { getCurrentScope, onScopeDispose, shallowRef } = await import('vue')
  return {
    realtimeStatus: shallowRef('up'),
    onRealtime: (type: string, fn: (payload: unknown) => void) => {
      pushes.set(type, fn)
      const off = () => void pushes.delete(type)
      if (getCurrentScope()) onScopeDispose(off)
      return off
    },
  }
})
// the picker itself is covered by user-picker.spec: here it answers with the users a test sets
vi.mock('@/core/dialog', async (orig) => ({
  ...(await orig<typeof import('@/core/dialog')>()),
  openDialog: vi.fn<typeof openDialog>(),
}))

const ANN: UserOption = { id: 11, username: 'ann', displayName: 'Ann Lee', deptName: null }
const BOB: UserOption = { id: 12, username: 'bob', displayName: 'Bob Wu', deptName: null }
const ALL = ['*']

function backend(extra: Record<string, Route> = {}) {
  return mockApi({
    'GET /iam/roles/options': ok([
      { id: 2, code: 'ops', name: 'Ops team' },
      { id: 3, code: 'audit', name: 'Auditors' },
    ]),
    'POST /demo/realtime/send': ok({ delivered: 2 }),
    ...extra,
  })
}
const sent = (calls: { method?: string; url?: string; data?: unknown }[]) =>
  calls
    .filter((c) => c.method === 'post' && c.url === '/demo/realtime/send')
    .map((c) => JSON.parse(String(c.data)) as unknown)

let page: VueWrapper
async function mountPage(perms = ALL) {
  useAuthStore().me = me(perms)
  page = mount(DemoRealtime, { global: { plugins: [ElementPlus, i18n] }, attachTo: document.body })
  await flushPromises()
}
const body = () => new DOMWrapper(document.body)
const radio = (label: string) => page.findAll('.el-radio').find((r) => r.text() === label)
const sendButton = () => page.findAll('button').find((b) => b.text() === 'Send')!
const errors = () => page.findAll('.el-form-item__error').map((e) => e.text())
async function typeText(text: string) {
  await page.find('textarea').setValue(text)
}
async function pickUsers(users: UserOption[]) {
  vi.mocked(openDialog).mockResolvedValueOnce(users)
  await page
    .findAll('button')
    .find((b) => b.text() === 'Select users')!
    .trigger('click')
  await flushPromises()
}
async function submit() {
  await sendButton().trigger('click')
  await flushPromises()
}
function push(payload: RealtimePayloads['demo:message']) {
  pushes.get(RT.demoMessage)!(payload)
  return flushPromises()
}
const entries = () =>
  page.findAll('.demo-realtime__item').map((li) => ({
    from: li.find('.demo-realtime__from').text(),
    time: li.find('time').text(),
    text: li.find('.demo-realtime__text').text(),
  }))

let success: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
  realtimeStatus.value = 'up'
  success = vi.spyOn(ElMessage, 'success').mockReturnValue(undefined as never)
})
afterEach(() => {
  page?.unmount()
  vi.restoreAllMocks()
  vi.mocked(openDialog).mockReset()
  pushes.clear()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('realtime demo page', () => {
  it('the status badge follows the socket: connected, reconnecting, disconnected', async () => {
    backend()
    await mountPage()
    const badge = () => page.find('[role="status"]')
    expect(badge().text()).toBe('Connected')
    expect(badge().classes()).toContain('el-tag--success')
    realtimeStatus.value = 'reconnecting'
    await flushPromises()
    expect(badge().text()).toBe('Reconnecting')
    expect(badge().classes()).toContain('el-tag--warning')
    realtimeStatus.value = 'down'
    await flushPromises()
    expect(badge().text()).toBe('Disconnected')
    expect(badge().classes()).toContain('el-tag--danger')
    setLocale('zh-CN')
    await flushPromises()
    expect(badge().text()).toBe('已断开')
  })

  it('perms: no form (and no role list) without send; everyone only with broadcast', async () => {
    const calls = backend()
    await mountPage([demoRealtimePerms.send])
    expect(page.find('form').exists()).toBe(true)
    expect(page.findAll('.el-radio').map((r) => r.text())).toEqual(['Users', 'Roles'])
    page.unmount()
    await mountPage([demoRealtimePerms.send, demoRealtimePerms.broadcast])
    expect(page.findAll('.el-radio').map((r) => r.text())).toEqual(['Users', 'Roles', 'Everyone'])
    page.unmount()
    // anyone signed in still sees what reaches them
    calls.length = 0
    await mountPage([])
    expect(page.find('form').exists()).toBe(false)
    expect(page.find('.demo-realtime__log').exists()).toBe(true)
    expect(calls).toEqual([])
  })

  it('sends the text as typed to the picked users, loads while pending, says how many got it', async () => {
    let answer!: () => void
    const calls = backend({
      'POST /demo/realtime/send': () =>
        new Promise((resolve) => (answer = () => resolve(ok({ delivered: 1 })))),
    })
    await mountPage()
    await pickUsers([ANN, BOB])
    expect(openDialog).toHaveBeenCalledWith(
      UserPicker,
      { multiple: true, selected: [] },
      expect.objectContaining({ width: 880 }),
    )
    expect(page.findAll('.demo-realtime__users .el-tag').map((t) => t.text())).toEqual([
      'Ann Lee',
      'Bob Wu',
    ])
    // a removed tag leaves the list; the picker reopens with the users kept
    await page.findAll('.demo-realtime__users .el-tag')[1]!.find('.el-tag__close').trigger('click')
    await pickUsers([ANN, BOB])
    expect(vi.mocked(openDialog).mock.calls[1]![1]).toEqual({ multiple: true, selected: [ANN] })

    await typeText('  <b>hi</b>\nsecond line ')
    await submit()
    expect(sendButton().classes()).toContain('is-loading')
    expect(sendButton().attributes('disabled')).toBeDefined()
    await submit()
    answer()
    await flushPromises()
    expect(sent(calls)).toEqual([
      { target: 'user', userIds: [11, 12], text: '  <b>hi</b>\nsecond line ' },
    ])
    expect(success).toHaveBeenCalledWith('Sent to 1 online user')
    expect(page.find('textarea').element.value).toBe('')
    expect(sendButton().classes()).not.toContain('is-loading')
  })

  it('roles: the chosen roles only (users picked before stay out); everyone without a list', async () => {
    const calls = backend()
    await mountPage()
    await pickUsers([ANN])
    await radio('Roles')!.find('input').setValue(true)
    expect(page.find('.demo-realtime__users').exists()).toBe(false)
    await page.find('.el-select__wrapper').trigger('click')
    await flushPromises()
    const options = body().findAll('.el-select-dropdown__item')
    expect(options.map((o) => o.text())).toEqual(['Ops team', 'Auditors'])
    await options[1]!.trigger('click')
    await typeText('to the auditors')
    await submit()
    await radio('Everyone')!.find('input').setValue(true)
    await typeText('to all')
    await submit()
    expect(sent(calls)).toEqual([
      { target: 'role', roleIds: [3], text: 'to the auditors' },
      { target: 'all', text: 'to all' },
    ])
    expect(success).toHaveBeenLastCalledWith('Sent to 2 online users')
  })

  it('checks before sending: users or roles for the target, a message that is not only spaces', async () => {
    const calls = backend()
    await mountPage()
    await submit()
    await vi.waitFor(() => expect(errors()).toEqual(['Users is required', 'Message is required']))
    await typeText('   ')
    await submit()
    await vi.waitFor(() => expect(errors()).toEqual(['Users is required', 'Message is required']))
    await typeText('hello')
    await submit()
    await vi.waitFor(() => expect(errors()).toEqual(['Users is required']))
    // picking clears the error at once, removing the last user shows it again (no submit needed)
    await pickUsers([ANN])
    await vi.waitFor(() => expect(errors()).toEqual([]))
    await page.find('.demo-realtime__users .el-tag__close').trigger('click')
    await vi.waitFor(() => expect(errors()).toEqual(['Users is required']))
    await radio('Roles')!.find('input').setValue(true)
    await submit()
    await vi.waitFor(() => expect(errors()).toEqual(['Roles is required']))
    expect(sent(calls)).toEqual([])
  })

  it('the message box stops at 500 characters and counts them', async () => {
    backend()
    await mountPage()
    expect(page.find('textarea').attributes('maxlength')).toBe('500')
    expect(page.find('.el-input__count').text()).toBe('0 / 500')
    await typeText('hello')
    expect(page.find('.el-input__count').text()).toBe('5 / 500')
  })

  it('the log: newest first with sender, time and plain text, 100 kept, cleared; gone with the page', async () => {
    backend()
    await mountPage()
    const clear = () => page.findAll('button').find((b) => b.text() === 'Clear')!
    expect(page.find('.empty-state').text()).toContain('No messages yet')
    expect(clear().attributes('disabled')).toBeDefined()
    // one live region from the start (not one created with the first message)
    const live = page.find('[aria-live="polite"]').element

    const at = '2026-09-29T08:00:05.000Z'
    await push({ from: { id: 1, name: 'Admin' }, text: 'first', at })
    await push({
      from: { id: 12, name: 'Bob <i>Wu</i>' },
      text: '<img src=x onerror="alert(1)">\nline two',
      at,
    })
    expect(entries()).toEqual([
      {
        from: 'Bob <i>Wu</i>',
        time: dayjs(at).format('YYYY-MM-DD HH:mm:ss'),
        text: '<img src=x onerror="alert(1)">\nline two',
      },
      { from: 'Admin', time: dayjs(at).format('YYYY-MM-DD HH:mm:ss'), text: 'first' },
    ])
    expect(page.find('[aria-live="polite"]').element).toBe(live)
    expect(live.querySelector('.demo-realtime__list')).not.toBeNull()
    expect(page.find('.demo-realtime__list img').exists()).toBe(false)
    expect(page.find('.demo-realtime__list i').exists()).toBe(false)

    for (let i = 3; i <= 105; i++) await push({ from: { id: 1, name: 'Admin' }, text: `#${i}`, at })
    const texts = entries().map((e) => e.text)
    expect(texts).toHaveLength(100)
    expect(texts[0]).toBe('#105')
    expect(texts.at(-1)).toBe('#6')

    await clear().trigger('click')
    expect(entries()).toEqual([])
    expect(page.find('.empty-state').exists()).toBe(true)

    page.unmount()
    expect(pushes.has(RT.demoMessage)).toBe(false)
  })
})
