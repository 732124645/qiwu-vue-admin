import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  pageVo,
  type SessionKickBody,
  sessionKickBody,
  sessionKickVo,
  sessionPerms,
  type SessionQuery,
  sessionQuery,
  sessionVo,
} from '@qiwu/shared'
import { ActionLog } from '../../../../core/audit/action-log.js'
import { RequirePerm } from '../../../../core/auth/decorators.js'
import { ApiEnvelope } from '../../../../core/http/api-envelope.decorator.js'
import { SessionService } from './session.service.js'

@ApiTags('iam')
@Controller('iam/sessions')
export class SessionController {
  constructor(private readonly sessions: SessionService) {}

  @Get()
  @RequirePerm(sessionPerms.browse)
  @ApiOperation({ summary: 'Page of live sessions (tokens are never listed)' })
  @ApiEnvelope(pageVo(sessionVo))
  page(@Query({ schema: sessionQuery }) query: SessionQuery) {
    return this.sessions.list(query)
  }

  /** `{sids}`: those sessions (unknown/ended skipped); `{userId}`: every session of the user. */
  @Post('kick')
  @HttpCode(200)
  @RequirePerm(sessionPerms.kick)
  @ActionLog({
    domain: 'iam.session',
    verb: 'kick',
    bizId: (req) => {
      const b = req.body as Partial<SessionKickBody> | undefined
      return b?.userId ?? b?.sids?.join(',')
    },
  })
  @ApiOperation({ summary: 'End sessions: several by sid, or every session of a user' })
  @ApiEnvelope(sessionKickVo)
  async kick(@Body({ schema: sessionKickBody }) { sids, userId }: SessionKickBody) {
    return {
      kicked: sids ? await this.sessions.kick(sids) : await this.sessions.kickUser(userId!),
    }
  }

  @Delete(':sid')
  @RequirePerm(sessionPerms.kick)
  @ActionLog({ domain: 'iam.session', verb: 'kick', bizId: (req) => req.params.sid })
  @ApiOperation({ summary: 'End one session (404 when unknown or already ended)' })
  @ApiEnvelope(sessionKickVo)
  async kickOne(@Param('sid', ParseUUIDPipe) sid: string) {
    return { kicked: await this.sessions.kickOne(sid) }
  }
}
