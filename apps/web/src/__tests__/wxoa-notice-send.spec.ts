// Subscribe notifications of an official account (see docs/design-notes.md#wxoa): "add template"
// opens at the first click and loads the library in the dialog (category, its titles, a title's
// keywords; 2–5 keywords and a scene to add), and the send dialog picks followed fans by remote
// search and checks its input with the shared schema.
import { describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { ElSelect } from 'element-plus'
import type { WxoaFanVo, WxoaNoticeTemplateVo } from '@qiwu/shared'
import { dialogs } from '@/core/dialog'
import NoticeAdd from '@/views/platform/wxoa/notice/add.vue'
import NoticePage from '@/views/platform/wxoa/notice/index.vue'
import NoticeSend from '@/views/platform/wxoa/notice/send.vue'
import { mockApi, ok } from './mock-api'
import { AT, BASE, body, sent, useContentPage } from './wxoa-content'

const page = useContentPage()
const template: WxoaNoticeTemplateVo = {
  priTmplId: 'pri-1',
  title: 'Order update',
  content: 'Item: {{thing1.DATA}}\nTime: {{time2.DATA}}',
  example: null,
}
const fan = (id: number, remark: string | null): WxoaFanVo => ({
  id,
  accountId: 2,
  openId: `o-fan-${id}`,
  unionId: null,
  subscribed: true,
  subscribedAt: AT,
  unsubscribedAt: null,
  subscribeScene: null,
  qrScene: null,
  remark,
  lang: null,
  tagIds: [],
  blocked: false,
  lastInboundAt: null,
  lastEventAt: null,
  syncedAt: null,
  createdAt: AT,
})
const ROUTES = {
  ...BASE,
  'GET /wxoa/notice-templates': ok([template]),
  'GET /wxoa/fans': ok({ items: [fan(7, 'Alice'), fan(8, null)], total: 2 }),
}

describe('notice templates', () => {
  it('"add template" opens at the first click; the dialog loads categories, titles, then keywords', async () => {
    const calls = mockApi({
      ...ROUTES,
      'GET /wxoa/notice-templates/library': (c) =>
        ok(
          c.params.tid === '11'
            ? {
                keywords: [1, 2, 3].map((kid) => ({
                  kid,
                  name: `Key ${kid}`,
                  example: 'x',
                  rule: 'thing',
                })),
              }
            : c.params.categoryId === 7
              ? c.params.start === 0
                ? {
                    titles: [{ tid: '11', title: 'Order notice', type: 2, categoryId: '7' }],
                    total: 2,
                  }
                : {
                    titles: [{ tid: '12', title: 'Refund notice', type: 2, categoryId: '7' }],
                    total: 2,
                  }
              : { categories: [{ id: '7', name: 'Retail' }] },
        ),
      'POST /wxoa/notice-templates': ok({ priTmplId: 'pri-9' }),
    })
    const list = await page.show(NoticePage)
    await page.buttons('Add template')[0]!.trigger('click')
    expect(dialogs).toHaveLength(1)
    expect(dialogs[0]!.component).toBe(NoticeAdd)
    expect(dialogs[0]!.props).toEqual({ accountId: 2 })
    expect(sent(calls, 'get', '/wxoa/notice-templates/library')).toHaveLength(0)
    list.unmount()

    // the dialog's content on its own

    const add = await page.show(NoticeAdd, { accountId: 2 })
    expect(sent(calls, 'get', '/wxoa/notice-templates/library')[0]!.params).toEqual({
      accountId: 2,
    })
    const [category, title] = add.findAllComponents(ElSelect)
    category!.vm.$emit('update:modelValue', '7')
    await flushPromises()
    expect(sent(calls, 'get', '/wxoa/notice-templates/library').at(-1)!.params).toEqual({
      accountId: 2,
      categoryId: 7,
      start: 0,
    })
    // the next page of titles starts after the ones shown
    await add
      .findAll('button')
      .find((b) => b.text().startsWith('Load more'))!
      .trigger('click')
    await flushPromises()
    expect(sent(calls, 'get', '/wxoa/notice-templates/library').at(-1)!.params).toMatchObject({
      start: 1,
    })
    expect(add.findAll('button').some((b) => b.text().startsWith('Load more'))).toBe(false)
    title!.vm.$emit('update:modelValue', '11')
    await flushPromises()
    expect(sent(calls, 'get', '/wxoa/notice-templates/library').at(-1)!.params).toEqual({
      accountId: 2,
      tid: '11',
    })
    const addButton = () => page.buttons('Add template')[0]!
    const boxes = add.findAll('.el-checkbox input')
    expect(boxes).toHaveLength(3)
    // one keyword and no scene: not yet
    await boxes[0]!.setValue(true)
    expect(addButton().attributes('disabled')).toBeDefined()
    await boxes[2]!.setValue(true)
    await add.find('input[maxlength="15"]').setValue('Shipped')
    expect(addButton().attributes('disabled')).toBeUndefined()
    await addButton().trigger('click')
    await flushPromises()
    expect(body(sent(calls, 'post', '/wxoa/notice-templates')[0])).toEqual({
      accountId: 2,
      tid: '11',
      kidList: [1, 3],
      sceneDesc: 'Shipped',
    })
    expect(add.emitted('done')).toEqual([['pri-9']])
  })
})

describe('notice send dialog', () => {
  it('fans by remote search; empty fans or values show errors; then sends', async () => {
    const calls = mockApi({ ...ROUTES, 'POST /wxoa/notice-templates/pri-1/send': ok([{}, {}]) })
    const w = await page.show(NoticeSend, { accountId: 2, template })
    expect(sent(calls, 'get', '/wxoa/fans')[0]!.params).toMatchObject({
      accountId: 2,
      subscribed: true,
    })
    const select = w.findComponent(ElSelect)
    expect(select.props('multipleLimit')).toBe(20)
    ;(select.props('remoteMethod') as (q: string) => void)('Ali')
    await flushPromises()
    expect(sent(calls, 'get', '/wxoa/fans').at(-1)!.params).toMatchObject({ remark: 'Ali' })

    await page.buttons('Send')[0]!.trigger('click')
    await flushPromises()
    expect(sent(calls, 'post', '/wxoa/notice-templates/pri-1/send')).toHaveLength(0)
    const errors = () => w.findAll('.el-form-item__error').map((e) => e.text())
    await vi.waitFor(() => {
      expect(errors().some((e) => e.includes('Fans'))).toBe(true)
      expect(errors()).toContain('Item is required')
    })

    select.vm.$emit('update:modelValue', [7, 8])
    await w.findAll('input[name^="data."]')[0]!.setValue('Tea')
    await w.findAll('input[name^="data."]')[1]!.setValue('2026-10-18')
    await page.buttons('Send')[0]!.trigger('click')
    await flushPromises()
    expect(body(sent(calls, 'post', '/wxoa/notice-templates/pri-1/send')[0])).toEqual({
      accountId: 2,
      fanIds: [7, 8],
      data: { thing1: 'Tea', time2: '2026-10-18' },
      url: null,
    })
    expect(w.emitted('done')).toEqual([[2]])
  })
})
