import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { ModuleRef } from '@nestjs/core'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  AGENT_APPROVAL_MODES,
  AGENT_TRUST_MODE_PARAM,
  AGENT2_PARAMS,
  type AgentApprovalMode,
  type AgentProfileSave,
  type AgentProfileVo,
  agentPerms,
  Err,
} from '@qiwu/shared'
import { In, Not } from 'typeorm'
import {
  type AgentRunProfile,
  EXTERNAL_TOOL_SOURCE,
  type ExternalToolSource,
  type ProfileSource,
} from '../agent-ports.js'
import type { Principal } from '../../auth/principal.js'
import { tenantId } from '../../context/tenant.js'
import { McpRegistry } from '../../mcp/mcp-registry.js'
import { BizError } from '../../http/biz-error.js'
import { ParamService } from '../../settings/param.service.js'
import { AgentProfile } from '../entities/agent-memory.entity.js'
import { ProviderSettingsService } from '../provider/provider-settings.service.js'
import { AgentExtensions } from '../runtime/agent-extensions.js'
import { parseReviewModel } from '../runtime/auto-reviewer.js'
import { num, trustModeOn } from '../threads/thread-vo.js'
import { WEB_TOOLS } from '../web/web-tools.js'

/** 每人（含全租户共用的）最多这么多个配置方案。 */
export const PROFILES_MAX = 50
/**
 * 全租户共用的方案只能用这两种审批模式：“信任本会话”与“自动审查”是替本人同意写入，只能由本人在个人方案
 * 或会话里选，别人建的方案不能替他选。
 */
export const TENANT_PROFILE_MODES: readonly AgentApprovalMode[] = ['read_only', 'ask']

/**
 * 平台此刻允许的审批模式（与对话页选项、新建会话的 `modeOffered` 同一条规则）：“信任本会话”被
 * `agent.trust_mode` 关掉时不行，自动审查要先由平台指定有效的审查模型（`parseReviewModel`）。
 */
export async function offeredModes(params: ParamService): Promise<AgentApprovalMode[]> {
  const trust = trustModeOn(await params.get(AGENT_TRUST_MODE_PARAM))
  const review = !!parseReviewModel(await params.get(AGENT2_PARAMS.reviewModel))
  return AGENT_APPROVAL_MODES.filter(
    (m) => (trust || m !== 'trust') && (m !== 'auto_review' || review),
  )
}

const runProfile = (r: AgentProfile): AgentRunProfile => ({
  id: num(r.id),
  name: r.name,
  scope: num(r.ownerUserId) === 0 ? 'tenant' : 'user',
  providerId: r.providerId == null ? null : num(r.providerId),
  model: r.model,
  reasoning: r.reasoning,
  approvalMode: r.approvalMode,
  tools: r.tools,
  instructions: r.instructions,
})

/**
 * 配置方案（see docs/agent.md）：命名的一组模型、推理强度、审批模式、允许的工具与额外说明。分个人（本人
 * 可改）与全租户共用（增改删要 `agent.skill.modify`）；别人的个人方案一律 404。同一范围内可设一个默认：
 * 新建会话不选方案时用默认（个人默认优先）。审批模式只能是平台此刻允许的，全租户的只能是只读或询问（400）；
 * 工具清单里的名字须是存在的工具（400）。个数上限与“默认唯一”在锁住所属行（本人或本租户）之后判断，
 * 并发的保存依次进行。
 */
@Injectable()
export class AgentProfileService implements ProfileSource {
  constructor(
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly params: ParamService,
    private readonly providers: ProviderSettingsService,
    private readonly moduleRef: ModuleRef,
  ) {}

  private get repo() {
    return this.txHost.tx.getRepository(AgentProfile)
  }

  /** 能否改全租户共用的方案。 */
  private tenantWide(p: Principal): boolean {
    return p.root === true || p.perms.includes(agentPerms.skill.modify)
  }

  private vo(p: Principal, r: AgentProfile): AgentProfileVo {
    const tenant = num(r.ownerUserId) === 0
    return {
      ...runProfile(r),
      scope: tenant ? 'tenant' : 'user',
      isDefault: r.isDefault,
      editable: !tenant || this.tenantWide(p),
    }
  }

