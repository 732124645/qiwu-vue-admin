import type {
  AgentItemPayloads,
  AgentItemVo,
  AgentThreadVo,
  AgentTurnStatus,
  AgentTurnVo,
} from '@qiwu/shared'
import { MASK, redactedJson } from '../../redact.js'
import type { AgentThread, AgentTurn } from '../entities/agent-thread.entity.js'

/** bigint 列可能以字符串读出：统一转成数字。 */
export const num = (v: unknown): number => Number(v)

const iso = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null

/** 会话行 → 接口形状；未读数与最新一轮状态由调用方另行算好传入。 */
export function threadVo(
  t: AgentThread,
  extra: { unread: number; turnStatus: AgentTurnStatus | null },
): AgentThreadVo {
  return {
    id: num(t.id),
    title: t.title,
    status: t.status,
    providerId: t.providerId === null ? null : num(t.providerId),
    model: t.model,
    reasoning: t.reasoning,
    approvalMode: t.approvalMode,
    planMode: !!t.planMode,
    pinned: !!t.pinned,
    temporary: !!t.temporary,
    unread: extra.unread,
    // shareToken 默认不查出：只有显式 addSelect 的查询才会带上它
    shared: !!t.shareToken,
    forkedFromId: t.forkedFromId === null ? null : num(t.forkedFromId),
    profileId: t.profileId == null ? null : num(t.profileId),
    memoryEnabled: t.memoryEnabled !== false,
    parentThreadId: t.parentThreadId == null ? null : num(t.parentThreadId),
    automationRunId: t.automationRunId == null ? null : num(t.automationRunId),
    batchId: t.batchId === null ? null : num(t.batchId),
    turnStatus: extra.turnStatus,
    lastActiveAt: iso(t.lastActiveAt),
    createdAt: iso(t.createdAt)!,
  }
}

/** 轮次行 → 接口形状。 */
export function turnVo(t: AgentTurn): AgentTurnVo {
  return {
    id: num(t.id),
    threadId: num(t.threadId),
    status: t.status,
    steps: t.steps,
    promptTokens: t.promptTokens,
    completionTokens: t.completionTokens,
    error: t.errorCode ? { code: t.errorCode, message: t.errorMsg ?? '' } : null,
    startedAt: iso(t.startedAt)!,
    endedAt: iso(t.endedAt),
  }
}

/** 条目行 → 接口形状：与运行时同一个映射，去掉只给运行时用的 `internal`（工具完整输出、来源、信任键）。 */
export { itemVo } from '../runtime/item-store.js'

/** 工具参数按操作日志的规则遮蔽密钥字段（任意深度），再限长：导出与分享都不带出密钥。 */
export const maskedArgs = (args: unknown, max = 2000): string => redactedJson(args, max) ?? MASK

/**
 * 分享查看者（不是会话主人）的条目视图：只留用户与智能体的文字、工具标题与状态。推理条目整条去掉；工具
 * 调用参数、结果预览与错误说明、审批的参数、改动明细、来源、备注与缺的权限点、问答的问题、回答与表单、
 * 用户消息带的页面上下文与附件信息、错误条目的说明一律隐去（错误码保留）。工具输出是按会话主人的数据权限
 * 读出来的，查看者即使有同一个工具的权限，数据范围也可能更小，所以不按工具权限放行——分享出去的是对话，
 * 不是主人的数据。
 */
export function sharedItems(items: AgentItemVo[]): AgentItemVo[] {
  return items.filter((i) => i.kind !== 'reasoning').map(sharedItem)
}

/** {@link sharedItems} 的单个条目。 */
function sharedItem(i: AgentItemVo): AgentItemVo {
  if (i.kind === 'user') {
    const { context: _c, attachments: _a, ...rest } = i.payload
    return { ...i, payload: rest }
  }
  if (i.kind === 'tool_call') return { ...i, payload: { ...i.payload, args: null } }
  if (i.kind === 'tool_result') {
    const { error, ...rest } = i.payload
    return {
      ...i,
      payload: {
        ...rest,
        preview: '',
        ...(error && { error: { code: error.code, message: '' } }),
      },
    }
  }
  if (i.kind === 'approval') {
    const { changes: _c, note: _n, blocked, ...rest } = i.payload
    return {
      ...i,
      payload: {
        ...rest,
        args: null,
        sources: [],
        ...(blocked && { blocked: { reason: blocked.reason } }),
      },
    }
  }
  if (i.kind === 'question') {
    const { form: _f, answers: _a, ...rest } = i.payload
    return { ...i, payload: { ...rest, questions: [] } }
  }
  if (i.kind === 'error') return { ...i, payload: { code: i.payload.code, message: '' } }
  return i
}

