import dayjs from 'dayjs'
import type { AgentEvent, AgentItemVo, AgentThreadVo, AgentTurnVo } from '@qiwu/shared'

// 对话页的纯逻辑：条目合并、实时事件、断线补齐的起点、会话分组、技能与斜杠命令的解析。

type Item<K extends AgentItemVo['kind']> = Extract<AgentItemVo, { kind: K }>

/**
 * 按 id 合并条目（后来的整条替换先前的），结果按 seq 排序。服务端在回答与推理摘要结束前存的是空文字，
 * 所以两边都还在运行时保留本页已流入的更长文字，免得补齐时刚显示的内容消失。
 */
export function mergeItems(shown: AgentItemVo[], incoming: AgentItemVo[]): AgentItemVo[] {
  const byId = new Map(shown.map((i) => [i.id, i]))
  for (const i of incoming) {
    const local = byId.get(i.id)
    const streaming =
      local &&
      (local.kind === 'assistant' || local.kind === 'reasoning') &&
      local.kind === i.kind &&
      local.status === 'running' &&
      i.status === 'running' &&
      local.payload.text.length > (i.payload as { text: string }).text.length
    byId.set(
      i.id,
      streaming
        ? ({ ...i, payload: { ...i.payload, text: local.payload.text } } as AgentItemVo)
        : i,
    )
  }
  return [...byId.values()].sort((a, b) => a.seq - b.seq)
}

/**
 * 条目所在的轮次已经结束：它属于更早的一轮，或最近一轮已不在运行 / 等待。这样的条目即使还标着
 * 进行中也不会再变（例如中断后没有结果的工具调用），不必再补齐。不知道最近一轮时按未结束算。
 */
export function turnOver(item: AgentItemVo, turn: AgentTurnVo | null): boolean {
  if (item.status === 'expired') return true
  if (!turn || item.turnId == null) return false
  return item.turnId !== turn.id || (turn.status !== 'running' && turn.status !== 'waiting')
}

/**
 * 把一条 `item` / `delta` 事件应用到条目列表；`turn` 事件由调用方处理。返回新列表，
 * 或 `null`：增量文本指向一条还没见过的条目（漏了事件），调用方应从接口补齐。
 */
export function applyItemEvent(
  items: AgentItemVo[],
  ev: Exclude<AgentEvent, { type: 'turn' }>,
): AgentItemVo[] | null {
  if (ev.type === 'item') return mergeItems(items, [ev.item])
  const at = items.findIndex((i) => i.id === ev.itemId)
  const target = items[at]
  // 增量文本只流进回答与推理摘要
  if (!target || (target.kind !== 'assistant' && target.kind !== 'reasoning')) return null
  const next = items.slice()
  next[at] = { ...target, payload: { ...target.payload, text: target.payload.text + ev.delta } }
  return next
}

/**
 * 断线重连或页面重新激活后补齐用的 `afterSeq`：仍在进行中的条目（流式回答、待审批、待回答）
 * 可能在断线期间被改写，所以从最早一条进行中的条目之前开始取；所在轮次已结束的不算（它们不会再变，
 * 算上会每次都从同一处重取）；没有进行中的就从最后一条之后取。
 */
export function catchUpSeq(items: AgentItemVo[], turn: AgentTurnVo | null = null): number {
  const open = items.find(
    (i) => (i.status === 'pending' || i.status === 'running') && !turnOver(i, turn),
  )
  if (open) return open.seq - 1
  return items.at(-1)?.seq ?? 0
}

/**
 * 页面上的一行：工具调用与它的结果合成一张卡片（没有结果且所在轮次已结束时 `stopped`），
 * 其余条目各占一行。
 */
export type ChatRow =
  | {
      key: string
      kind: 'tool'
      call: Item<'tool_call'>
      result: Item<'tool_result'> | null
      stopped: boolean
    }
  | { key: string; kind: 'item'; item: Exclude<AgentItemVo, { kind: 'tool_call' }> }

export function chatRows(items: AgentItemVo[], turn: AgentTurnVo | null = null): ChatRow[] {
  const results = new Map<string, Item<'tool_result'>>()
  const calls = new Set<string>()
  for (const i of items) {
    if (i.kind === 'tool_result') results.set(i.payload.callId, i)
    if (i.kind === 'tool_call') calls.add(i.payload.callId)
  }
  const rows: ChatRow[] = []
  for (const i of items) {
    if (i.kind === 'tool_call') {
      const result = results.get(i.payload.callId) ?? null
      rows.push({
        key: `t${i.id}`,
        kind: 'tool',
        call: i,
        result,
        stopped: !result && turnOver(i, turn),
      })
    }
    // 找不到调用的结果（例如分叉时只复制到一半）单独显示
    else if (i.kind !== 'tool_result' || !calls.has(i.payload.callId))
      rows.push({ key: `i${i.id}`, kind: 'item', item: i })
  }
  return rows
}

export type ThreadGroup = 'pinned' | 'today' | 'week' | 'older'