  /** 本人的与全租户共用的方案（共用的在前，再按名称）。 */
  async list(p: Principal): Promise<AgentProfileVo[]> {
    const rows = await this.repo.find({
      where: { ownerUserId: In([p.userId, 0]) },
      order: { ownerUserId: 'ASC', name: 'ASC' },
    })
    return rows.map((r) => this.vo(p, r))
  }

  /**
   * 保存前的检查：审批模式须是平台此刻允许的，全租户的只能是只读或询问（400）；工具名须存在（400）；
   * 给了提供方或模型时须是启用的提供方及其模型（422，与新建会话同一条规则）；同一范围内名称唯一（409）。
   */
  private async check(
    p: Principal,
    owner: number,
    dto: AgentProfileSave,
    excludeId?: number,
  ): Promise<void> {
    if (!(await offeredModes(this.params)).includes(dto.approvalMode))
      throw new BizError(Err.VALIDATION_FAILED)
    if (owner === 0 && !TENANT_PROFILE_MODES.includes(dto.approvalMode))
      throw new BizError(Err.VALIDATION_FAILED)
    if (dto.tools?.length && !(await this.toolsExist(p, dto.tools)))
      throw new BizError(Err.VALIDATION_FAILED)
    if (dto.providerId !== null || dto.model !== null) {
      const list = (await this.providers.list()).filter((r) => r.enabled && r.models.length)
      const prov = dto.providerId === null ? list[0] : list.find((x) => x.id === dto.providerId)
      if (!prov || (dto.model !== null && !prov.models.some((m) => m.id === dto.model)))
        throw new BizError(Err.AGENT_NOT_CONFIGURED)
    }
    const taken = await this.repo.exists({
      where: {
        ownerUserId: owner,
        name: dto.name,
        ...(excludeId !== undefined && { id: Not(excludeId) }),
      },
    })
    if (taken) throw new BizError(Err.DUPLICATE, { name: dto.name })
  }

  /**
   * 工具名都存在吗：本系统工具、联网工具、内置工具，或调用者此刻能用的外部工具。运行时的登记表在
   * AgentModule 里（它引入本模块），这里按需从应用里取，不形成循环依赖。
   */
  private async toolsExist(p: Principal, names: string[]): Promise<boolean> {
    const get = <T>(token: unknown): T | undefined => {
      try {
        return this.moduleRef.get(token as never, { strict: false }) as T
      } catch {
        return undefined
      }
    }
    const registry = get<McpRegistry>(McpRegistry)
    const ext = get<AgentExtensions>(AgentExtensions)
    let external: Set<string> | null = null
    for (const name of names) {
      if (registry?.get(name) || ext?.builtin(name) || WEB_TOOLS.some((w) => w.name === name))
        continue
      external ??= new Set(
        ((await get<ExternalToolSource>(EXTERNAL_TOOL_SOURCE)?.list(p)) ?? []).map((t) => t.name),
      )
      if (!external.has(name)) return false
    }
    return true
  }

  /**
   * 锁住方案的所属行（个人方案锁本人的用户行，全租户方案锁本租户行）：同一范围的保存依次进行，个数上限与
   * “默认唯一”在锁内判断才可靠。须在事务里最先调用。
   */
  private async lockOwner(p: Principal, owner: number): Promise<void> {
    if (owner === 0)
      await this.txHost.tx.query(
        'SELECT id FROM iam_tenant WHERE id = ? AND deleted_at IS NULL FOR UPDATE',
        [tenantId()],
      )
    else
      await this.txHost.tx.query(
        // qw:no-data-scope the caller's own row, locked so the profile count holds until the insert
        'SELECT id FROM iam_user WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL FOR UPDATE',
        [p.userId, tenantId()],
      )
  }

  /** 这个范围的方案已满（409）。 */
  private async assertRoom(owner: number): Promise<void> {
    if ((await this.repo.countBy({ ownerUserId: owner })) >= PROFILES_MAX)
      throw new BizError(Err.CONFLICT)
  }

