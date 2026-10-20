import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { bearer } from '../setup/auth.js'
import {
  addAccount,
  addContentUser,
  closeContentApp,
  openContentApp,
} from './wxoa-content.helpers.js'

describe('wxoa comments', () => {
  let ctx: Awaited<ReturnType<typeof openContentApp>>
  const ids: number[] = []
  const roleIds: number[] = []
  const userIds: number[] = []
  let account: { id: number }
  let other: { id: number }
  let plainToken = ''
  const http = () => request(ctx.app.getHttpServer())
  const article = () => ({ accountId: account.id, msgDataId: '2247490098', index: 0 })

  beforeAll(async () => {
    ctx = await openContentApp()
    account = await addAccount(ctx)
    ids.push(account.id)
    other = await addAccount(ctx)
    ids.push(other.id)
    // 没有留言权限的真实会话，确保覆盖的是守卫而不是假 token
    const plain = await addContentUser(ctx, [])
    plainToken = plain.accessToken
    userIds.push(plain.userId)
    roleIds.push(plain.roleId)
  })
  afterAll(async () => closeContentApp(ctx, ids, userIds, roleIds))

  it('lists all and elected comments with numeric upstream ids and whitelisted fields', async () => {
    ctx.fake.reset()
    // 官方示例：user_comment_id、create_time、comment_type 都是数字
    ctx.fake.on('/cgi-bin/comment/list', {
      errcode: 0,
      total: 2,
      comment: [
        {
          user_comment_id: 1001,
          openid: 'open-1',
          create_time: 1610969440,
          content: 'hello',
          comment_type: 0,
        },
        {
          user_comment_id: 1002,
          create_time: 1610969441,
          content: 'selected',
          comment_type: 1,
          reply: { content: 'old reply', create_time: 1610969500, extra: 'dropped' },
        },
      ],
    })
    const list = await http()
      .get('/api/wxoa/comments')
      .set(bearer(ctx.admin))
      .query({ ...article(), type: 'all', page: 1, pageSize: 20 })
      .expect(200)
    expect(ctx.fake.callsTo('/cgi-bin/comment/list')[0]?.body).toEqual({
      msg_data_id: 2247490098,
      index: 0,
      begin: 0,
      count: 20,
      type: 0,
    })
    expect(list.body.data).toEqual({
      total: 2,
      items: [
        {
          userCommentId: '1001',
          openId: 'open-1',
          createTime: '1610969440',
          content: 'hello',
          isElect: false,
          reply: null,
        },
        {
          userCommentId: '1002',
          openId: null,
          createTime: '1610969441',
          content: 'selected',
          isElect: true,
          reply: { content: 'old reply', createTime: '1610969500' },
        },
      ],
    })
    await http()
      .get('/api/wxoa/comments')
      .set(bearer(ctx.admin))
      .query({ ...article(), index: 2, type: 'elect', page: 3, pageSize: 49 })
      .expect(200)
    // 官方 type：0 全部、1 普通、2 精选；count 达到 50 会被拒绝
    expect(ctx.fake.callsTo('/cgi-bin/comment/list')[1]?.body).toEqual({
      msg_data_id: 2247490098,
      index: 2,
      begin: 98,
      count: 49,
      type: 2,
    })
  })

  it('opens and closes comments and moderates by the listed comment id without forwarding upstream answers', async () => {
    ctx.fake.reset()
    for (const path of [
      '/cgi-bin/comment/open',
      '/cgi-bin/comment/close',
      '/cgi-bin/comment/markelect',
      '/cgi-bin/comment/unmarkelect',
      '/cgi-bin/comment/reply/add',
      '/cgi-bin/comment/reply/delete',
      '/cgi-bin/comment/delete',
    ])
      ctx.fake.on(path, { errcode: 0, errmsg: 'ok', internal: 'never forwarded' })
    const opened = await http()
      .post('/api/wxoa/comments/open')
      .set(bearer(ctx.admin))
      .send(article())
      .expect(201)
    expect(opened.body.data).toBeNull()
    await http().post('/api/wxoa/comments/close').set(bearer(ctx.admin)).send(article()).expect(201)
    await http()
      .post('/api/wxoa/comments/1001/elect')
      .set(bearer(ctx.admin))
      .send(article())
      .expect(201)
    await http()
      .delete('/api/wxoa/comments/1001/elect')
      .set(bearer(ctx.admin))
      .send(article())
      .expect(200)
    const replied = await http()
      .post('/api/wxoa/comments/1001/reply')
      .set(bearer(ctx.admin))
      .send({ ...article(), content: 'reply' })
      .expect(201)
    expect(replied.body.data).toBeNull()
    // 同一回复 3 秒内重复提交被拦下，上游只收到一次
    await http()
      .post('/api/wxoa/comments/1001/reply')
      .set(bearer(ctx.admin))
      .send({ ...article(), content: 'reply' })
      .expect(429)
    await http()
      .delete('/api/wxoa/comments/1001/reply')
      .set(bearer(ctx.admin))
      .send(article())
      .expect(200)
    await http()
      .delete('/api/wxoa/comments/1001')
      .set(bearer(ctx.admin))
      .send(article())
      .expect(200)
    const located = { msg_data_id: 2247490098, index: 0 }
    expect(ctx.fake.calls.map((c) => [c.path, c.body, c.accountId])).toEqual([
      ['/cgi-bin/comment/open', located, account.id],
      ['/cgi-bin/comment/close', located, account.id],
      ['/cgi-bin/comment/markelect', { ...located, user_comment_id: 1001 }, account.id],
      ['/cgi-bin/comment/unmarkelect', { ...located, user_comment_id: 1001 }, account.id],
      [
        '/cgi-bin/comment/reply/add',
        { ...located, user_comment_id: 1001, content: 'reply' },
        account.id,
      ],
      ['/cgi-bin/comment/reply/delete', { ...located, user_comment_id: 1001 }, account.id],
      ['/cgi-bin/comment/delete', { ...located, user_comment_id: 1001 }, account.id],
    ])
  })

  it('enforces id formats, page and reply boundaries, permission and account isolation', async () => {
    ctx.fake.reset()
    await http()
      .get('/api/wxoa/comments')
      .set(bearer(ctx.admin))
      .query({ accountId: account.id })
      .expect(400)
    await http()
      .get('/api/wxoa/comments')
      .set(bearer(ctx.admin))
      .query({ ...article(), page: 1, pageSize: 50 })
      .expect(400)
    await http()
      .get('/api/wxoa/comments')
      .set(bearer(ctx.admin))
      .query({ ...article(), msgDataId: 'article-id-1', page: 1, pageSize: 20 })
      .expect(400)
    await http()
      .post('/api/wxoa/comments/not-a-number/elect')
      .set(bearer(ctx.admin))
      .send(article())
      .expect(400)
    await http()
      .post('/api/wxoa/comments/1001/reply')
      .set(bearer(ctx.admin))
      .send({ ...article(), content: 'x'.repeat(1001) })
      .expect(400)
    expect(ctx.fake.calls).toEqual([])
    ctx.fake.on('/cgi-bin/comment/list', { total: 0, comment: [] })
    await http()
      .get('/api/wxoa/comments')
      .set(bearer(ctx.admin))
      .query({ ...article(), accountId: other.id, page: 1, pageSize: 20 })
      .expect(200)
    expect(ctx.fake.callsTo('/cgi-bin/comment/list').at(-1)?.accountId).toBe(other.id)
    await http()
      .get('/api/wxoa/comments')
      .set(bearer(plainToken))
      .query({ ...article(), page: 1, pageSize: 20 })
      .expect(403)
    await http().post('/api/wxoa/comments/open').set(bearer(plainToken)).send(article()).expect(403)
    await http()
      .post('/api/wxoa/comments/1001/reply')
      .set(bearer(plainToken))
      .send({ ...article(), content: 'reply' })
      .expect(403)
    await http()
      .get('/api/wxoa/comments')
      .set(bearer(ctx.admin))
      .query({ ...article(), accountId: 999999999, page: 1, pageSize: 20 })
      .expect(404)
  })
})