/** 会话列表分组：置顶的在最前，其余按最后活动时间（没有则按创建时间）分今天、最近 7 天、更早。 */
export function groupThreads(threads: AgentThreadVo[], now = dayjs()) {
  const groups: { key: ThreadGroup; threads: AgentThreadVo[] }[] = [
    { key: 'pinned', threads: [] },
    { key: 'today', threads: [] },
    { key: 'week', threads: [] },
    { key: 'older', threads: [] },
  ]
  const today = now.startOf('day')
  const week = today.subtract(6, 'day')
  for (const th of threads) {
    const at = dayjs(th.lastActiveAt ?? th.createdAt)
    groups[th.pinned ? 0 : at.isBefore(week) ? 3 : at.isBefore(today) ? 2 : 1]!.threads.push(th)
  }
  return groups.filter((g) => g.threads.length)
}

/** 消息里第一个 `$名称`（且是可用技能）：发送时作为本轮加载的技能。 */
export function skillOf(text: string, skills: string[]): string | undefined {
  for (const [, name] of text.matchAll(/(?:^|\s)\$([\p{L}\p{N}][\p{L}\p{N}-]*)/gu))
    if (skills.includes(name!)) return name
  return undefined
}

/** 消息里的 `@<技能标签>:名称` 提及（且是可用技能）：没有 `$名称` 时作为本轮加载的技能。 */
export function mentionedSkill(text: string, label: string, skills: string[]): string | undefined {
  const tag = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const [, name] of text.matchAll(
    new RegExp(`(?:^|\\s)@${tag}:([\\p{L}\\p{N}][\\p{L}\\p{N}-]*)`, 'gu'),
  ))
    if (skills.includes(name!)) return name
  return undefined
}

/** 光标前正在输入的 `@前缀`（提及补全用）；不在 `@` 词里时为 null。 */
export function mentionPrefix(beforeCursor: string): string | null {
  const m = /(?:^|\s)@([^\s@]*)$/u.exec(beforeCursor)
  return m ? m[1]! : null
}

/** 光标前正在输入的 `$前缀`（技能补全用）；不在 `$` 词里时为 null。 */
export function skillPrefix(beforeCursor: string): string | null {
  const m = /(?:^|\s)\$([\p{L}\p{N}-]*)$/u.exec(beforeCursor)
  return m ? m[1]! : null
}

/** 工具参数、字段值等任意 JSON 的显示文字：字符串原样，空值为空串，其余格式化成 JSON。 */
export function show(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

export const SLASH_COMMANDS = [
  'new',
  'compact',
  'model',
  'approvals',
  'plan',
  'skills',
  'prompts',
  'mcp',
  'status',
  'clear',
] as const
export type SlashCommand = (typeof SLASH_COMMANDS)[number]

export interface FormField {
  key: string
  label: string
  description?: string
  type: 'string' | 'number' | 'boolean' | 'enum'
  options: string[]
  required: boolean
}

/**
 * 外部服务器表单（扁平 JSON Schema）的字段：string / number / integer / boolean 与 enum，其余类型
 * 不认识的按文字输入。schema 来自外部，只读取这几个键，不执行任何内容。
 */
export function formFields(schema: Record<string, unknown>): FormField[] {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : []
  return Object.entries(props).map(([key, p]) => {
    const options = Array.isArray(p.enum) ? p.enum.map(String) : []
    const type = options.length
      ? 'enum'
      : p.type === 'number' || p.type === 'integer'
        ? 'number'
        : p.type === 'boolean'
          ? 'boolean'
          : 'string'
    return {
      key,
      label: typeof p.title === 'string' ? p.title : key,
      ...(typeof p.description === 'string' ? { description: p.description } : {}),
      type,
      options,
      required: required.includes(key),
    }
  })
}

const HISTORY_MAX = 100
/** 一条历史最长的字符数（约 2 KB）：更长的消息不记，翻出来半截也没法用 */
const HISTORY_ENTRY_MAX = 2000
const historyKey = (userId: number) => `qw.agent.history.${userId}`

/**
 * 本人在这个标签页里发过的消息（新的在后），输入框 ↑/↓ 与 Ctrl+R 翻看；存储不可用时为空。存在
 * sessionStorage 里、键带用户 id：关掉标签页就没了，同一台电脑上换人登录也看不到上一个人发过什么。
 */
export function loadHistory(userId: number): string[] {
  if (!userId) return []
  try {
    const list: unknown = JSON.parse(sessionStorage.getItem(historyKey(userId)) ?? '[]')
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/**
 * 记下一条发出的消息（去掉与它相同的旧记录，最多 100 条）；临时会话里发的、太长的、没有登录用户时不记；
 * 存储不可用时忽略。返回记下之后的历史。
 */
export function pushHistory(
  userId: number,
  text: string,
  opts: { temporary?: boolean } = {},
): string[] {
  const before = loadHistory(userId)
  if (!userId || opts.temporary || text.length > HISTORY_ENTRY_MAX) return before
  const list = [...before.filter((x) => x !== text), text].slice(-HISTORY_MAX)
  try {
    sessionStorage.setItem(historyKey(userId), JSON.stringify(list))
  } catch {
    // 存储被禁用：本页仍可用，只是不记历史
  }
  return list
}

/** 整个输入框只有 `/前缀` 时，列出匹配的斜杠命令；否则为 null。 */
export function slashMatches(text: string): SlashCommand[] | null {
  const m = /^\/([a-z]*)$/.exec(text.trim())
  return m ? SLASH_COMMANDS.filter((c) => c.startsWith(m[1]!)) : null
}
