import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus, { ElMessageBox } from 'element-plus'
import { i18n, setLocale } from '@/core/i18n'
import ProfileView from '@/views/profile/index.vue'
import { mockApi, ok, type Route } from './mock-api'

// The personal center's WeChat binding, shown while WeChat sign-in is on or one is left.
const profile = {
  id: 42,
  username: 'person',
  displayName: 'Person',
  gender: 'unknown',
  mobile: null,
  email: null,
  avatarUrl: null,
  locale: null,
  deptName: null,
  roleNames: [],
  positionNames: [],
}
const SWITCH = 'GET /settings/params/public/auth.wx_mp.enabled'
const switchedTo = (value: string) => ok({ key: 'auth.wx_mp.enabled', value })
const bound = { provider: 'wx-mp', appid: 'wx0123', boundAt: '2026-10-01T02:03:00.000Z' }

const page = async (routes: Record<string, Route>) => {
  const calls = mockApi({ 'GET /iam/profile': ok(profile), ...routes })
  const wrapper = mount(ProfileView, { global: { plugins: [createPinia(), i18n, ElementPlus] } })
  await flushPromises()
  return { wrapper, calls }
}
const tab = (wrapper: Awaited<ReturnType<typeof page>>['wrapper']) =>
  wrapper.findAll('.el-tabs__item').find((i) => i.text() === 'Linked accounts')

beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
})
afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

it('switch off (or unreadable) and nothing bound: no linked-accounts tab', async () => {
  for (const answer of [switchedTo('false'), undefined]) {
    const { wrapper, calls } = await page({
      ...(answer ? { [SWITCH]: answer } : {}),
      'GET /iam/profile/socials': ok([]),
    })
    expect(calls.some((c) => c.url === '/iam/profile/socials')).toBe(true)
    expect(tab(wrapper)).toBeUndefined()
    wrapper.unmount()
  }
})

it('switch off with a binding left: the tab shows it, so it can be unlinked', async () => {
  let list = [bound]
  const { wrapper, calls } = await page({
    [SWITCH]: switchedTo('false'),
    'GET /iam/profile/socials': () => ok(list),
    'DELETE /iam/profile/socials/wx-mp': () => ((list = []), ok(null)),
  })
  vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
  await tab(wrapper)!.trigger('click')
  await flushPromises()
  expect(wrapper.find('time').attributes('datetime')).toBe(bound.boundAt)
  await wrapper
    .findAll('button')
    .find((b) => b.text() === 'Unlink')!
    .trigger('click')
  await flushPromises()
  expect(calls.filter((c) => c.method === 'delete')).toHaveLength(1)
  expect(wrapper.text()).toContain('Not linked')
  wrapper.unmount()
})

it('switch on: shows the binding, unlinks after confirming, then shows it unbound', async () => {
  let list = [bound]
  const { wrapper, calls } = await page({
    [SWITCH]: switchedTo('true'),
    'GET /iam/profile/socials': () => ok(list),
    'DELETE /iam/profile/socials/wx-mp': () => ((list = []), ok(null)),
  })
  const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
  await tab(wrapper)!.trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('WeChat mini program')
  expect(wrapper.find('time').attributes('datetime')).toBe(bound.boundAt)
  const unlink = wrapper.findAll('button').find((b) => b.text() === 'Unlink')!
  await unlink.trigger('click')
  await flushPromises()
  expect(confirm).toHaveBeenCalledOnce()
  expect(calls.filter((c) => c.method === 'delete').map((c) => c.url)).toEqual([
    '/iam/profile/socials/wx-mp',
  ])
  expect(wrapper.text()).toContain('Not linked')
  expect(wrapper.findAll('button').some((b) => b.text() === 'Unlink')).toBe(false)
  wrapper.unmount()
})

it('a cancelled confirmation unlinks nothing', async () => {
  const { wrapper, calls } = await page({
    [SWITCH]: switchedTo('true'),
    'GET /iam/profile/socials': ok([bound]),
  })
  vi.spyOn(ElMessageBox, 'confirm').mockRejectedValue('cancel')
  await tab(wrapper)!.trigger('click')
  await flushPromises()
  await wrapper
    .findAll('button')
    .find((b) => b.text() === 'Unlink')!
    .trigger('click')
  await flushPromises()
  expect(calls.some((c) => c.method === 'delete')).toBe(false)
  wrapper.unmount()
})
