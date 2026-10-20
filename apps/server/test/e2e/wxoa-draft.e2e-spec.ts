import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { Err, WXOA_CONTENT_MAX } from '@qiwu/shared'
import { sanitizeRichText } from '../../src/core/sanitize.js'
import { bearer } from '../setup/auth.js'
import { addAccount, closeContentApp, openContentApp } from './wxoa-content.helpers.js'

describe('wxoa drafts', () => {
  let ctx: Awaited<ReturnType<typeof openContentApp>>
  const ids: number[] = []
  let account: { id: number }
  let other: { id: number }
  const http = () => request(ctx.app.getHttpServer())
  const article = {
    title: 'Draft one',
    author: 'Qiwu',
    digest: '摘要',
    content: '<p>正文</p>',
    contentSourceUrl: 'https://example.com/source',
    thumbMediaId: 'draft-cover',
    needOpenComment: false,
    onlyFansCanComment: true,
  }
  const create = (articles: Record<string, unknown>[], accountId = account.id) =>
    http().post('/api/wxoa/drafts').set(bearer(ctx.admin)).send({ accountId, articles })

  beforeAll(async () => {
    ctx = await openContentApp()
    account = await addAccount(ctx)
    other = await addAccount(ctx)
    ids.push(account.id, other.id)
    for (const [accountId, kind, mediaId] of [
      [account.id, 'image', 'draft-cover'],
      [account.id, 'video', 'draft-video'],
      [other.id, 'image', 'foreign-cover'],
    ] as const)
      await ctx.ds.query(
        "INSERT INTO wxoa_material (tenant_id, account_id, media_kind, media_id, origin) VALUES (1, ?, ?, ?, 'local')",
        [accountId, kind, mediaId],
      )
  })
  afterAll(async () => closeContentApp(ctx, ids))

  it('creates, syncs in the draft-box format, tracks dirty and replaces the old upstream copy', async () => {
    ctx.fake.reset()
    const created = await create([article]).expect(201)
    const id = Number(created.body.data.id)
    expect(created.body.data.dirty).toBe(true)
    ctx.fake.on('/cgi-bin/draft/add', { media_id: 'draft-media-1' }, { media_id: 'draft-media-2' })
    ctx.fake.on('/cgi-bin/draft/delete', { errcode: 0 })
    const sync = await http().post(`/api/wxoa/drafts/${id}/sync`).set(bearer(ctx.admin)).expect(201)
    expect(sync.body.data.draft).toMatchObject({ mediaId: 'draft-media-1', dirty: false })
    expect(ctx.fake.callsTo('/cgi-bin/draft/add')[0]?.body).toEqual({
      articles: [
        {
          article_type: 'news',
          title: 'Draft one',
          author: 'Qiwu',
          digest: '摘要',
          content: '<p>正文</p>',
          content_source_url: 'https://example.com/source',
          thumb_media_id: 'draft-cover',
          need_open_comment: 0,
          only_fans_can_comment: 1,
        },
      ],
    })
    const changed = await http()
      .put(`/api/wxoa/drafts/${id}`)
      .set(bearer(ctx.admin))
      .send({ articles: [{ ...article, title: 'Draft changed' }] })
      .expect(200)
    expect(changed.body.data.dirty).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 3100))
    const resync = await http()
      .post(`/api/wxoa/drafts/${id}/sync`)
      .set(bearer(ctx.admin))
      .expect(201)
    expect(resync.body.data.draft).toMatchObject({ mediaId: 'draft-media-2', dirty: false })
    expect(ctx.fake.callsTo('/cgi-bin/draft/delete').map((c) => c.body)).toEqual([
      { media_id: 'draft-media-1' },
    ])
  })

  it('lists only the queried account and searches by title', async () => {
    await create(
      [{ ...article, title: 'Foreign draft', thumbMediaId: 'foreign-cover' }],
      other.id,
    ).expect(201)
    await create([{ ...article, title: 'Needle title' }]).expect(201)
    const all = await http()
      .get('/api/wxoa/drafts')
      .query({ accountId: account.id, pageSize: 100 })
      .set(bearer(ctx.admin))
      .expect(200)
    expect(all.body.data.items.length).toBeGreaterThan(0)
    expect(
      all.body.data.items.every((d: { accountId: number }) => d.accountId === account.id),
    ).toBe(true)
    expect(all.body.data.items.every((d: { dirty: unknown }) => typeof d.dirty === 'boolean')).toBe(
      true,
    )
    const found = await http()
      .get('/api/wxoa/drafts')
      .query({ accountId: account.id, title: 'Needle' })
      .set(bearer(ctx.admin))
      .expect(200)
    expect(found.body.data.items.map((d: { title: string }) => d.title)).toEqual(['Needle title'])
  })

  it('rejects foreign and unusable covers, unsafe links, an accountId on update and over-long rewritten bodies', async () => {
    ctx.fake.reset()
    // 别的账号的封面素材：创建与修改都 404（不是 B6102）
    await create([{ ...article, thumbMediaId: 'foreign-cover' }]).expect(404)
    const own = await create([article]).expect(201)
    await http()
      .put(`/api/wxoa/drafts/${own.body.data.id}`)
      .set(bearer(ctx.admin))
      .send({ articles: [{ ...article, thumbMediaId: 'foreign-cover' }] })
      .expect(404)
    const unusable = await create([{ ...article, thumbMediaId: 'draft-video' }]).expect(422)
    expect(unusable.body.code).toBe(Err.WXOA_COVER_UNAVAILABLE.code)
    await create([{ ...article, contentSourceUrl: 'javascript:alert(1)' }]).expect(400)
    await http()
      .put(`/api/wxoa/drafts/${own.body.data.id}`)
      .set(bearer(ctx.admin))
      .send({ accountId: other.id, articles: [article] })
      .expect(400)

    // 清洗后正好 20000 字符；同步时 mmbiz 图片 http 改 https 多出 1 个字符 → 400，不推送
    const image = '<img src="http://mmbiz.qpic.cn/a" />'
    const fill = WXOA_CONTENT_MAX - sanitizeRichText(`<p></p>${image}`).length
    const content = `<p>${'x'.repeat(fill)}</p>${image}`
    expect(sanitizeRichText(content).length).toBe(WXOA_CONTENT_MAX)
    const edge = await create([{ ...article, content }]).expect(201)
    const tooLong = await http()
      .post(`/api/wxoa/drafts/${edge.body.data.id}/sync`)
      .set(bearer(ctx.admin))
      .expect(400)
    expect(tooLong.body.errors[0].path).toBe('articles.0.content')
    expect(ctx.fake.callsTo('/cgi-bin/draft/add')).toHaveLength(0)
    await http().get('/api/wxoa/drafts/999999999').set(bearer(ctx.admin)).expect(404)
    await create([]).expect(400)
  })

  it('pulls every page without content, stores large answers that sanitize short and lists the ones it could not pull', async () => {
    ctx.fake.reset()
    const page1 = Array.from({ length: 20 }, (_, i) => ({
      media_id: `pull-${i}`,
      content: { news_item: [{ title: `Pulled ${i}` }] },
      update_time: 1700000000,
    }))
    ctx.fake.on(
      '/cgi-bin/draft/batchget',
      { total_count: 22, item_count: 20, item: page1 },
      {
        total_count: 22,
        item_count: 2,
        item: [
          { media_id: 'pull-big', content: { news_item: [{ title: 'Big but clean' }] } },
          { media_id: 'pull-long', content: { news_item: [{ title: 'Too long' }] } },
        ],
      },
    )
    // 约 2 MiB 的单条应答：行内样式在清洗时去掉，清洗后不超长
    const styled = `<p style="${'color:red;'.repeat(220_000)}">big</p>`
    ctx.fake.on('/cgi-bin/draft/get', (call) => {
      const mid = (call.body as { media_id: string }).media_id
      const news = (title: string, content: string) => ({
        news_item: [
          {
            article_type: 'news',
            title,
            author: 'A',
            digest: '',
            content,
            content_source_url: '',
            thumb_media_id: 'upstream-thumb',
            need_open_comment: 1,
            only_fans_can_comment: 0,
            url: 'https://mp.weixin.qq.com/s/x',
          },
        ],
      })
      if (mid === 'pull-big') return news('Big but clean', styled)
      if (mid === 'pull-long') return news('Too long', `<p>${'y'.repeat(WXOA_CONTENT_MAX + 1)}</p>`)
      return news(`Pulled ${mid}`, '<p>pulled</p>')
    })
    expect(Buffer.byteLength(styled)).toBeGreaterThan(2 * 1024 * 1024)
    const pulled = await http()
      .post('/api/wxoa/drafts/pull')
      .set(bearer(ctx.admin))
      .send({ accountId: account.id })
      .expect(201)
    expect(ctx.fake.callsTo('/cgi-bin/draft/batchget').map((c) => c.body)).toEqual([
      { offset: 0, count: 20, no_content: 1 },
      { offset: 20, count: 20, no_content: 1 },
    ])
    expect(
      ctx.fake.callsTo('/cgi-bin/draft/get').every((c) => (c.maxBytes ?? 0) >= 2 * 1024 * 1024),
    ).toBe(true)
    expect(pulled.body.data.items).toHaveLength(21)
    expect(pulled.body.data.failed).toEqual([
      { mediaId: 'pull-long', title: 'Too long', reason: 'too_long' },
    ])
    const big = pulled.body.data.items.find((d: { mediaId: string }) => d.mediaId === 'pull-big')
    expect(big).toMatchObject({ title: 'Big but clean', origin: 'pulled', dirty: false })
    expect(big.articles[0]).toMatchObject({
      content: '<p>big</p>',
      needOpenComment: true,
      onlyFansCanComment: false,
    })

    // 本地改过的已拉取草稿再拉一次：内容覆盖并刷新同步摘要，不再显示未同步
    await new Promise((resolve) => setTimeout(resolve, 3100))
    await http()
      .put(`/api/wxoa/drafts/${big.id}`)
      .set(bearer(ctx.admin))
      .send({ articles: [{ ...article, title: 'Edited locally' }] })
      .expect(200)
    ctx.fake.on('/cgi-bin/draft/batchget', {
      total_count: 1,
      item_count: 1,
      item: [{ media_id: 'pull-big', content: { news_item: [{ title: 'Big but clean' }] } }],
    })
    const again = await http()
      .post('/api/wxoa/drafts/pull')
      .set(bearer(ctx.admin))
      .send({ accountId: account.id })
      .expect(201)
    expect(again.body.data.items).toEqual([
      expect.objectContaining({ id: big.id, title: 'Big but clean', dirty: false }),
    ])
  })
})