  /** 设为默认：同一范围里别的方案不再是默认（一个范围只有一个默认）。 */
  private async clearDefault(owner: number, keepId: number): Promise<void> {
    await this.repo.update(
      { ownerUserId: owner, isDefault: true, id: Not(keepId) },
      {
        isDefault: false,
      },
    )
  }

  private fields(owner: number, dto: AgentProfileSave): Partial<AgentProfile> {
    return {
      ownerUserId: owner,
      name: dto.name,
      providerId: dto.providerId,
      model: dto.model,
      reasoning: dto.reasoning,
      approvalMode: dto.approvalMode,
      tools: dto.tools,
      instructions: dto.instructions?.trim() || null,
      isDefault: dto.isDefault,
    }
  }

  /** 新建方案：全租户共用的需要 `agent.skill.modify`（403）；超过个数上限 409。 */
  async create(p: Principal, dto: AgentProfileSave): Promise<AgentProfileVo> {
    if (dto.scope === 'tenant' && !this.tenantWide(p)) throw new ForbiddenException()
    const owner = dto.scope === 'tenant' ? 0 : p.userId
    return this.txHost.withTransaction(async () => {
      await this.lockOwner(p, owner)
      await this.assertRoom(owner)
      await this.check(p, owner, dto)
      const row = await this.repo.save(this.repo.create(this.fields(owner, dto)))
      if (row.isDefault) await this.clearDefault(owner, num(row.id))
      return this.vo(p, row)
    })
  }

  /**
   * 本人能改的一个方案，锁行：别人的个人方案 404；改全租户共用的（或改成共用的）要 `agent.skill.modify`（403）。
   */
  private async editable(p: Principal, id: number, toTenant = false): Promise<AgentProfile> {
    const row = await this.repo.findOne({
      where: { id, ownerUserId: In([p.userId, 0]) },
      lock: { mode: 'pessimistic_write' },
    })
    if (!row) throw new NotFoundException()
    if ((num(row.ownerUserId) === 0 || toTenant) && !this.tenantWide(p))
      throw new ForbiddenException()
    return row
  }

  /** 修改方案（可在个人与全租户之间改范围，规则同新建；换到另一个范围时也看那边的上限）。 */
  async update(p: Principal, id: number, dto: AgentProfileSave): Promise<AgentProfileVo> {
    return this.txHost.withTransaction(async () => {
      const owner = dto.scope === 'tenant' ? 0 : p.userId
      await this.lockOwner(p, owner)
      const row = await this.editable(p, id, dto.scope === 'tenant')
      if (num(row.ownerUserId) !== owner) await this.assertRoom(owner)
      await this.check(p, owner, dto, id)
      await this.repo.update(id, this.fields(owner, dto))
      if (dto.isDefault) await this.clearDefault(owner, id)
      return this.vo(p, await this.repo.findOneByOrFail({ id }))
    })
  }

  /** 删除方案：用着它的会话退回默认行为（运行时找不到方案就不限制工具、不加说明）。 */
  async remove(p: Principal, id: number): Promise<null> {
    await this.txHost.withTransaction(async () => {
      await this.editable(p, id)
      await this.repo.softDelete({ id })
    })
    return null
  }

  /** 运行时与新建会话：本人可用的一个方案（个人的或全租户共用的，ORM 加当前租户条件）。 */
  async find(p: Principal, id: number): Promise<AgentRunProfile | null> {
    const row = await this.repo.findOneBy({ id, ownerUserId: In([p.userId, 0]) })
    return row && runProfile(row)
  }

  /** 新建会话不选方案时：个人默认优先，其次全租户默认。 */
  async defaultFor(p: Principal): Promise<AgentRunProfile | null> {
    const row = await this.repo.findOne({
      where: { ownerUserId: In([p.userId, 0]), isDefault: true },
      // 个人的 owner 大于 0：降序排在全租户的前面
      order: { ownerUserId: 'DESC' },
    })
    return row && runProfile(row)
  }
}
