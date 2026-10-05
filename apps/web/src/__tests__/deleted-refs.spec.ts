// Soft delete: a row pointing to a deleted one keeps its id and the API sends the name as null;
// the pages show `#<id> (deleted)` there (`refName`), the inbox admin pages as the example here.
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import type { InboxVo } from '@qiwu/shared'
import { i18n, refName, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import InboxList from '@/views/platform/messaging/inbox/index.vue'
import InboxDetail from '@/views/platform/messaging/inbox/detail.vue'
import { me, mockApi, ok } from './mock-api'

const inbox = (id: number, extra: Partial<InboxVo> = {}): InboxVo => ({
  id,
  userId: 12,
  recipientName: null,
  templateCode: 'welcome',
  locale: 'en-US',
  category: 'notice',
  senderLabel: null,
  title: `Title ${id}`,
  body: 'Body',
  params: null,
  status: 'unread',
  attempts: 0,
  readAt: null,
  createdAt: '2026-09-28T01:00:00.000Z',
  ...extra,
})

let wrapper: VueWrapper | undefined
beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
  useAuthStore().me = me(['*'])
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

it('refName: the name as typed (never translated), #<id> (deleted) without one, empty without an id', () => {
  expect(refName(3, 'seed.role.root')).toBe('seed.role.root')
  expect(refName(3, 'Mail box')).toBe('Mail box')
  expect(refName(12, null)).toBe('#12 (deleted)')
  expect(refName(null, null)).toBe('')
  setLocale('zh-CN')
  expect(refName(12, undefined)).toBe('#12（已删除）')
})

it('inbox list and detail mark a deleted recipient', async () => {
  mockApi({
    'GET /messaging/inboxes': ok({
      items: [inbox(1), inbox(2, { userId: 3, recipientName: 'Ann (ann)' })],
      total: 2,
    }),
    'GET /messaging/inboxes/1': ok(inbox(1)),
  })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { render: () => null } }],
  })
  await router.push('/')
  wrapper = mount(InboxList, {
    global: { plugins: [ElementPlus, i18n, router], directives: { perm: vPerm } },
    attachTo: document.body,
  })
  await flushPromises()
  const firstCells = wrapper
    .findAll('.el-table__body .el-table__row')
    .map((r) => r.find('td').text())
  expect(firstCells).toEqual(['#12 (deleted)', 'Ann (ann)'])
  wrapper.unmount()

  wrapper = mount(InboxDetail, { props: { id: 1 }, global: { plugins: [ElementPlus, i18n] } })
  await flushPromises()
  expect(wrapper.find('.el-descriptions').text()).toContain('#12 (deleted)')
})
