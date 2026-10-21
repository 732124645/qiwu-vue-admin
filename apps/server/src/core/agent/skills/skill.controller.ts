import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  AGENT_SKILL_NAME,
  AGENT_TONES,
  type AgentInstructionSave,
  agentInstructionSave,
  agentPerms,
  type AgentSkillImport,
  agentSkillImport,
  type AgentSkillSave,
  agentSkillSave,
  agentSkillVo,
  Err,
  fieldDomains,
} from '@qiwu/shared'
import { z } from 'zod'
import { ActionLog } from '../../audit/action-log.js'
import { RequirePerm } from '../../auth/decorators.js'
import { PlatformOnly } from '../../auth/platform-only.js'
import { clsGet } from '../../context/cls.js'
import { Idempotent } from '../../guard/idempotent.js'
import { ApiEnvelope } from '../../http/api-envelope.decorator.js'
import { BizError } from '../../http/biz-error.js'
import { AgentInstructionService } from './instruction.service.js'
import { AgentPlatformSkillService, AgentSkillService } from './skill.service.js'
import { AgentRootOnly } from '../tools/root-only.js'

const { chat, skill, instruction, setting } = agentPerms
const createdId = (_req: unknown, r: unknown) => (r as { id?: number } | undefined)?.id

/** 已登录的调用者（这些路由都在 AuthGuard 之后）。 */
function me() {
  const p = clsGet('principal')
  if (!p) throw new BizError(Err.UNAUTHENTICATED)
  return p
}

/** `POST /api/agent/skills/from-thread/:id` 的请求体：名称与描述可由用户先给，其余由模型起草。 */
const skillFromThread = z
  .object({
    name: z.string().trim().regex(AGENT_SKILL_NAME).optional(),
    description: z.string().trim().min(1).max(512).optional(),
  })
  .register(fieldDomains, { domain: 'agent.skill' })

const personalInstructionVo = z.object({ body: z.string(), tone: z.enum(AGENT_TONES) })
const tenantInstructionVo = z.object({ body: z.string() })

/**
 * 技能页与输入框的技能（see docs/agent.md）：个人技能本人即可增删改（`agent.chat.use`），全租户技能需
 * `agent.skill.create` / `modify` / `remove`（服务里按范围再判断）；别人的个人技能与别的租户的一律 404。
 */
@ApiTags('agent')
@Controller('agent/skills')
export class AgentSkillController {
  constructor(private readonly skills: AgentSkillService) {}

  @Get()
  @RequirePerm(chat.use, skill.browse)
  @ApiOperation({ summary: 'Skills the caller sees: own, tenant-wide and enabled platform ones' })
  @ApiEnvelope(z.array(agentSkillVo))
  list() {
    return this.skills.list(me())
  }

  @Post()
  @RequirePerm(chat.use, skill.create)
  @Idempotent()
  @ActionLog({ domain: 'agent.skill', verb: 'create', bizId: createdId })
  @ApiOperation({ summary: 'Add an own skill, or a tenant-wide one (agent.skill.create)' })
  @ApiEnvelope(agentSkillVo, 201)
  create(@Body({ schema: agentSkillSave }) dto: AgentSkillSave) {
    return this.skills.createSkill(me(), dto)
  }

  @Post('import')
  @RequirePerm(chat.use, skill.create)
  @Idempotent()
  @ActionLog({ domain: 'agent.skill', verb: 'import', bizId: createdId })
  @ApiOperation({
    summary: 'Import a SKILL.md (front matter name, description, tools; then the body)',
  })
  @ApiEnvelope(agentSkillVo, 201)
  import(@Body({ schema: agentSkillImport }) dto: AgentSkillImport) {
    return this.skills.importSkill(me(), dto)
  }

  @Post('from-thread/:id')
  @RequirePerm(chat.use)
  @Idempotent()
  @ActionLog({ domain: 'agent.skill', verb: 'create', bizId: createdId })
  @ApiOperation({
    summary: "Draft a skill from the caller's own thread with the default model, saved disabled",
  })
  @ApiEnvelope(agentSkillVo, 201)
  fromThread(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: skillFromThread }) dto: z.infer<typeof skillFromThread>,
  ) {
    return this.skills.fromThread(me(), id, dto)
  }

  @Put(':id')
  @RequirePerm(chat.use, skill.modify)
  @ActionLog({ domain: 'agent.skill', verb: 'modify' })
  @ApiOperation({
    summary: 'Change a skill (its scope stays); tenant-wide ones need agent.skill.modify',
  })
  @ApiEnvelope(agentSkillVo)
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: agentSkillSave }) dto: AgentSkillSave,
  ) {
    return this.skills.updateSkill(me(), id, dto)
  }

  @Delete(':id')
  @RequirePerm(chat.use, skill.remove)
  @ActionLog({ domain: 'agent.skill', verb: 'remove' })
  @ApiOperation({ summary: 'Delete a skill; tenant-wide ones need agent.skill.remove' })
  @ApiEnvelope()
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.skills.removeSkill(me(), id)
  }

  @Get(':id/export')
  @RequirePerm(chat.use, skill.browse)
  @ApiOperation({ summary: 'A skill as SKILL.md text' })
  @ApiEnvelope(z.object({ name: z.string(), text: z.string() }))
  export(@Param('id', ParseIntPipe) id: number) {
    return this.skills.exportSkill(me(), id)
  }
}

