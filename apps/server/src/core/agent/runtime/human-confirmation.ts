import { createHash, randomUUID } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { agentPerms, type AgentItemPayloads, Err } from '@qiwu/shared'
import type { DataSource } from 'typeorm'
import { PermVersion } from '../../auth/perm-version.js'
import type { Principal } from '../../auth/principal.js'
import { tenantId } from '../../context/tenant.js'
import { canonicalJson } from '../../guard/idempotent.js'
import { BizError } from '../../http/biz-error.js'
import { McpRegistry } from '../../mcp/mcp-registry.js'
import { McpToolSwitch } from '../../mcp/mcp.entity.js'
import { MCP_CONFIRMATION_REVISION, type ToolExecutionContext } from '../../mcp/mcp-tool.js'
import { argsJson, ToolHost, ToolRefusal, type ToolPreview } from '../../mcp/tool-host.js'
import { factsOf, loadPrincipal } from '../automation/pre-approval.js'
import { AgentToolRestriction } from '../entities/agent-mcp.entity.js'
import { AgentItem, AgentTurn } from '../entities/agent-thread.entity.js'
import { type ItemInternal, ItemStore } from './item-store.js'

type Card = AgentItemPayloads['approval'] & { internal?: ItemInternal }
export interface ConfirmationRef {
  threadId: number
  turnId: number
  callId: string
}
export interface ConfirmationPreview {
  rawArgs: unknown
  schema: string
  revision: string
  args: unknown
  preview: ToolPreview
  digest: string
}

/**
 * 逐次人工确认的服务端凭据：绑定本人、租户、规范参数、业务预览和有效权限事实。
 * 凭据存在既有审批条目中；公开 token 仅指定当前预览版本，不是可跨人或跨调用使用的写入许可。
 */
