import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import type { MyInboxItemVo } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import InboxMessageView from '@/core/layout/InboxMessageView.vue'

let wrapper: VueWrapper | undefined
const message: MyInboxItemVo = {
  id: 1,
  category: 'business',
  senderLabel: null,
  title: 'Waiting',
  body: '<a href="https://outside.example.invalid">Open</a>',
  readAt: null,
  createdAt: '2026-10-27T00:00:00.000Z',
}

beforeEach(() => setLocale('en-US'))
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  setLocale('zh-CN')
})

describe('inbox message view', () => {
  it('keeps notification text literal and only offers to close', async () => {
    wrapper = mount(InboxMessageView, {
      props: { message },
      global: { plugins: [ElementPlus, i18n] },
    })
    expect(wrapper.find('.inbox-message-view__body a').exists()).toBe(false)
    expect(wrapper.find('.inbox-message-view__body').text()).toBe(message.body)
    const buttons = wrapper.findAll('button')
    expect(buttons.map((button) => button.text())).toEqual(['Close'])
    await buttons[0]!.trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })
})
