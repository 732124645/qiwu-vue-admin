import { Injectable } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import { AGENT_INSTRUCTIONS_PARAM, type AGENT_TONES, type AgentInstructionSave } from '@qiwu/shared'
import type { Principal } from '../../auth/principal.js'
import { ParamService } from '../../settings/param.service.js'
import type { InstructionSource } from '../agent-ports.js'
import { AgentInstruction } from '../entities/agent-skill.entity.js'

type Tone = (typeof AGENT_TONES)[number]

/** The line each tone preset adds to the system prompt (`default` adds none). */
export const TONE_LINES: Record<Tone, string | null> = {
  default: null,
  concise: 'Answer concisely: short sentences, no filler.',
  detailed: 'Answer in detail: explain the reasoning and list the steps.',
  friendly: 'Answer in a warm, friendly tone.',
  formal: 'Answer in a formal, professional tone.',
}

/**
 * 系统提示里的说明（InstructionSource，see docs/agent.md）：平台参数 `agent.instructions` → 租户说明
 * （`agent_instruction` 中 `ownerUserId` 为 0 的行）→ 个人说明与语气；租户表，ORM 加租户条件。
 */
@Injectable()
export class AgentInstructionService implements InstructionSource {
  constructor(
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly params: ParamService,
  ) {}

  private get repo() {
    return this.txHost.tx.getRepository(AgentInstruction)
  }

  private row(ownerUserId: number): Promise<AgentInstruction | null> {
    return this.repo.findOneBy({ ownerUserId })
  }

  /** 写一行说明：有就改，没有就建（唯一键 tenant + owner + alive，并发时由唯一键兜底）；`tone` 不给则保留。 */
  private async put(ownerUserId: number, body: string, tone?: Tone | null): Promise<void> {
    await this.txHost.withTransaction(async () => {
      const row = await this.repo
        .createQueryBuilder('t')
        .where('t.ownerUserId = :ownerUserId', { ownerUserId })
        .setLock('pessimistic_write')
        .getOne()
      if (row) await this.repo.update(row.id, tone === undefined ? { body } : { body, tone })
      else await this.repo.save(this.repo.create({ ownerUserId, body, tone: tone ?? null }))
    })
  }

  /** 本人的说明与语气。 */
  async mine(p: Principal): Promise<{ body: string; tone: Tone }> {
    const row = await this.row(p.userId)
    return { body: row?.body ?? '', tone: row?.tone ?? 'default' }
  }

  async saveMine(p: Principal, dto: AgentInstructionSave): Promise<{ body: string; tone: Tone }> {
    await this.put(p.userId, dto.body, dto.tone)
    return this.mine(p)
  }

  /** 当前租户的说明。 */
  async tenant(): Promise<{ body: string }> {
    return { body: (await this.row(0))?.body ?? '' }
  }

  /** 改租户说明（语气只属于个人说明，这里不存）。 */
  async saveTenant(dto: AgentInstructionSave): Promise<{ body: string }> {
    await this.put(0, dto.body, null)
    return this.tenant()
  }

  /** 拼系统提示里的说明段：平台、租户、个人依次排列，最后一行是语气；空的部分省略。 */
  async compose(p: Principal): Promise<string> {
    const platform = (await this.params.get(AGENT_INSTRUCTIONS_PARAM))?.trim() ?? ''
    const tenant = (await this.row(0))?.body.trim() ?? ''
    const own = await this.row(p.userId)
    const tone = TONE_LINES[own?.tone ?? 'default']
    return [
      platform && `Platform instructions:\n${platform}`,
      tenant && `Organization instructions:\n${tenant}`,
      own?.body.trim() && `The user's own instructions:\n${own.body.trim()}`,
      tone,
    ]
      .filter(Boolean)
      .join('\n\n')
  }
}
