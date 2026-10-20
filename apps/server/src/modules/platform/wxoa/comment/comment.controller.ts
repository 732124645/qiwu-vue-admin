import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common'
import {
  type WxoaCommentOpen,
  type WxoaCommentQuery,
  type WxoaCommentReply,
  wxoaCommentElect,
  wxoaCommentOpen,
  wxoaCommentQuery,
  wxoaCommentReply,
  wxoaCommentVo,
  wxoaPerms,
  pageVo,
} from '@qiwu/shared'
import { ActionLog } from '../../../../core/audit/action-log.js'
import { RequirePerm } from '../../../../core/auth/decorators.js'
import { Sensitive } from '../../../../core/redact.js'
import { Idempotent } from '../../../../core/guard/idempotent.js'
import { ApiEnvelope } from '../../../../core/http/api-envelope.decorator.js'
import { parseOr400 } from '../../../../core/http/validation.pipe.js'
import { ApiWxoa } from '../core/wxoa-swagger.js'
import { WxoaCommentService } from './comment.service.js'

/** 路径里的留言 id 是微信的十进制数字 id，格式不对回 400。 */
const commentIdOf = (commentId: string) => parseOr400(wxoaCommentElect.shape.commentId, commentId)

// 草稿正文与留言内容不进操作日志和接口日志
@Sensitive('content')
@ApiWxoa()
@Controller('wxoa/comments')
export class WxoaCommentController {
  constructor(private readonly service: WxoaCommentService) {}
  @Get() @RequirePerm(wxoaPerms.comment.browse) @ApiEnvelope(pageVo(wxoaCommentVo)) list(
    @Query({ schema: wxoaCommentQuery }) q: WxoaCommentQuery,
  ) {
    return this.service.list(q)
  }
  @Post('open')
  @RequirePerm(wxoaPerms.comment.modify)
  @ActionLog({ domain: 'wxoa.comment', verb: 'modify' })
  @ApiEnvelope()
  open(@Body({ schema: wxoaCommentOpen }) dto: WxoaCommentOpen) {
    return this.service.open(dto)
  }
  @Post('close')
  @RequirePerm(wxoaPerms.comment.modify)
  @ActionLog({ domain: 'wxoa.comment', verb: 'modify' })
  @ApiEnvelope()
  close(@Body({ schema: wxoaCommentOpen }) dto: WxoaCommentOpen) {
    return this.service.close(dto)
  }
  @Post(':commentId/elect')
  @RequirePerm(wxoaPerms.comment.modify)
  @ActionLog({ domain: 'wxoa.comment', verb: 'modify' })
  @ApiEnvelope()
  elect(
    @Param('commentId') commentId: string,
    @Body({ schema: wxoaCommentOpen }) dto: WxoaCommentOpen,
  ) {
    return this.service.elect({ ...dto, commentId: commentIdOf(commentId) })
  }
  @Delete(':commentId/elect')
  @RequirePerm(wxoaPerms.comment.modify)
  @ActionLog({ domain: 'wxoa.comment', verb: 'modify' })
  @ApiEnvelope()
  unelect(
    @Param('commentId') commentId: string,
    @Body({ schema: wxoaCommentOpen }) dto: WxoaCommentOpen,
  ) {
    return this.service.unelect({ ...dto, commentId: commentIdOf(commentId) })
  }
  @Delete(':commentId')
  @RequirePerm(wxoaPerms.comment.remove)
  @ActionLog({ domain: 'wxoa.comment', verb: 'remove' })
  @ApiEnvelope()
  remove(
    @Param('commentId') commentId: string,
    @Body({ schema: wxoaCommentOpen }) dto: WxoaCommentOpen,
  ) {
    return this.service.remove({ ...dto, commentId: commentIdOf(commentId) })
  }
  @Post(':commentId/reply')
  @RequirePerm(wxoaPerms.comment.send)
  @Idempotent()
  @ActionLog({ domain: 'wxoa.comment', verb: 'send' })
  @ApiEnvelope()
  reply(
    @Param('commentId') commentId: string,
    @Body({ schema: wxoaCommentReply.omit({ commentId: true }) })
    dto: Omit<WxoaCommentReply, 'commentId'>,
  ) {
    return this.service.reply({ ...dto, commentId: commentIdOf(commentId) })
  }
  @Delete(':commentId/reply')
  @RequirePerm(wxoaPerms.comment.remove)
  @ActionLog({ domain: 'wxoa.comment', verb: 'remove' })
  @ApiEnvelope()
  deleteReply(
    @Param('commentId') commentId: string,
    @Body({ schema: wxoaCommentOpen }) dto: WxoaCommentOpen,
  ) {
    return this.service.deleteReply({ ...dto, commentId: commentIdOf(commentId) })
  }
}
