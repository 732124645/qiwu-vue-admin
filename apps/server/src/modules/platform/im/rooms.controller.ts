import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  type ImDirectCreate,
  imDirectCreate,
  type ImGroupCreate,
  imGroupCreate,
  type ImLabelChange,
  imLabelChange,
  imMemberVo,
  type ImMembersAdd,
  imMembersAdd,
  type ImOwnerTransfer,
  imOwnerTransfer,
  imPathId,
  type ImReadBody,
  imReadBody,
  imReadVo,
  type ImRoleChange,
  imRoleChange,
  imRoomDetailVo,
} from '@qiwu/shared'
import { z } from 'zod'
import { SkipActionLog } from '../../../core/audit/action-log.js'
import { SkipHttpTrace } from '../../../core/audit/http-trace.js'
import { HomeTenant, RequireFeature } from '../../../core/auth/tenant-scope.js'
import { clsGet } from '../../../core/context/cls.js'
import { Idempotent } from '../../../core/guard/idempotent.js'
import { RateLimit } from '../../../core/guard/rate-limit.decorator.js'
import { ApiEnvelope } from '../../../core/http/api-envelope.decorator.js'
import { Sensitive } from '../../../core/redact.js'
import { ImStaffGuard } from './im-staff.guard.js'
import { RoomsService } from './rooms.service.js'

const me = () => clsGet('principal')!.userId

/**
 * 私聊、群与读位置（员工本人、本人租户；see docs/im.md）。写接口不记操作日志：会话里的系统事件就是持久记录。
 * 静态段（directs、groups）先于 `:id`。
 */
@ApiTags('im')
@Controller('im/rooms')
@HomeTenant()
@RequireFeature('im')
@UseGuards(ImStaffGuard)
@Sensitive('label')
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @Post('directs')
  @RateLimit(10, 60_000, 'user')
  @Idempotent()
  @SkipActionLog()
  @ApiOperation({ summary: 'Get or open the direct conversation with a staff member' })
  @ApiEnvelope(imRoomDetailVo, 201)
  openDirect(@Body({ schema: imDirectCreate }) { peerId }: ImDirectCreate) {
    return this.rooms.openDirect(peerId, me())
  }

  @Post('groups')
  @RateLimit(10, 60_000, 'user')
  @Idempotent()
  @SkipActionLog()
  @SkipHttpTrace()
  @ApiOperation({ summary: 'Create a group; the caller becomes its owner' })
  @ApiEnvelope(imRoomDetailVo, 201)
  createGroup(@Body({ schema: imGroupCreate }) body: ImGroupCreate) {
    return this.rooms.createGroup(body, me())
  }

  @Get(':id/members')
  @ApiOperation({ summary: 'Current members of a conversation' })
  @ApiEnvelope(z.array(imMemberVo))
  members(@Param('id', { schema: imPathId }) id: number) {
    return this.rooms.members(id, me())
  }

  @Post(':id/members')
  @HttpCode(200)
  @RateLimit(10, 60_000, 'user')
  @SkipActionLog()
  @ApiOperation({ summary: 'Add members to a group (owner or moderator)' })
  @ApiEnvelope(imRoomDetailVo)
  addMembers(
    @Param('id', { schema: imPathId }) id: number,
    @Body({ schema: imMembersAdd }) { userIds }: ImMembersAdd,
  ) {
    return this.rooms.addMembers(id, userIds, me())
  }

  @Delete(':id/members/:userId')
  @SkipActionLog()
  @ApiOperation({ summary: 'Remove a member from a group' })
  @ApiEnvelope(imRoomDetailVo)
  removeMember(
    @Param('id', { schema: imPathId }) id: number,
    @Param('userId', { schema: imPathId }) userId: number,
  ) {
    return this.rooms.removeMember(id, userId, me())
  }

  @Post(':id/leave')
  @HttpCode(200)
  @SkipActionLog()
  @ApiOperation({ summary: 'Leave a group (an owner with other members transfers first)' })
  @ApiEnvelope()
  leave(@Param('id', { schema: imPathId }) id: number) {
    return this.rooms.leave(id, me())
  }

  @Put(':id/owner')
  @SkipActionLog()
  @ApiOperation({ summary: 'Transfer the group ownership' })
  @ApiEnvelope(imRoomDetailVo)
  transferOwner(
    @Param('id', { schema: imPathId }) id: number,
    @Body({ schema: imOwnerTransfer }) { userId }: ImOwnerTransfer,
  ) {
    return this.rooms.transferOwner(id, userId, me())
  }

  @Put(':id/members/:userId/role')
  @SkipActionLog()
  @ApiOperation({ summary: 'Make a member moderator or participant (owner only)' })
  @ApiEnvelope(imRoomDetailVo)
  setRole(
    @Param('id', { schema: imPathId }) id: number,
    @Param('userId', { schema: imPathId }) userId: number,
    @Body({ schema: imRoleChange }) body: ImRoleChange,
  ) {
    return this.rooms.setRole(id, userId, body, me())
  }

  @Put(':id/label')
  @SkipActionLog()
  @SkipHttpTrace()
  @ApiOperation({ summary: 'Rename a group (owner or moderator)' })
  @ApiEnvelope(imRoomDetailVo)
  rename(
    @Param('id', { schema: imPathId }) id: number,
    @Body({ schema: imLabelChange }) body: ImLabelChange,
  ) {
    return this.rooms.rename(id, body, me())
  }

  @Post(':id/close')
  @HttpCode(200)
  @SkipActionLog()
  @ApiOperation({ summary: 'Dissolve a group (owner only); history stays readable' })
  @ApiEnvelope(imRoomDetailVo)
  close(@Param('id', { schema: imPathId }) id: number) {
    return this.rooms.close(id, me())
  }

  @Put(':id/read')
  @SkipActionLog()
  @ApiOperation({ summary: 'Move the own read position forward (never back, never past the last)' })
  @ApiEnvelope(imReadVo)
  read(
    @Param('id', { schema: imPathId }) id: number,
    @Body({ schema: imReadBody }) { seq }: ImReadBody,
  ) {
    return this.rooms.read(id, seq, me())
  }
}
