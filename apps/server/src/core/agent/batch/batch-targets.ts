import { Injectable, type OnModuleInit, SetMetadata } from '@nestjs/common'
import { DiscoveryService, Reflector } from '@nestjs/core'
import { withCheckedPerm } from '../../data-scope/data-scope.js'

const BATCH_TARGET = 'qw:agent:batch-target'

/**
 * What a module tells the batch runs about its records: the short text naming each record in the prompt
 * and the thread title (a customer's name, say).
 */
export interface AgentBatchTargetProvider {
  /**
   * The label of each id the caller may read (data scope and tenant applied, like a list); ids left out of
   * the map are missing or out of scope.
   */
  batchLabels(ids: number[]): Promise<Map<number, string>>
}

/** A batch target as registered: its name, the perm to read its records, the provider. */
export interface AgentBatchTargetMeta {
  /** `<domain>.<resource>`, e.g. `demo.customer` */
  target: string
  /** the perm a caller needs to run a batch on these records (the list's browse perm) */
  perm: string
  /**
   * the write tools whose approvals the batch page may decide in bulk for a row: only a call of one of these
   * whose write preview targets the row's own record; every other approval waits for a one-by-one decision
   */
  tools: string[]
}

/** A registered batch target. */
export interface AgentBatchTargetEntry {
  perm: string
  tools: readonly string[]
  provider: AgentBatchTargetProvider
}

/**
 * 把一个 provider 登记为批量执行的目标（see docs/agent.md）：类须实现 {@link AgentBatchTargetProvider}；
 * `perm` 是读这些记录要的权限点（列表的 browse），没有它的人不能对这些记录建批次，也就看不到记录名；
 * `tools` 是批次页可以一次确认的写入工具（须有写入预览），别的工具的审批只能逐条确认。
 * 智能体关着时没人扫描它，模块照常工作。
 */
export const AgentBatchTarget = (meta: AgentBatchTargetMeta): ClassDecorator =>
  SetMetadata(BATCH_TARGET, meta)

/** 批量执行的目标登记表：启动时扫描带 `@AgentBatchTarget` 的 provider；同名登记两次让启动失败。 */
@Injectable()
export class AgentBatchTargets implements OnModuleInit {
  private readonly targets = new Map<string, AgentBatchTargetEntry>()

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly reflector: Reflector,
  ) {}

  /** 扫描全部 provider，按目标名登记。 */
  onModuleInit(): void {
    for (const { metatype, instance } of this.discovery.getProviders()) {
      if (!metatype || !instance || typeof instance !== 'object') continue
      const meta = this.reflector.get<AgentBatchTargetMeta | undefined>(BATCH_TARGET, metatype)
      if (!meta) continue
      if (this.targets.has(meta.target))
        throw new Error(`@AgentBatchTarget('${meta.target}') registered twice`)
      this.targets.set(meta.target, {
        perm: meta.perm,
        tools: meta.tools,
        provider: instance as AgentBatchTargetProvider,
      })
    }
  }

  /** 按目标名取登记的权限点、可批量确认的工具与 provider；没有时为 undefined。 */
  get(target: string): AgentBatchTargetEntry | undefined {
    return this.targets.get(target)
  }

  /**
   * 调用者能看到的记录名。数据权限按目标自己的读权限点算（不是当前路由的 `agent.batch.run`）：
   * 一个持有“批量执行（全部数据）”和“客户浏览（本部门）”两个角色的人，只能看到本部门客户的名字。
   */
  labels(t: AgentBatchTargetEntry, ids: number[]): Promise<Map<number, string>> {
    return withCheckedPerm({ perms: [t.perm], all: false }, () => t.provider.batchLabels(ids))
  }
}