/** 分享查看者看到的轮次：错误只留错误码，说明隐去。 */
export const sharedTurn = (t: AgentTurnVo): AgentTurnVo =>
  t.error ? { ...t, error: { code: t.error.code, message: '' } } : t

/** 平台参数 `agent.trust_mode`：只有（去空白、不分大小写）恰好是 `false` 才关闭，缺失或其他值都算打开。 */
export const trustModeOn = (raw: string | null | undefined): boolean =>
  raw?.trim().toLowerCase() !== 'false'

/** 导出用到的界面文字（调用方按调用者语言翻译）。 */
export type ExportLabel =
  | 'user'
  | 'assistant'
  | 'tool'
  | 'ok'
  | 'failed'
  | 'approval'
  | 'question'
  | 'answer'
  | 'plan'
  | 'error'
  | 'compaction'

/**
 * 会话导出为 Markdown：用户与智能体的消息原文，工具只给标题、是否成功与遮蔽后的参数（结果内容不导出），
 * 审批给工具、遮蔽后的参数与决定，问答给问题与回答，计划给清单；推理摘要不导出。
 */
export function threadMarkdown(
  title: string,
  items: AgentItemVo[],
  l: (k: ExportLabel) => string,
): string {
  const out: string[] = [`# ${title}`, '']
  const toolOf = new Map<string, string>()
  for (const i of items) {
    switch (i.kind) {
      case 'user':
        out.push(`## ${l('user')}`, '', i.payload.text, '')
        break
      case 'assistant': {
        const p: AgentItemPayloads['assistant'] = i.payload
        out.push(`## ${l('assistant')}`, '', p.text, '')
        for (const c of p.citations ?? []) out.push(`- [${c.title}](${c.url})`)
        if (p.citations?.length) out.push('')
        break
      }
      case 'tool_call':
        toolOf.set(i.payload.callId, i.payload.title || i.payload.tool)
        out.push(
          `> ${l('tool')}: ${i.payload.title || i.payload.tool} \`${maskedArgs(i.payload.args)}\``,
          '',
        )
        break
      case 'tool_result':
        out.push(
          `> ${toolOf.get(i.payload.callId) ?? l('tool')}: ${i.payload.ok ? l('ok') : l('failed')}${
            i.payload.error ? ` (${i.payload.error.message})` : ''
          }`,
          '',
        )
        break
      case 'approval':
        out.push(
          `> ${l('approval')}: ${i.payload.title || i.payload.tool} \`${maskedArgs(i.payload.args)}\` → ${
            i.payload.decision ?? i.status ?? ''
          }`,
          '',
        )
        break
      case 'question':
        out.push(`## ${l('question')}`, '')
        for (const q of i.payload.questions) out.push(`- ${q.header}: ${q.question}`)
        for (const a of i.payload.answers ?? [])
          out.push(
            `- ${l('answer')} ${a.header}: ${[...a.selected, a.other ?? ''].filter(Boolean).join(', ')}`,
          )
        out.push('')
        break
      case 'plan':
        out.push(`## ${l('plan')}`, '')
        for (const s of i.payload.steps)
          out.push(`- [${s.status === 'done' ? 'x' : ' '}] ${s.text}`)
        out.push('')
        break
      case 'compaction':
        out.push(`> ${l('compaction')}`, '')
        break
      case 'error':
        out.push(`> ${l('error')}: ${i.payload.message}`, '')
        break
      default:
        // reasoning：模型的推理摘要不导出
        break
    }
  }
  return out.join('\n')
}

/**
 * 关键词 → 全文索引的布尔模式查询：去掉布尔运算符，每个词作为必须出现的短语（ngram 分词下中文按相邻
 * 字切分，短语保证字序）；没有可用词时为空串。值始终作为参数绑定，不拼进 SQL。
 */
export const fulltextTerms = (keyword: string): string =>
  keyword
    .split(/\s+/)
    .map((w) => w.replace(/[+\-<>()~*"@]/g, ''))
    .filter(Boolean)
    .map((w) => `+"${w}"`)
    .join(' ')
