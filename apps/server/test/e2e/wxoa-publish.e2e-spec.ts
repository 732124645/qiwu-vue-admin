import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { Err } from '@qiwu/shared'
import { bearer } from '../setup/auth.js'
import { addAccount, closeContentApp, openContentApp } from './wxoa-content.helpers.js'
import { WxoaInboundHub } from '../../src/modules/platform/wxoa/core/wxoa-inbound-hub.js'

describe('wxoa publishes', () => {
  let ctx: Awaited<ReturnType<typeof openContentApp>>
  const ids: number[] = []
  let account: { id: number }
  let other: { id: number }
  let draftId: number
  let foreignDraftId: number
  const http = () => request(ctx.app.getHttpServer())
  const article = (thumbMediaId: string) => ({
    title: 'P',
    author: '',
    digest: '',
    content: '<p>x</p>',
    thumbMediaId,
    needOpenComment: true,
    onlyFansCanComment: false,
  })
  const receipt = (id: number, info: Record<string, unknown>) =>
    ctx.app.get(WxoaInboundHub).emit({
      id,
      accountId: account.id,
      tenantId: 1,
      openId: 'mphelper',
      msgKind: 'event',
      eventKind: 'PUBLISHJOBFINISH',
      eventKey: null,
      wxMsgId: null,
      payload: { PublishEventInfo: info },
      occurredAt: new Date(),
    })

  beforeAll(async () => {
    ctx = await openContentApp()
    account = await addAccount(ctx)
    other = await addAccount(ctx)
    ids.push(account.id, other.id)
    for (const [accountId, mediaId] of [
      [account.id, 'pub-cover'],
      [other.id, 'pub-foreign-cover'],
    ] as const)
      await ctx.ds.query(
        "INSERT INTO wxoa_material (tenant_id, account_id, media_kind, media_id, origin) VALUES (1, ?, 'image', ?, 'local')",
        [accountId, mediaId],
      )
    ctx.fake.on('/cgi-bin/draft/add', { media_id: 'pub-media' }, { media_id: 'pub-foreign-media' })
    const make = async (accountId: number, cover: string) => {
      const draft = await http()
        .post('/api/wxoa/drafts')
        .set(bearer(ctx.admin))
        .send({ accountId, articles: [article(cover)] })
        .expect(201)
      await http()
        .post(`/api/wxoa/drafts/${draft.body.data.id}/sync`)
        .set(bearer(ctx.admin))
        .expect(201)
      return Number(draft.body.data.id)
    }
    draftId = await make(account.id, 'pub-cover')
    foreignDraftId = await make(other.id, 'pub-foreign-cover')
  })
  afterAll(async () => closeContentApp(ctx, ids))

  it('submits a synced draft, settles receipts and shows whitelisted, sanitized articles', async () => {
    ctx.fake.reset()
    ctx.fake.on('/cgi-bin/freepublish/submit', { errcode: 0, publish_id: 100000001 })
    const res = await http()
      .post('/api/wxoa/publishes')
      .set(bearer(ctx.admin))
      .send({ accountId: account.id, draftId })
      .expect(201)
    expect(res.body.data.publishId).toBe('100000001')
    await receipt(9001, {
      publish_id: '100000001',
      publish_status: '0',
      article_id: 'article-1',
      article_detail: {
        count: '2',
        item: [
          { idx: '1', article_url: 'https://mp.weixin.qq.com/s/a1' },
          { idx: '2', article_url: 'https://mp.weixin.qq.com/s/a2' },
          // 只保留 http(s) 链接
          { idx: '3', article_url: 'javascript:alert(1)' },
        ],
      },
    })
    // getarticle 一次返回全部篇，按 10 MiB 上限读取；约 2 MiB 的正文清洗后照常显示
    const big = `<p onclick="x()" style="${'color:red;'.repeat(220_000)}">big</p><script>bad()</script>`
    ctx.fake.on('/cgi-bin/freepublish/getarticle', {
      news_item: [
        {
          title: 'T',
          author: 'A',
          digest: 'D',
          content: big,
          content_source_url: 'https://example.com',
          thumb_media_id: 'thumb',
          thumb_url: 'http://mmbiz.qpic.cn/thumb',
          need_open_comment: 0,
          only_fans_can_comment: 0,
          url: 'https://mp.weixin.qq.com/s/a1',
          is_deleted: false,
          internal: 'never forwarded',
        },
        {
          title: 'Odd links',
          content: '<p>x</p>',
          content_source_url: 'javascript:alert(1)',
          url: 'data:text/html,x',
          is_deleted: false,
        },
      ],
    })
    const detail = await http()
      .get(`/api/wxoa/publishes/${res.body.data.id}`)
      .set(bearer(ctx.admin))
      .expect(200)
    expect(ctx.fake.callsTo('/cgi-bin/freepublish/getarticle')[0]?.maxBytes).toBeGreaterThanOrEqual(
      2 * 1024 * 1024,
    )
    expect(detail.body.data).toMatchObject({
      publishState: 'succeeded',
      articleId: 'article-1',
      articleUrls: ['https://mp.weixin.qq.com/s/a1', 'https://mp.weixin.qq.com/s/a2'],
      failIdx: null,
      articles: [
        {
          title: 'T',
          author: 'A',
          digest: 'D',
          content: '<p>big</p>',
          contentSourceUrl: 'https://example.com',
          thumbUrl: 'https://mmbiz.qpic.cn/thumb',
          url: 'https://mp.weixin.qq.com/s/a1',
          isDeleted: false,
        },
        { title: 'Odd links', contentSourceUrl: null, url: null },
      ],
    })
    expect(JSON.stringify(detail.body.data)).not.toContain('never forwarded')

    const failed = await ctx.ds.query(
      `INSERT INTO wxoa_publish (tenant_id, account_id, draft_id, publish_id, article_id, title, publish_state)
       VALUES (1, ?, NULL, 'pub-failed', NULL, 'Failed', 'publishing')`,
      [account.id],
    )
    await receipt(9002, { publish_id: 'pub-failed', publish_status: '2', fail_idx: ['2'] })
    const failedReceipt = await http()
      .get(`/api/wxoa/publishes/${failed.insertId}`)
      .set(bearer(ctx.admin))
      .expect(200)
    expect(failedReceipt.body.data).toMatchObject({
      publishState: 'failed',
      failIdx: [2],
      articleUrls: null,
      articles: null,
    })
  })

  it('looks up publishes stuck in publishing for over two minutes once when the list opens', async () => {
    ctx.fake.reset()
    const stale = await ctx.ds.query(
      `INSERT INTO wxoa_publish (tenant_id, account_id, publish_id, title, publish_state, created_at)
       VALUES (1, ?, '100000009', 'Stale', 'publishing', NOW(3) - INTERVAL 5 MINUTE)`,
      [account.id],
    )
    await ctx.ds.query(
      `INSERT INTO wxoa_publish (tenant_id, account_id, publish_id, title, publish_state)
       VALUES (1, ?, '100000010', 'Fresh', 'publishing')`,
      [account.id],
    )
    ctx.fake.on('/cgi-bin/freepublish/get', {
      publish_id: '100000009',
      publish_status: 0,
      article_id: 'article-stale',
      article_detail: {
        count: 1,
        item: [{ idx: 1, article_url: 'https://mp.weixin.qq.com/s/st' }],
      },
      fail_idx: [],
    })
    const page = await http()
      .get('/api/wxoa/publishes')
      .query({ accountId: account.id, pageSize: 100 })
      .set(bearer(ctx.admin))
      .expect(200)
    expect(ctx.fake.callsTo('/cgi-bin/freepublish/get').map((c) => c.body)).toEqual([
      { publish_id: '100000009' },
    ])
    const row = page.body.data.items.find((r: { id: number }) => r.id === Number(stale.insertId))
    expect(row).toMatchObject({
      publishState: 'succeeded',
      articleId: 'article-stale',
      articleUrls: ['https://mp.weixin.qq.com/s/st'],
    })
    expect(
      page.body.data.items.every((r: { accountId: number }) => r.accountId === account.id),
    ).toBe(true)
  })

  it('pulls every page without content and reads titles and links from the first article', async () => {
    ctx.fake.reset()
    const item = (i: number) => ({
      article_id: `pulled-${i}`,
      content: {
        news_item: [
          { title: `Pulled ${i}`, url: `https://mp.weixin.qq.com/s/p${i}`, is_deleted: false },
          // 不是 http(s) 的链接不入库
          { title: 'Second', url: 'javascript:alert(1)', is_deleted: false },
        ],
      },
      update_time: 1627891234,
    })
    ctx.fake.on(
      '/cgi-bin/freepublish/batchget',
      { total_count: 21, item_count: 20, item: Array.from({ length: 20 }, (_, i) => item(i)) },
      { total_count: 21, item_count: 1, item: [item(20)] },
    )
    const pull = await http()
      .post('/api/wxoa/publishes/pull')
      .set(bearer(ctx.admin))
      .send({ accountId: account.id })
      .expect(201)
    expect(ctx.fake.callsTo('/cgi-bin/freepublish/batchget').map((c) => c.body)).toEqual([
      { offset: 0, count: 20, no_content: 1 },
      { offset: 20, count: 20, no_content: 1 },
    ])
    expect(pull.body.data.items).toHaveLength(21)
    expect(pull.body.data.items[20]).toMatchObject({
      articleId: 'pulled-20',
      title: 'Pulled 20',
      articleUrls: ['https://mp.weixin.qq.com/s/p20'],
      publishState: 'succeeded',
    })
  })

  it('rejects unsynchronised changes, a draft of another account and a missing draft', async () => {
    await new Promise((resolve) => setTimeout(resolve, 3100))
    await http()
      .put(`/api/wxoa/drafts/${draftId}`)
      .set(bearer(ctx.admin))
      .send({ articles: [{ ...article('pub-cover'), title: 'changed' }] })
      .expect(200)
    const res = await http()
      .post('/api/wxoa/publishes')
      .set(bearer(ctx.admin))
      .send({ accountId: account.id, draftId })
      .expect(409)
    expect(res.body.code).toBe(Err.WXOA_DRAFT_UNSYNCED.code)
    await http()
      .post('/api/wxoa/publishes')
      .set(bearer(ctx.admin))
      .send({ accountId: account.id, draftId: foreignDraftId })
      .expect(404)
    await http()
      .post('/api/wxoa/publishes')
      .set(bearer(ctx.admin))
      .send({ accountId: account.id, draftId: 999999999 })
      .expect(404)
    await http()
      .post('/api/wxoa/publishes')
      .set(bearer(ctx.admin))
      .send({ accountId: account.id })
      .expect(400)
  })
})