@Injectable()
export class HumanConfirmation {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly registry: McpRegistry,
    private readonly host: ToolHost,
    private readonly perms: PermVersion,
    private readonly store: ItemStore,
  ) {}

  /** 旧卡也按当前声明复查，避免工具后来改为人工专用时仍被批量或旧信任放行。 */
  required(card: Pick<Card, 'tool' | 'perCallConfirmation'>): boolean {
    return (
      card.perCallConfirmation === true ||
      this.registry.get(card.tool)?.perCallConfirmation === true
    )
  }

  /**
   * 按现有护栏读取真实预览；失败不降级为无预览确认。业务模块的预览必须列出模型版本和附件等写入依据，
   * 并在最终业务事务的锁内与宿主传入的确认快照复核，不能拿预览本身代替业务锁。
   */
  async prepare(
    p: Principal,
    ref: ConfirmationRef,
    name: string,
    args: unknown,
    previous?: ItemInternal['confirmation'],
  ): Promise<ConfirmationPreview> {
    const t = this.registry.get(name)
    if (!t?.perCallConfirmation || t.kind !== 'write' || !t.runPreview)
      throw new BizError(Err.AGENT_APPROVAL_CLOSED)
    const revision = t.confirmationRevision
    if (typeof revision !== 'string' || !MCP_CONFIRMATION_REVISION.test(revision))
      throw new BizError(Err.AGENT_APPROVAL_CLOSED)
    const current = await loadPrincipal(this.perms, p.userId)
    if (
      !current ||
      current.tenantId !== tenantId() ||
      (!current.root && !current.perms.includes(agentPerms.chat.use))
    )
      throw new BizError(Err.FORBIDDEN)
    if (argsJson(args) === null) throw new BizError(Err.VALIDATION_FAILED)
    const row = await this.ds.getRepository(McpToolSwitch).findOneBy({ name })
    if (row && (!row.enabled || row.agentPolicy === 'deny'))
      throw new BizError(Err.MCP_TOOL_DISABLED)
    // 本租户的收紧与平台开关同等对待：确认之后才停用的同样拒绝；收紧行有任何变化都换新预览版本
    const restriction = await this.ds.getRepository(AgentToolRestriction).findOne({
      where: { tenantId: tenantId(), tool: name },
      select: { id: true, policy: true, updatedAt: true },
    })
    if (restriction?.policy === 'deny') throw new BizError(Err.MCP_TOOL_DISABLED)
    const schema = canonicalJson(t.inputSchema)
    // 仅 JSON Schema 不能识别 refine、transform 与 default 的全部语义，维护者须同步递增稳定契约版本。
    // 只有服务端 receipt 的契约版本、schema 和原始调用都没变时才复用已验证快照。
    // 默认工厂及非幂等 transform 不会因为用户点击确认、续跑或事实变化而重新生成值。
    const reuse =
      previous?.revision === revision &&
      previous.schema === schema &&
      canonicalJson(previous.rawArgs) === canonicalJson(args)
    let prepared: { args: unknown; preview: ToolPreview | null } | null
    try {
      prepared = reuse
        ? {
            args: previous.args,
            preview: await this.host.previewCanonical(current, name, previous.args),
          }
        : await this.host.preparePreview(current, name, args)
    } catch (e) {
      // 预览共享解析器的参数拒绝保持为业务校验错误，不把缺少合法输入变成服务端异常。
      if (e instanceof ToolRefusal) {
        // 旧卡面对新的契约已不合法时只报冲突，绝不沿旧规范快照执行；用户仍可拒绝或取消旧卡。
        if (previous && !reuse) throw new BizError(Err.CONFLICT)
        throw new BizError(e.err, e.params)
      }
      throw e
    }
    if (!prepared?.preview || argsJson(prepared.args) === null)
      throw new BizError(Err.UNPROCESSABLE)
    const { preview } = prepared
    const digest = createHash('sha256')
      .update(
        canonicalJson({
          ...ref,
          tenant: tenantId(),
          actor: current.userId,
          tool: {
            name,
            kind: t.kind,
            perm: t.perm,
            feature: t.feature ?? null,
            schema: t.inputSchema,
            confirmationRevision: revision,
          },
          rawArgs: args,
          args: prepared.args,
          preview,
          facts: factsOf(current, t.perm, t.feature),
          version: await this.perms.current(current.userId),
          switch: row
            ? { enabled: row.enabled, policy: row.agentPolicy, updatedAt: row.updatedAt }
            : null,
          // 没有收紧行时不放这个键，既有卡片的版本不变
          ...(restriction && {
            restriction: {
              id: restriction.id,
              policy: restriction.policy,
              updatedAt: restriction.updatedAt,
            },
          }),
        }),
      )
      .digest('hex')
    return { rawArgs: args, schema, revision, args: prepared.args, preview, digest }
  }

  /** 预览每次换版本都生成新 token；清掉旧决定，旧界面的迟到点击不能批准新内容。 */
  renew(card: Card, fresh: ConfirmationPreview): Card {
    const token = randomUUID()
    const next: Card = {
      ...card,
      args: fresh.args,
      changes: fresh.preview,
      perCallConfirmation: true,
      confirmationToken: token,
      internal: {
        ...card.internal,
        confirmation: {
          digest: fresh.digest,
          token,
          rawArgs: fresh.rawArgs,
          args: fresh.args,
          schema: fresh.schema,
          revision: fresh.revision,
        },
      },
    }
    delete next.decision
    delete next.decidedBy
    delete next.decidedAt
    delete next.auto
    delete next.note
    delete next.sessionAllow
    return next
  }

  /** 当前展示版本是否由该交互提交指定；缺 token 或传旧 token 都不能表示同意当前预览。 */
  currentToken(card: Card, token: string | undefined): boolean {
    return (
      !!token && token === card.confirmationToken && token === card.internal?.confirmation?.token
    )
  }

  /**
   * 最终宿主执行前在会话锁内单次消费批准。重复消费拒绝；事实变化则更新同一卡片并重新等待，
   * 已消费后中断只沿用运行时的“结果未知、不重做”，不会因网络重放再次写入。
   */
  async claim(
    p: Principal,
    ref: ConfirmationRef,
    approvalId: number,
    name: string,
    args: unknown,
  ): Promise<ToolExecutionContext | null> {
    return this.store.tx(async (w) => {
      const thread = await w.thread(ref.threadId)
      if (
        !thread ||
        Number(thread.userId) !== p.userId ||
        thread.parentThreadId !== null ||
        thread.approvalMode === 'plan' ||
        thread.approvalMode === 'read_only'
      )
        throw new BizError(Err.AGENT_APPROVAL_CLOSED)
      const item = await w.m.getRepository(AgentItem).findOneBy({ id: approvalId })
      const turn = await w.m.getRepository(AgentTurn).findOneBy({ id: ref.turnId })
      const calls = await w.m
        .getRepository(AgentItem)
        .findBy({ threadId: ref.threadId, turnId: ref.turnId, kind: 'tool_call' })
      const matching = calls.find((c) => (c.payload as { callId?: string }).callId === ref.callId)
      const a = item?.payload as Card | undefined
      if (
        !item ||
        item.kind !== 'approval' ||
        item.status !== 'approved' ||
        Number(item.threadId) !== ref.threadId ||
        Number(item.turnId) !== ref.turnId ||
        !turn ||
        Number(turn.threadId) !== ref.threadId ||
        Number(turn.userId) !== p.userId ||
        turn.status !== 'running' ||
        !matching ||
        matching.status !== 'running' ||
        (matching.payload as { tool?: string }).tool !== name ||
        !a ||
        a.callId !== ref.callId ||
        a.tool !== name ||
        a.decision !== 'approve' ||
        a.auto ||
        a.decidedBy !== p.userId ||
        !a.decidedAt ||
        !a.perCallConfirmation ||
        !this.currentToken(a, a.confirmationToken) ||
        a.internal?.confirmation?.consumedAt
      )
        throw new BizError(Err.AGENT_APPROVAL_CLOSED)
      const fresh = await this.prepare(p, ref, name, args, a.internal?.confirmation)
      if (a.internal?.confirmation?.digest !== fresh.digest) {
        await w.update(item, { status: 'pending', payload: this.renew(a, fresh) }, 'approved')
        await w.update(matching, { status: 'pending' })
        await w.patchTurn(turn, { status: 'waiting' })
        return null
      }
      await w.update(
        item,
        {
          payload: {
            ...a,
            internal: {
              ...a.internal,
              confirmation: { ...a.internal!.confirmation!, consumedAt: new Date().toISOString() },
            },
          },
        },
        'approved',
      )
      return { confirmation: { approvalId, args: fresh.args, preview: fresh.preview } }
    })
  }
}
