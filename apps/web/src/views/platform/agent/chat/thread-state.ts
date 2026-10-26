import dayjs from 'dayjs'
import { watch } from 'vue'
import type { AgentEvent, AgentItemVo, AgentThreadVo, AgentTurnVo } from '@qiwu/shared'
import { accessToken } from '@/core/request/http'

// 对话页的条目合并、会话内状态、断线补齐、技能与斜杠命令解析。

type Item<K extends AgentItemVo['kind']> = Extract<AgentItemVo, { kind: K }>

/**
 * 按 id 合并条目（后来的整条替换先前的），结果按 seq 排序。服务端在回答与推理摘要结束前存的是空文字，
 * 所以两边都还在运行时保留本页已流入的更长文字，免得补齐时刚显示的内容消失。
 */
export function mergeItems(shown: AgentItemVo[], incoming: AgentItemVo[]): AgentItemVo[] {
  const byId = new Map(shown.map((i) => [i.id, i]))
  for (const i of incoming) {
    const local = byId.get(i.id)
    if (local?.revision !== undefined && (i.revision === undefined || i.revision < local.revision))
      continue
    if (
      local &&
      (local.kind === 'assistant' || local.kind === 'reasoning') &&
      local.kind === i.kind &&
      local.status !== 'running' &&
      i.status === 'running' &&
      (i.revision ?? 0) <= (local.revision ?? 0)
    )
      continue
    const streaming =
      local &&
      (local.kind === 'assistant' || local.kind === 'reasoning') &&
      local.kind === i.kind &&
      local.revision === i.revision &&
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

/** 同一轮的已结束状态不被旧补拉或迟到事件推回运行；新一轮仍按递增 ID 接续。 */
export function mergeTurn(
  shown: AgentTurnVo | null,
  incoming: AgentTurnVo | null,
): AgentTurnVo | null {
  if (!shown || !incoming) return incoming
  if (incoming.id < shown.id) return shown
  if (
    incoming.id === shown.id &&
    !['running', 'waiting'].includes(shown.status) &&
    ['running', 'waiting'].includes(incoming.status)
  )
    return shown
  return incoming
}

/** 同一线程的旧快照不能清掉更新一代的操作风险；跨线程不继承其他会话的标记。 */
export function mergeThread(shown: AgentThreadVo | null, incoming: AgentThreadVo): AgentThreadVo {
  return shown?.id === incoming.id &&
    (shown.recoveryRevision ?? 0) > (incoming.recoveryRevision ?? 0)
    ? {
        ...incoming,
        recoveryRequired: shown.recoveryRequired,
        recoveryRevision: shown.recoveryRevision,
      }
    : incoming
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
  if (ev.revision !== undefined || ev.offset !== undefined) {
    if (
      !Number.isSafeInteger(ev.revision) ||
      !Number.isSafeInteger(ev.offset) ||
      ev.revision! < 0 ||
      ev.offset! < 0
    )
      return null
    const revision = target.revision ?? 0
    if (ev.revision! < revision) return items
    if (target.status !== 'running') return ev.revision! <= revision ? items : null
    const text = target.payload.text
    if (ev.offset! > text.length) return null
    const overlap = Math.min(text.length - ev.offset!, ev.delta.length)
    if (text.slice(ev.offset!, ev.offset! + overlap) !== ev.delta.slice(0, overlap)) return null
    const next = items.slice()
    next[at] = {
      ...target,
      revision: Math.max(revision, ev.revision!),
      payload: { ...target.payload, text: text + ev.delta.slice(overlap) },
    }
    return next
  }
  // 新协议条目不能再混入无位置的旧增量，否则重复投递会把同一段追加两次。
  if (target.revision !== undefined) return null
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
const historyKey = (userId: number, tenantId = 1) => `${tenantId}:${userId}`
const inputHistory = new Map<string, string[]>()

/** 升级后移除旧版本的明文输入历史；新历史仅留当前页面运行内存。 */
export function clearHistory(userId?: number, tenantId = 1): void {
  if (userId === undefined) inputHistory.clear()
  else inputHistory.delete(historyKey(userId, tenantId))
  for (const name of ['sessionStorage', 'localStorage'] as const)
    try {
      const storage = globalThis[name]
      for (let at = storage.length - 1; at >= 0; at--) {
        const key = storage.key(at)
        if (key?.startsWith('qw.agent.history.')) storage.removeItem(key)
      }
    } catch {
      // 隐私模式可能不允许访问存储，内存历史仍可正常使用。
    }
}

/**
 * 本人在这个标签页里发过的消息（新的在后），输入框 ↑/↓ 与 Ctrl+R 翻看；存储不可用时为空。存在
 * 页面运行内存里，按用户与租户隔离；不再把业务正文写入浏览器存储。
 */
export function loadHistory(userId: number, tenantId = 1): string[] {
  if (!userId) return []
  return [...(inputHistory.get(historyKey(userId, tenantId)) ?? [])]
}

/**
 * 记下一条发出的消息（去掉与它相同的旧记录，最多 100 条）；临时会话里发的、太长的、没有登录用户时不记；
 * 返回记下之后的内存历史。
 */
export function pushHistory(
  userId: number,
  text: string,
  opts: { temporary?: boolean; tenantId?: number } = {},
): string[] {
  const before = loadHistory(userId, opts.tenantId)
  if (!userId || opts.temporary || text.length > HISTORY_ENTRY_MAX) return before
  const list = [...before.filter((x) => x !== text), text].slice(-HISTORY_MAX)
  inputHistory.set(historyKey(userId, opts.tenantId), list)
  return list
}

export interface PendingDeliveryIds {
  clientDraftId: string
  clientMessageId: string
  threadId: number | null
}
const deliveryKey = (actor: string) => `qw.agent.delivery.${actor}`
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 仅存少量非内容标识，刷新后先查询回执，绝不恢复或自动重发明文消息。 */
export function saveDelivery(actor: string, pending: PendingDeliveryIds | null): boolean {
  try {
    if (!pending) sessionStorage.removeItem(deliveryKey(actor))
    else
      sessionStorage.setItem(
        deliveryKey(actor),
        JSON.stringify({
          clientDraftId: pending.clientDraftId,
          clientMessageId: pending.clientMessageId,
          threadId: pending.threadId,
        }),
      )
    return true
  } catch {
    // 存储禁用时只保证当前挂载期间的身份不变，不能伪称刷新后仍能恢复。
  }
  return false
}

export function loadDelivery(actor: string): PendingDeliveryIds | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(deliveryKey(actor)) ?? 'null')
    if (
      value &&
      uuid.test(value.clientDraftId) &&
      uuid.test(value.clientMessageId) &&
      (value.threadId === null || (Number.isSafeInteger(value.threadId) && value.threadId > 0))
    )
      return {
        clientDraftId: value.clientDraftId,
        clientMessageId: value.clientMessageId,
        threadId: value.threadId,
      }
  } catch {
    // 损坏或旧版本标识不能变成一次新的写入。
  }
  saveDelivery(actor, null)
  return null
}

// 即使聊天窗口已卸载，退出登录也清掉内存历史和本标签页回执标识。
watch(
  accessToken,
  (token) => {
    if (token) return
    clearHistory()
    try {
      for (let at = sessionStorage.length - 1; at >= 0; at--) {
        const key = sessionStorage.key(at)
        if (key?.startsWith('qw.agent.delivery.')) sessionStorage.removeItem(key)
      }
    } catch {
      /* 存储不可用时不读取任何旧数据。 */
    }
  },
  { flush: 'sync' },
)

/** 整个输入框只有 `/前缀` 时，列出匹配的斜杠命令；否则为 null。 */
export function slashMatches(text: string): SlashCommand[] | null {
  const m = /^\/([a-z]*)$/.exec(text.trim())
  return m ? SLASH_COMMANDS.filter((c) => c.startsWith(m[1]!)) : null
}
