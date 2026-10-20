// Mass send of an official account (see docs/design-notes.md#wxoa): the shared mass contract, the
// composer only with the send permission, an article mass message picking a synced draft (never
// opening the editor), the confirmation worded per target, the records' state from the dict and the
// article comments opened from an article record by its msg_data_id (opening and closing them, deleting a
// reply), the receipt counts of a record, the list refreshed after a failed submit and the confirmed
// retry of a record whose outcome is unknown, offered only within WeChat's clientmsgid window.
import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { ElMessage } from 'element-plus'
import { WXOA_MASS_RETRY_MS, wxoaMassCreate, wxoaMassPreview, type WxoaMassVo } from '@qiwu/shared'
import { dialogs } from '@/core/dialog'
import DraftPicker from '@/views/platform/wxoa/draft/DraftPicker.vue'
import MassPage from '@/views/platform/wxoa/mass/index.vue'
import { fail, mockApi, ok } from './mock-api'
import { AT, BASE, body, draftVo, sent, useContentPage } from './wxoa-content'

const page = useContentPage()
const job: WxoaMassVo = {
  id: 7,
  accountId: 2,
  targetKind: 'tag',
  tagId: 100,
  openIds: null,
  msgKind: 'text',
  payload: { content: 'hi' },
  clientMsgId: 'qw-7',
  wxMsgId: null,
  msgDataId: null,
  jobState: 'submitted',
  result: null,
  finishedAt: AT,
  createdAt: AT,
}
const ROUTES = {
  ...BASE,
  'GET /wxoa/tags': ok([{ id: 1, accountId: 2, tagId: 100, name: 'VIP', fanCount: 3 }]),
  'GET /wxoa/mass-jobs': ok({ items: [job], total: 1 }),
  'POST /wxoa/mass-jobs': ok(job),
}

describe('wxoa mass contract', () => {
  const base = {
    accountId: 2,
    targetKind: 'openids' as const,
    openIds: ['openid-a', 'openid-b'],
    msgKind: 'text' as const,
    payload: { content: 'hello' },
  }
  it('the payload uses WeChat field names: camelCase is refused', () => {
    const all = { accountId: 2, targetKind: 'all' as const }
    expect(
      wxoaMassCreate.safeParse({ ...all, msgKind: 'text', payload: { content: 'x' } }).success,
    ).toBe(true)
    expect(
      wxoaMassCreate.safeParse({ ...all, msgKind: 'image', payload: { media_id: 'm' } }).success,
    ).toBe(true)
    expect(
      wxoaMassCreate.safeParse({ ...all, msgKind: 'image', payload: { mediaId: 'm' } }).success,
    ).toBe(false)
    expect(
      wxoaMassCreate.safeParse({ ...all, msgKind: 'text', payload: { text: 'x' } }).success,
    ).toBe(false)
  })
  it('openids need two; a tag needs its id; mpnews needs a draft; preview adds one recipient', () => {
    expect(wxoaMassCreate.safeParse(base).success).toBe(true)
    expect(wxoaMassPreview.safeParse({ ...base, toOpenId: 'openid-preview' }).success).toBe(true)
    expect(
      wxoaMassCreate.safeParse({ ...base, targetKind: 'tag', openIds: undefined }).success,
    ).toBe(false)
    expect(
      wxoaMassCreate.safeParse({
        ...base,
        msgKind: 'mpnews',
        openIds: undefined,
        targetKind: 'all',
      }).success,
    ).toBe(false)
  })
})

