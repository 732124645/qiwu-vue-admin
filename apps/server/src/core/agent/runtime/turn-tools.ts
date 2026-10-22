import { createHash } from 'node:crypto'
import { AGENT_SKILL_NAME, type AgentToolPolicy, type McpToolKind } from '@qiwu/shared'
import { z } from 'zod'
import { canonicalJson } from '../../guard/idempotent.js'

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
   * after the platform setting and the never-auto-write rule: `auto` runs at once, `ask` and `review` wait
   * for the owner unless an approval reviewer decides
   */
  policy: Exclude<AgentToolPolicy, 'deny'>
  /** the tool's method can preview a write (local tools) */
  preview: boolean
  perCallConfirmation?: true
}

export const PLAN_TOOL = 'plan.update'
export const ASK_TOOL = 'ask.user'
export const SKILL_TOOL = 'skill.load'
export const DELEGATE_TOOL = 'agent.delegate'
export const CHART_TOOL = 'chart.render'
export const REPORT_TOOL = 'report.write'
export const IMAGE_TOOL = 'image.generate'

/** A subagent's turn takes at most this many steps (fewer than a normal turn's limit when that is lower). */
export const SUBAGENT_STEPS = 8

/**
 * 子会话里不提供的工具：再分派、反问用户（子会话没人回答），以及写给本人看的产出（图表、报告、图片：子会话
 * 不在列表里，图片还要花钱；产出由父会话来写）。
 */
const SUBAGENT_DENIED = new Set([DELEGATE_TOOL, ASK_TOOL, CHART_TOOL, REPORT_TOOL, IMAGE_TOOL])

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
    .max(30),
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

/**
 * 审批“本会话内同意”记住的目标：预览给出的目标记录；没有预览时本系统与联网工具取参数里的 `id`，再没有就是
 * 完整参数的 SHA-256（只信任一模一样的调用，长参数也不会因截断而撞上别的调用）。外部工具（`external`）
 * 一律按完整参数的摘要：它的 `id` 是什么由外部服务器说了算，同一个 `id` 换了别的参数可能是完全不同的操作。
 */
export function trustKey(
  tool: string,
  args: unknown,
  previewTarget?: string,
  external = false,
): string {
  const id =
    args && typeof args === 'object' && 'id' in args ? (args as { id: unknown }).id : undefined
  const digest = () => `sha256:${createHash('sha256').update(canonicalJson(args)).digest('hex')}`
  const target =
    previewTarget ??
    (!external && (typeof id === 'number' || typeof id === 'string') ? `id:${id}` : digest())
  return `${tool}|${target}`.slice(0, 500)
}

/** 会话里记下的一条信任：`<记下它的轮次 id>#<信任键>`，撤回那一轮时据此连同它记下的信任一起去掉。 */
export const trustEntry = (turnId: number, key: string): string => `${turnId}#${key}`

/** 一条信任记录拆成记下它的轮次与信任键（没有轮次前缀的旧记录整条都是键）。 */
export function parseTrust(entry: string): { turnId: number | null; key: string } {
  const at = entry.indexOf('#')
  const turnId = at > 0 ? Number(entry.slice(0, at)) : Number.NaN
  return Number.isSafeInteger(turnId)
    ? { turnId, key: entry.slice(at + 1) }
    : { turnId: null, key: entry }
}

/** 会话是否已信任这个键。 */
export const isTrusted = (trusted: readonly string[] | null | undefined, key: string): boolean =>
  (trusted ?? []).some((e) => parseTrust(e).key === key)
