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
  /** after the platform setting and the never-auto-write rule: `auto` runs at once, `ask` waits */
  policy: Exclude<AgentToolPolicy, 'deny'>
  /** the tool's method can preview a write (local tools) */
  preview: boolean
}

export const PLAN_TOOL = 'plan.update'
export const ASK_TOOL = 'ask.user'
export const SKILL_TOOL = 'skill.load'

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

const schemaOf = (s: z.ZodObject) => {
  const { $schema: _, ...rest } = z.toJSONSchema(s, { io: 'input' }) as Record<string, unknown>
  return rest
}

const builtin = (
  name: string,
  title: string,
  description: string,
  input: z.ZodObject,
): OfferedTool => ({
  name,
  title,
  description,
  parameters: schemaOf(input),
  origin: 'builtin',
  kind: 'read',
  policy: 'auto',
  preview: false,
})

/** 运行时自己实现的工具：计划清单、反问用户、加载技能（后者只在有技能来源时提供）。 */
export function builtinTools(withSkills: boolean): OfferedTool[] {
  return [
    builtin(
      PLAN_TOOL,
      'Update the plan',
      'Replaces the checklist of this task shown to the user: every step with its status ' +
        '(pending, doing, done). Call it when you start a multi-step task and whenever a step changes.',
      planInput,
    ),
    builtin(
      ASK_TOOL,
      'Ask the user',
      'Asks the user 1-4 questions, each with 2-4 options (single or multiple choice; the user may also ' +
        'type an answer), and waits for the answers. Use it when a choice is the user’s to make.',
      askInput,
    ),
    ...(withSkills
      ? [
          builtin(
            SKILL_TOOL,
            'Load a skill',
            'Returns the instructions of one of the listed skills by name. Load a skill before doing a ' +
              'task it describes.',
            skillInput,
          ),
        ]
      : []),
  ]
}

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
