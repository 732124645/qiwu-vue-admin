import { describe, expect, it } from 'vitest'
import {
  WXOA_CONTENT_MAX,
  WXOA_MASS_OPENIDS_MAX,
  wxoaCommentQuery,
  wxoaDraftArticle,
  wxoaMassCreate,
  wxoaNoticeAdd,
  wxoaNoticeSend,
  wxoaStatQuery,
} from '@qiwu/shared'

const article = {
  title: '标题',
  author: '',
  digest: '',
  content: '<p>正文</p>',
  thumbMediaId: 'thumb-1',
  needOpenComment: true,
  onlyFansCanComment: false,
}

describe('wxoa content and operations contracts', () => {
  it('draft articles cap body length and accept one to eight articles', () => {
    expect(wxoaDraftArticle.safeParse(article).success).toBe(true)
    expect(
      wxoaDraftArticle.safeParse({ ...article, content: 'x'.repeat(WXOA_CONTENT_MAX + 1) }).success,
    ).toBe(false)
    expect(wxoaDraftArticle.safeParse({ ...article, title: '' }).success).toBe(false)
  })

  it('mass target fields are mutually exclusive and openid list is bounded', () => {
    expect(
      wxoaMassCreate.safeParse({
        accountId: 1,
        targetKind: 'all',
        msgKind: 'text',
        payload: { content: 'x' },
      }).success,
    ).toBe(true)
    expect(
      wxoaMassCreate.safeParse({
        accountId: 1,
        targetKind: 'tag',
        tagId: 4,
        msgKind: 'text',
        payload: { content: 'x' },
      }).success,
    ).toBe(true)
    expect(
      wxoaMassCreate.safeParse({
        accountId: 1,
        targetKind: 'tag',
        msgKind: 'text',
        payload: { content: 'x' },
      }).success,
    ).toBe(false)
    expect(
      wxoaMassCreate.safeParse({
        accountId: 1,
        targetKind: 'openids',
        openIds: ['one'],
        msgKind: 'text',
        payload: { content: 'x' },
      }).success,
    ).toBe(false)
    expect(
      wxoaMassCreate.safeParse({
        accountId: 1,
        targetKind: 'openids',
        openIds: Array.from({ length: WXOA_MASS_OPENIDS_MAX + 1 }, (_, i) => String(i)),
        msgKind: 'text',
        payload: { content: 'x' },
      }).success,
    ).toBe(false)
  })

  it('mass payloads use the WeChat field names of their kind', () => {
    const base = { accountId: 1, targetKind: 'all' }
    expect(wxoaMassCreate.safeParse({ ...base, msgKind: 'text', payload: {} }).success).toBe(false)
    expect(
      wxoaMassCreate.safeParse({ ...base, msgKind: 'image', payload: { media_id: 'm' } }).success,
    ).toBe(true)
    expect(
      wxoaMassCreate.safeParse({ ...base, msgKind: 'video', payload: { mediaId: 'm' } }).success,
    ).toBe(false)
  })

  it('a subscribe-notice template is picked by tid with two to five keywords', () => {
    const body = { accountId: 1, tid: '99', kidList: [1, 2], sceneDesc: '付款提醒' }
    expect(wxoaNoticeAdd.safeParse(body).success).toBe(true)
    expect(wxoaNoticeAdd.safeParse({ ...body, kidList: [1] }).success).toBe(false)
    expect(wxoaNoticeAdd.safeParse({ ...body, sceneDesc: 'x'.repeat(16) }).success).toBe(false)
  })

  it('stat range is at most ninety days', () => {
    expect(
      wxoaStatQuery.safeParse({ accountId: 1, from: '2026-01-01', to: '2026-03-31' }).success,
    ).toBe(true)
    expect(
      wxoaStatQuery.safeParse({ accountId: 1, from: '2026-01-01', to: '2026-04-01' }).success,
    ).toBe(false)
  })

  it('comment pages stay below the upstream limit of 50 and need a numeric article id', () => {
    const query = { accountId: 1, msgDataId: '2247490098', index: 0, type: 'all', page: 1 }
    expect(wxoaCommentQuery.safeParse({ ...query, pageSize: 49 }).success).toBe(true)
    expect(wxoaCommentQuery.safeParse({ ...query, pageSize: 50 }).success).toBe(false)
    expect(wxoaCommentQuery.safeParse({ ...query, msgDataId: 'article-1' }).success).toBe(false)
    expect(
      wxoaCommentQuery.safeParse({ accountId: 1, msgDataId: '', index: 0, type: 'all' }).success,
    ).toBe(false)
    expect(
      wxoaCommentQuery.safeParse({
        accountId: 1,
        msgDataId: '1',
        index: 0,
        type: 'all',
        pageSize: 51,
      }).success,
    ).toBe(false)
  })

  it('notice sends no more than twenty fans', () => {
    const body = {
      accountId: 1,
      fanIds: Array.from({ length: 20 }, (_, i) => i + 1),
      data: { thing1: 'ok' },
    }
    expect(wxoaNoticeSend.safeParse(body).success).toBe(true)
    expect(wxoaNoticeSend.safeParse({ ...body, fanIds: [...body.fanIds, 21] }).success).toBe(false)
  })
})