/** 平台页“智能体设置 · 技能”：平台技能对所有租户可用，所以是平台页，改动只有 root。 */
@ApiTags('agent')
@Controller('agent/platform-skills')
@AgentRootOnly()
export class AgentPlatformSkillController {
  constructor(private readonly skills: AgentPlatformSkillService) {}

  @Get()
  @RequirePerm(setting.browse)
  @PlatformOnly()
  @ApiOperation({ summary: 'Platform skills (every tenant may use the enabled ones)' })
  @ApiEnvelope(z.array(agentSkillVo))
  list() {
    return this.skills.list()
  }

  @Post()
  @RequirePerm(setting.modify)
  @PlatformOnly('root')
  @Idempotent()
  @ActionLog({ domain: 'agent.platformSkill', verb: 'create', bizId: createdId })
  @ApiOperation({ summary: 'Add a platform skill (scope is ignored)' })
  @ApiEnvelope(agentSkillVo, 201)
  create(@Body({ schema: agentSkillSave }) dto: AgentSkillSave) {
    return this.skills.save(null, dto)
  }

  @Put(':id')
  @RequirePerm(setting.modify)
  @PlatformOnly('root')
  @ActionLog({ domain: 'agent.platformSkill', verb: 'modify' })
  @ApiOperation({ summary: 'Change a platform skill' })
  @ApiEnvelope(agentSkillVo)
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: agentSkillSave }) dto: AgentSkillSave,
  ) {
    return this.skills.save(id, dto)
  }

  @Delete(':id')
  @RequirePerm(setting.modify)
  @PlatformOnly('root')
  @ActionLog({ domain: 'agent.platformSkill', verb: 'remove' })
  @ApiOperation({ summary: 'Delete a platform skill' })
  @ApiEnvelope()
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.skills.removeOne(id)
  }

  @Post('import')
  @RequirePerm(setting.modify)
  @PlatformOnly('root')
  @Idempotent()
  @ActionLog({ domain: 'agent.platformSkill', verb: 'import', bizId: createdId })
  @ApiOperation({ summary: 'Import a SKILL.md as a platform skill (scope is ignored)' })
  @ApiEnvelope(agentSkillVo, 201)
  import(@Body({ schema: agentSkillImport }) dto: AgentSkillImport) {
    return this.skills.importSkill(dto)
  }

  @Get(':id/export')
  @RequirePerm(setting.browse)
  @PlatformOnly()
  @ApiOperation({ summary: 'A platform skill as SKILL.md text' })
  @ApiEnvelope(z.object({ name: z.string(), text: z.string() }))
  export(@Param('id', ParseIntPipe) id: number) {
    return this.skills.exportSkill(id)
  }
}

/** 说明：个人说明与语气（本人），租户说明（改动需 `agent.instruction.modify`）。 */
@ApiTags('agent')
@Controller('agent/instructions')
export class AgentInstructionController {
  constructor(private readonly instructions: AgentInstructionService) {}

  @Get('me')
  @RequirePerm(chat.use)
  @ApiOperation({ summary: "The caller's own instructions and tone" })
  @ApiEnvelope(personalInstructionVo)
  mine() {
    return this.instructions.mine(me())
  }

  @Put('me')
  @RequirePerm(chat.use)
  @ActionLog({ domain: 'agent.instruction', verb: 'modify' })
  @ApiOperation({ summary: "Save the caller's own instructions (and tone, when given)" })
  @ApiEnvelope(personalInstructionVo)
  saveMine(@Body({ schema: agentInstructionSave }) dto: AgentInstructionSave) {
    return this.instructions.saveMine(me(), dto)
  }

  @Get('tenant')
  @RequirePerm(chat.use, skill.browse, instruction.modify)
  @ApiOperation({ summary: "The tenant's instructions" })
  @ApiEnvelope(tenantInstructionVo)
  tenant() {
    return this.instructions.tenant()
  }

  @Put('tenant')
  @RequirePerm(instruction.modify)
  @ActionLog({ domain: 'agent.instruction', verb: 'modify' })
  @ApiOperation({ summary: "Save the tenant's instructions (tone is personal only, ignored here)" })
  @ApiEnvelope(tenantInstructionVo)
  saveTenant(@Body({ schema: agentInstructionSave }) dto: AgentInstructionSave) {
    return this.instructions.saveTenant(dto)
  }
}