describe('mass page', () => {
  const radio = (label: string) =>
    Array.from(document.querySelectorAll('.el-radio'))
      .find((r) => r.textContent?.trim() === label)!
      .querySelector('input')!

  it('without wxoa.mass.send there is no composer; the records show their dict state', async () => {
    mockApi(ROUTES)
    page.perms(['wxoa.mass.browse'])
    const w = await page.show(MassPage)
    expect(w.find('.wxoa-mass__composer').exists()).toBe(false)
    expect(page.buttons('Send')).toHaveLength(0)
    const row = w.find('.el-table__body').text()
    expect(row).toContain('Submitted')
    expect(row).toContain('By tag')
  })

  it('an article message picks a synced draft and sends its id', async () => {
    const calls = mockApi(ROUTES)
    page.confirm().mockResolvedValue('confirm' as never)
    await page.show(MassPage)
    radio('Articles').click()
    await flushPromises()
    await page.buttons('Choose draft')[0]!.trigger('click')
    expect(dialogs[0]!.component).toBe(DraftPicker)
    expect(dialogs[0]!.props).toEqual({ accountId: 2 })
    dialogs[0]!.settle(draftVo(5, { title: 'Spring' }))
    await flushPromises()
    expect(page.buttons('Change draft')).toHaveLength(1)
    await page.buttons('Send')[0]!.trigger('click')
    await flushPromises()
    expect(body(sent(calls, 'post', '/wxoa/mass-jobs')[0])).toMatchObject({
      accountId: 2,
      targetKind: 'all',
      msgKind: 'mpnews',
      draftId: 5,
      payload: {},
    })
  })

  it('the confirmation names the target: all fans, the tag, or the number of OpenIDs', async () => {
    const calls = mockApi(ROUTES)
    const ask = page.confirm().mockRejectedValue('cancel')
    const w = await page.show(MassPage)
    await w.find('textarea').setValue('Hello')
    await page.buttons('Send')[0]!.trigger('click')
    await flushPromises()
    expect(String(ask.mock.calls.at(-1)![0])).toBe('Send this message to all fans. Continue?')

    radio('OpenID list').click()
    await flushPromises()
    await w.findAll('textarea')[0]!.setValue('o-1, o-2 o-3')
    await page.buttons('Send')[0]!.trigger('click')
    await flushPromises()
    expect(String(ask.mock.calls.at(-1)![0])).toBe('Send this message to 3 OpenIDs. Continue?')
    expect(sent(calls, 'post', '/wxoa/mass-jobs')).toHaveLength(0)
  })

  it('an image message sends media_id, the field name WeChat uses', async () => {
    const calls = mockApi(ROUTES)
    page.confirm().mockResolvedValue('confirm' as never)
    const w = await page.show(MassPage)
    radio('Image').click()
    await flushPromises()
    await w
      .find('.wxoa-mass__composer input:not([type=radio]):not([type=checkbox])')
      .setValue('m-1')
    await page.buttons('Send')[0]!.trigger('click')
    await flushPromises()
    const sentBody = body(sent(calls, 'post', '/wxoa/mass-jobs')[0])
    expect(sentBody).toMatchObject({ msgKind: 'image', payload: { media_id: 'm-1' } })
    expect(wxoaMassCreate.safeParse(sentBody).success).toBe(true)
  })

  it('article comments open from an article record by its msg_data_id, per article index', async () => {
    let release = () => {}
    const article = { ...job, id: 8, msgKind: 'mpnews' as const, msgDataId: '2247483650' }
    const calls = mockApi({
      ...ROUTES,
      'GET /wxoa/mass-jobs': ok({ items: [job, article], total: 2 }),
      'GET /wxoa/comments': ok({
        items: [
          { userCommentId: '11', openId: 'o1', content: 'Nice', createTime: null },
          { userCommentId: '12', openId: 'o2', content: 'Hello', createTime: null },
        ],
        total: 2,
      }),
      'POST /wxoa/comments/11/elect': () => new Promise((r) => (release = () => r(ok(null)))),
    })
    const w = await page.show(MassPage)
    const rows = w.find('.el-table__body').findAll('tr')
    const entry = (i: number) => rows[i]!.findAll('button').filter((b) => b.text() === 'Comments')
    expect([entry(0).length, entry(1).length]).toEqual([0, 1])
    await entry(1)[0]!.trigger('click')
    await flushPromises()
    expect(sent(calls, 'get', '/wxoa/comments').at(-1)!.params).toMatchObject({
      accountId: 2,
      msgDataId: '2247483650',
      index: 0,
      pageSize: 49,
    })
    const select = () => page.buttons('Select')
    await select()[0]!.trigger('click')
    await flushPromises()
    expect(select()[0]!.classes()).toContain('is-loading')
    expect(select()[1]!.attributes('disabled')).toBeDefined()
    expect(body(sent(calls, 'post', '/wxoa/comments/11/elect')[0])).toEqual({
      accountId: 2,
      msgDataId: '2247483650',
      index: 0,
    })
    release()
    await flushPromises()
    expect(select()[1]!.attributes('disabled')).toBeUndefined()
    // the second article of the same send: index 1
    const number = document.querySelector<HTMLInputElement>(
      '.wxoa-comments .el-input-number input',
    )!
    number.value = '2'
    number.dispatchEvent(new Event('input'))
    number.dispatchEvent(new Event('change'))
    await flushPromises()
    expect(sent(calls, 'get', '/wxoa/comments').at(-1)!.params).toMatchObject({ index: 1 })
  })

  it('without wxoa.comment.browse an article record offers no comments', async () => {
    mockApi({
      ...ROUTES,
      'GET /wxoa/mass-jobs': ok({
        items: [{ ...job, msgKind: 'mpnews', msgDataId: '2247483650' }],
        total: 1,
      }),
    })
    page.perms(['wxoa.mass.browse'])
    const w = await page.show(MassPage)
    expect(
      w
        .find('.el-table__body')
        .findAll('button')
        .map((b) => b.text()),
    ).not.toContain('Comments')
  })

  it('preview without an OpenID says so and sends nothing', async () => {
    const calls = mockApi(ROUTES)
    const w = await page.show(MassPage)
    await w.find('textarea').setValue('Hello')
    await page.buttons('Preview')[0]!.trigger('click')
    await flushPromises()
    expect(sent(calls, 'post', '/wxoa/mass-jobs/preview')).toHaveLength(0)
    expect(ElMessage.error).toHaveBeenCalledWith('Enter the OpenID of the fan to preview to')
  })

  it('a record whose outcome is unknown offers a confirmed retry within the window, loading while it runs', async () => {
    let release = () => {}
    const fresh = new Date(Date.now() - 60_000).toISOString()
    const late = new Date(Date.now() - WXOA_MASS_RETRY_MS - 60_000).toISOString()
    const rows = [
      { ...job, id: 11, createdAt: fresh },
      { ...job, id: 12, createdAt: late },
      { ...job, id: 13, createdAt: fresh, wxMsgId: '1000' },
      { ...job, id: 14, createdAt: fresh, jobState: 'failed' as const },
    ]
    const calls = mockApi({
      ...ROUTES,
      'GET /wxoa/mass-jobs': ok({ items: rows, total: rows.length }),
      'POST /wxoa/mass-jobs/11/retry': () => new Promise((r) => (release = () => r(ok(rows[0])))),
    })
    const ask = page
      .confirm()
      .mockRejectedValueOnce('cancel')
      .mockResolvedValueOnce('confirm' as never)
    const w = await page.show(MassPage)
    const retryIn = (i: number) =>
      w
        .find('.el-table__body')
        .findAll('tr')
        [i]!.findAll('button')
        .filter((b) => b.text() === 'Retry')
    expect([0, 1, 2, 3].map((i) => retryIn(i).length)).toEqual([1, 0, 0, 0])
    await retryIn(0)[0]!.trigger('click')
    await flushPromises()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(sent(calls, 'post', '/wxoa/mass-jobs/11/retry')).toHaveLength(0)
    await retryIn(0)[0]!.trigger('click')
    await flushPromises()
    expect(sent(calls, 'post', '/wxoa/mass-jobs/11/retry')).toHaveLength(1)
    expect(retryIn(0)[0]!.classes()).toContain('is-loading')
    const lists = sent(calls, 'get', '/wxoa/mass-jobs').length
    release()
    await flushPromises()
    expect(sent(calls, 'get', '/wxoa/mass-jobs').length).toBe(lists + 1)
  })

  it('without wxoa.mass.send there is no retry', async () => {
    mockApi({
      ...ROUTES,
      'GET /wxoa/mass-jobs': ok({
        items: [{ ...job, createdAt: new Date().toISOString() }],
        total: 1,
      }),
    })
    page.perms(['wxoa.mass.browse'])
    await page.show(MassPage)
    expect(page.buttons('Retry')).toHaveLength(0)
  })

  it('a failed submit still refreshes the list, where its job may now be', async () => {
    const calls = mockApi({ ...ROUTES, 'POST /wxoa/mass-jobs': fail(502, 'B6001') })
    page.confirm().mockResolvedValue('confirm' as never)
    const w = await page.show(MassPage)
    await w.find('textarea').setValue('Hello')
    const before = sent(calls, 'get', '/wxoa/mass-jobs').length
    await page.buttons('Send')[0]!.trigger('click')
    await flushPromises()
    expect(sent(calls, 'post', '/wxoa/mass-jobs')).toHaveLength(1)
    expect(sent(calls, 'get', '/wxoa/mass-jobs').length).toBe(before + 1)
  })

  it('a finished record shows its receipt counts', async () => {
    mockApi({
      ...ROUTES,
      'GET /wxoa/mass-jobs': ok({
        items: [
          {
            ...job,
            jobState: 'succeeded',
            result: { status: 'send success', totalCount: 5, sentCount: 4, errorCount: 1 },
          },
        ],
        total: 1,
      }),
    })
    const w = await page.show(MassPage)
    expect(w.find('.el-table__body').text()).toContain('Total 5, sent 4, failed 1')
  })

  it('comments of an article: open and close them, delete a reply after confirming', async () => {
    const article = { ...job, id: 8, msgKind: 'mpnews' as const, msgDataId: '2247483650' }
    const calls = mockApi({
      ...ROUTES,
      'GET /wxoa/mass-jobs': ok({ items: [article], total: 1 }),
      'GET /wxoa/comments': ok({
        items: [
          {
            userCommentId: '11',
            openId: 'o1',
            content: 'Nice',
            createTime: null,
            reply: { content: 'Thanks', createTime: null },
          },
        ],
        total: 1,
      }),
      'POST /wxoa/comments/open': ok(null),
      'POST /wxoa/comments/close': ok(null),
      'DELETE /wxoa/comments/11/reply': ok(null),
    })
    const ask = page
      .confirm()
      .mockRejectedValueOnce('cancel')
      .mockResolvedValueOnce('confirm' as never)
    const w = await page.show(MassPage)
    await page.buttons('Comments')[0]!.trigger('click')
    await flushPromises()
    const parent = { accountId: 2, msgDataId: '2247483650', index: 0 }
    await page.buttons('Open comments')[0]!.trigger('click')
    await flushPromises()
    expect(body(sent(calls, 'post', '/wxoa/comments/open')[0])).toEqual(parent)
    await page.buttons('Close comments')[0]!.trigger('click')
    await flushPromises()
    expect(body(sent(calls, 'post', '/wxoa/comments/close')[0])).toEqual(parent)
    await page.buttons('Delete reply')[0]!.trigger('click')
    await flushPromises()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(sent(calls, 'delete', '/wxoa/comments/11/reply')).toHaveLength(0)
    await page.buttons('Delete reply')[0]!.trigger('click')
    await flushPromises()
    expect(body(sent(calls, 'delete', '/wxoa/comments/11/reply')[0])).toEqual(parent)
    expect(w.exists()).toBe(true)
  })

  it('without wxoa.comment.modify and .remove there is no open, close or reply delete', async () => {
    mockApi({
      ...ROUTES,
      'GET /wxoa/mass-jobs': ok({
        items: [{ ...job, msgKind: 'mpnews', msgDataId: '2247483650' }],
        total: 1,
      }),
      'GET /wxoa/comments': ok({
        items: [
          {
            userCommentId: '11',
            openId: 'o1',
            content: 'Nice',
            createTime: null,
            reply: { content: 'Thanks', createTime: null },
          },
        ],
        total: 1,
      }),
    })
    page.perms(['wxoa.mass.browse', 'wxoa.comment.browse'])
    await page.show(MassPage)
    await page.buttons('Comments')[0]!.trigger('click')
    await flushPromises()
    for (const label of ['Open comments', 'Close comments', 'Delete reply'])
      expect(page.buttons(label)).toHaveLength(0)
  })
})
