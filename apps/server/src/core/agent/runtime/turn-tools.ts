import {
  AGENT_SKILL_NAME,
  type AgentApprovalMode,
  type AgentAskReason,
  type AgentToolPolicy,
  type McpToolKind,
} from '@qiwu/shared'
import { z } from 'zod'

/** Where an offered tool runs: this system's tools, the web tools, an external server, the runtime itself. */
export type ToolOrigin = 'local' | 'web' | 'mcp' | 'builtin'

/** A tool as one turn offers it: what the model sees plus how the runtime treats a call. */
export interface OfferedTool {
  name: string
  title: string
  description: string
  parameters: Record<string, unknown>
  origin: ToolOrigin
  kind: McpToolKind
  /**
   * after the platform setting and the never-auto-write rule: `auto` runs at once, `ask` waits for the owner
   * unless an approval reviewer decides or the owner allowed the tool for the thread, `human` always waits
   */
  policy: Exclude<AgentToolPolicy, 'deny'>
  /** the tool's method can preview a write (local tools) */
  preview: boolean
  perCallConfirmation?: true
  /** why a call of it waits for a person (not for `auto`) */
  why?: AgentAskReason
}

/** 只读与计划模式都不提供写入工具。 */
export const readOnlyMode = (mode: AgentApprovalMode): boolean =>
  mode === 'read_only' || mode === 'plan'

export const PLAN_TOOL = 'plan.update'
export const PROPOSE_TOOL = 'plan.propose'
export const ASK_TOOL = 'ask.user'
export const SKILL_TOOL = 'skill.load'
export const DELEGATE_TOOL = 'agent.delegate'
export const CHART_TOOL = 'chart.render'
export const REPORT_TOOL = 'report.write'
export const IMAGE_TOOL = 'image.generate'

/** A subagent's turn takes at most this many steps (fewer than a normal turn's limit when that is lower). */
export const SUBAGENT_STEPS = 8

/**
 * 子会话里不提供的工具：再分派、反问用户与提交方案（子会话没人回答），以及写给本人看的产出（图表、报告、图片：子会话
 * 不在列表里，图片还要花钱；产出由父会话来写）。
 */
const SUBAGENT_DENIED = new Set([
  DELEGATE_TOOL,
  ASK_TOOL,
  PROPOSE_TOOL,
  CHART_TOOL,
  REPORT_TOOL,
  IMAGE_TOOL,
])

/**
 * 子智能体的会话只留下这些工具（see docs/agent.md#子智能体）：只读且策略为 auto 的（不会停下等审批），
 * 去掉 {@link SUBAGENT_DENIED}，给了清单时只留清单里的（分派时父会话可用的工具）。就地修改并返回 `tools`。
 */
export function keepForSubagent(
  tools: Map<string, OfferedTool>,
  allowed: readonly string[] | undefined,
): Map<string, OfferedTool> {
  for (const [name, t] of tools)
    if (
      t.kind !== 'read' ||
      t.policy !== 'auto' ||
      SUBAGENT_DENIED.has(name) ||
      (allowed && !allowed.includes(name))
    )
      tools.delete(name)
  return tools
}

/** 子会话的 `target_ref`：分派它的调用 id 与序号（重做时据此找回）。 */
export const subagentRef = (callId: string, n: number) => `subagent:${callId}#${n}`
/** `target_ref` → 分派它的调用 id；不是子会话的为 null。 */
export const subagentCallOf = (ref: string | null): string | null =>
  ref?.startsWith('subagent:') ? ref.slice('subagent:'.length).replace(/#\d+$/, '') : null

export const planInput = z.object({
  steps: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(200),
        status: z.enum(['pending', 'doing', 'done']),
      }),
    )
    .min(1)
    .max(30)
    // 同一时刻至多一步进行中：清单要反映真实进度，两步同时“进行中”多半是忘了把上一步标成完成
    .refine((steps) => steps.filter((s) => s.status === 'doing').length <= 1, {
      message: 'At most one step may be doing at a time; mark the finished step done first.',
    }),
})

/** `plan.propose` 的方案：标题、概述、步骤、预计改动的数据与前提假设（都是模型自己写的文字）。 */
export const proposeInput = z.object({
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(2000),
  steps: z.array(z.string().trim().min(1).max(300)).min(1).max(30),
  changes: z.string().trim().max(2000).optional(),
  assumptions: z.array(z.string().trim().min(1).max(300)).max(10).optional(),
})

export const askInput = z.object({
  questions: z
    .array(
      z.object({
        header: z.string().trim().min(1).max(40),
        question: z.string().trim().min(1).max(500),
        options: z
          .array(
            z.object({
              label: z.string().trim().min(1).max(200),
              description: z.string().trim().max(500).optional(),
            }),
          )
          .min(2)
          .max(4),
        multiSelect: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(4),
})

export const skillInput = z.object({ name: z.string().regex(AGENT_SKILL_NAME) })

/** 会话里记下的一条放行：`<放行它的轮次 id>#<工具名>`，撤回那一轮时据此连同它记下的放行一起去掉。 */
export const allowEntry = (turnId: number, tool: string): string =>
  `${turnId}#${tool}`.slice(0, 300)

/** 一条放行记录拆成记下它的轮次与工具名（没有轮次前缀的整条都是工具名）。 */
export function parseAllow(entry: string): { turnId: number | null; tool: string } {
  const at = entry.indexOf('#')
  const turnId = at > 0 ? Number(entry.slice(0, at)) : Number.NaN
  return Number.isSafeInteger(turnId)
    ? { turnId, tool: entry.slice(at + 1) }
    : { turnId: null, tool: entry }
}

/** 本会话内不再询问的工具名（去重，按放行先后）。 */
export const allowedTools = (trusted: readonly string[] | null | undefined): string[] => [
  ...new Set((trusted ?? []).map((e) => parseAllow(e).tool)),
]

/** 本会话是否已放行这个工具。 */
export const isAllowed = (trusted: readonly string[] | null | undefined, tool: string): boolean =>
  (trusted ?? []).some((e) => parseAllow(e).tool === tool)
