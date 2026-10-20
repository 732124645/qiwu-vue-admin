// Publishing of an official account (see docs/design-notes.md#wxoa): the shared publish contract,
// publishing a synced draft after a confirmation (from the publish page through the draft picker,
// or from the draft list), the actions following the permissions, the article links, the hint for
// unverified accounts and, instead of comments, the hint pointing to the mass records.
import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { wxoaPublishCreate, wxoaPublishQuery, type WxoaPublishVo } from '@qiwu/shared'
import { dialogs } from '@/core/dialog'
import { useWxoaAccount } from '@/views/platform/wxoa/components/use-wxoa-account'
import DraftPicker from '@/views/platform/wxoa/draft/DraftPicker.vue'
import DraftPage from '@/views/platform/wxoa/draft/index.vue'
import PublishPage from '@/views/platform/wxoa/publish/index.vue'
import { mockApi, ok } from './mock-api'
import { AT, BASE, body, draftVo, sent, useContentPage } from './wxoa-content'

const page = useContentPage()
const pub = (id: number, p: Partial<WxoaPublishVo> = {}): WxoaPublishVo => ({
  id,
  accountId: 2,
  draftId: 1,
  publishId: `p-${id}`,
  articleId: `a-${id}`,
  title: `Published ${id}`,
  publishState: 'succeeded',
  failIdx: null,
  articleUrls: ['https://mp.weixin.qq.com/s/one', 'javascript:alert(1)'],
  finishedAt: AT,
  createdAt: AT,
  ...p,
})
const ROUTES = { ...BASE, 'GET /wxoa/publishes': ok({ items: [pub(4)], total: 1 }) }

describe('wxoa publish contract', () => {
  it('requires the selected account and draft; page filters stay account scoped', () => {
    expect(wxoaPublishCreate.safeParse({ accountId: 2, draftId: 8 }).success).toBe(true)
    expect(wxoaPublishCreate.safeParse({ draftId: 8 }).success).toBe(false)
    expect(wxoaPublishQuery.parse({ accountId: '2', page: '1', pageSize: '20' }).accountId).toBe(2)
  })
})

describe('publish page', () => {
  it('publish: pick a synced draft, confirm, then submit it; a cancelled confirmation sends nothing', async () => {
    const calls = mockApi({ ...ROUTES, 'POST /wxoa/publishes': ok(pub(5)) })
    await page.show(PublishPage)
    const ask = page
      .confirm()
      .mockRejectedValueOnce('cancel')
      .mockResolvedValueOnce('confirm' as never)

    await page.buttons('Publish')[0]!.trigger('click')
    expect(dialogs[0]!.component).toBe(DraftPicker)
    expect(dialogs[0]!.props).toEqual({ accountId: 2 })
    dialogs[0]!.settle(draftVo(1, { title: 'Spring' }))
    await flushPromises()
    expect(String(ask.mock.calls[0]![0])).toContain('Spring')
    expect(sent(calls, 'post', '/wxoa/publishes')).toHaveLength(0)

    await page.buttons('Publish')[0]!.trigger('click')
    dialogs[1]!.settle(draftVo(1))
    await flushPromises()
    expect(body(sent(calls, 'post', '/wxoa/publishes')[0])).toEqual({ accountId: 2, draftId: 1 })
    expect(sent(calls, 'get', '/wxoa/publishes')).toHaveLength(2)
  })

  it('publish and pull need wxoa.publish.create', async () => {
    mockApi(ROUTES)
    page.perms(['wxoa.publish.browse'])
    await page.show(PublishPage)
    expect(page.buttons('Publish')).toHaveLength(0)
    expect(page.buttons('Pull from WeChat')).toHaveLength(0)
  })

  it('shows the article links, only http(s) ones as links; unverified accounts get the hint', async () => {
    mockApi(ROUTES)
    const w = await page.show(PublishPage)
    const links = w.find('.el-table__body').findAll('a')
    expect(links.map((a) => a.attributes('href'))).toEqual(['https://mp.weixin.qq.com/s/one'])
    expect(links[0]!.attributes('rel')).toBe('noopener noreferrer')
    expect(w.text()).not.toContain('needs a verified service account')
    useWxoaAccount().accountId.value = 3
    await flushPromises()
    expect(w.text()).toContain('needs a verified service account')
  })

  it('has no comment entry (published articles carry no msg_data_id) and says where comments are', async () => {
    mockApi(ROUTES)
    const w = await page.show(PublishPage)
    expect(
      w
        .find('.el-table__body')
        .findAll('button')
        .map((b) => b.text()),
    ).not.toContain('Comments')
    expect(w.text()).toContain('Mass messages page')
    page.perms(['wxoa.publish.browse'])
    await flushPromises()
    expect(w.text()).not.toContain('Mass messages page')
  })
})

describe('draft list', () => {
  it('a synced draft without local changes can be published from its row', async () => {
    const calls = mockApi({
      ...BASE,
      'GET /wxoa/drafts': ok({
        items: [draftVo(1), draftVo(2, { dirty: true }), draftVo(3, { mediaId: null })],
        total: 3,
      }),
      'POST /wxoa/publishes': ok(pub(5)),
    })
    page.confirm().mockResolvedValue('confirm' as never)
    const w = await page.show(DraftPage)
    const rows = w.find('.el-table__body').findAll('tr')
    const publishIn = (i: number) =>
      rows[i]!.findAll('button').filter((b) => b.text() === 'Publish')
    expect([0, 1, 2].map((i) => publishIn(i).length)).toEqual([1, 0, 0])
    // the tag follows row.dirty (and a draft never synced has nothing to be out of step with)
    expect([0, 1, 2].map((i) => rows[i]!.text().includes('Unsynced changes'))).toEqual([
      false,
      true,
      false,
    ])
    await publishIn(0)[0]!.trigger('click')
    await flushPromises()
    expect(body(sent(calls, 'post', '/wxoa/publishes')[0])).toEqual({ accountId: 2, draftId: 1 })
  })

  it('searching goes back to page 1', async () => {
    const calls = mockApi({ ...BASE, 'GET /wxoa/drafts': ok({ items: [], total: 60 }) })
    const w = await page.show(DraftPage)
    await w.find('.el-pager li:nth-child(2)').trigger('click')
    await flushPromises()
    expect(sent(calls, 'get', '/wxoa/drafts').at(-1)!.params).toMatchObject({ page: 2 })
    await w.find('.qw-search-panel form').trigger('submit')
    await flushPromises()
    expect(sent(calls, 'get', '/wxoa/drafts').at(-1)!.params).toMatchObject({ page: 1 })
  })
})
