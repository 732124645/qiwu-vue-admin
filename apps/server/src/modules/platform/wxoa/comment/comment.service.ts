import { Injectable } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  type WxoaCommentElect,
  type WxoaCommentOpen,
  type WxoaCommentQuery,
  type WxoaCommentReply,
} from '@qiwu/shared'
import { WxoaGateway, type WxoaJson } from '../core/wxoa-gateway.js'
import { jsonObject, textOf, activeAccount, wxNumber } from '../core/wxoa-util.js'

/**
 * 留言管理：不落库，直接读写微信的 comment 接口。msg_data_id、user_comment_id 按官方要求以数字发送，
 * 写操作只回 null，不把上游应答透传给前端。
 */
@Injectable()
export class WxoaCommentService {
  constructor(
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly gateway: WxoaGateway,
  ) {}
  /** 一页留言：type=0 全部、type=2 精选（官方 1 是只看普通留言，不用）；每页 < 50 条。 */
  async list(q: WxoaCommentQuery) {
    const account = await activeAccount(this.txHost, q.accountId)
    const answer = await this.gateway.json(account, '/cgi-bin/comment/list', {
      body: {
        msg_data_id: wxNumber(q.msgDataId),
        index: q.index,
        begin: (q.page - 1) * q.pageSize,
        count: q.pageSize,
        type: q.type === 'elect' ? 2 : 0,
      },
    })
    const list = Array.isArray(answer.comment) ? answer.comment.map(jsonObject) : []
    return { items: list.map(commentVo), total: Number(textOf(answer.total)) || list.length }
  }
  /** 打开文章留言。 */
  async open(dto: WxoaCommentOpen) {
    await this.call(dto, '/cgi-bin/comment/open')
  }
  /** 关闭文章留言。 */
  async close(dto: WxoaCommentOpen) {
    await this.call(dto, '/cgi-bin/comment/close')
  }
  /** 将留言标为精选。 */
  async elect(dto: WxoaCommentElect) {
    await this.call(dto, '/cgi-bin/comment/markelect', dto.commentId)
  }
  /** 取消精选。 */
  async unelect(dto: WxoaCommentElect) {
    await this.call(dto, '/cgi-bin/comment/unmarkelect', dto.commentId)
  }
  /** 删除留言。 */
  async remove(dto: WxoaCommentElect) {
    await this.call(dto, '/cgi-bin/comment/delete', dto.commentId)
  }
  /** 回复留言（纯文本内容）。 */
  async reply(dto: WxoaCommentReply) {
    await this.call(dto, '/cgi-bin/comment/reply/add', dto.commentId, { content: dto.content })
  }
  /** 删除回复。 */
  async deleteReply(dto: WxoaCommentElect) {
    await this.call(dto, '/cgi-bin/comment/reply/delete', dto.commentId)
  }

  /** 校验账号后调用一个留言写接口，请求体是文章定位（加留言 id 与附加字段）。 */
  private async call(
    dto: WxoaCommentOpen,
    path: string,
    commentId?: string,
    extra: WxoaJson = {},
  ): Promise<void> {
    const account = await activeAccount(this.txHost, dto.accountId)
    await this.gateway.json(account, path, {
      body: {
        msg_data_id: wxNumber(dto.msgDataId),
        index: dto.index,
        ...(commentId === undefined ? {} : { user_comment_id: wxNumber(commentId) }),
        ...extra,
      },
    })
  }
}

/** 上游留言 → 接口视图：编号与时间（数字）转成字符串，精选取 comment_type，回复只留内容与时间。 */
const commentVo = (r: WxoaJson) => {
  const reply = jsonObject(r.reply)
  return {
    userCommentId: textOf(r.user_comment_id),
    openId: textOf(r.openid) || null,
    createTime: textOf(r.create_time) || null,
    content: textOf(r.content),
    isElect: Number(textOf(r.comment_type)) === 1,
    reply: textOf(reply.content)
      ? { content: textOf(reply.content), createTime: textOf(reply.create_time) || null }
      : null,
  }
}
