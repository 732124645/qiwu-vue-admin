import { AGENT_SKILL_BODY_MAX, AGENT_SKILL_NAME, Err } from '@qiwu/shared'
import { BizError } from '../../http/biz-error.js'

/** A skill as a `SKILL.md` carries it. */
export interface SkillMd {
  name: string
  description: string
  tools: string[] | null
  body: string
}

const KEYS = new Set(['name', 'description', 'tools'])
const invalid = (reason: string) => new BizError(Err.AGENT_SKILL_INVALID, { reason })

/**
 * 一个标量：双引号按 JSON 字符串解析，单引号里 `''` 是一个单引号，其余按普通文本；YAML 的锚点、别名、
 * 标签、块标量与流式映射一律拒绝（只认这一小部分写法，不跑任何通用 YAML 解析）。
 */
function scalar(raw: string): string {
  const v = raw.trim()
  if (v.startsWith('"')) {
    try {
      const s: unknown = JSON.parse(v)
      if (typeof s === 'string') return s
    } catch {
      // 落到下面的 syntax
    }
    throw invalid('syntax')
  }
  if (v.startsWith("'")) {
    if (v.length < 2 || !v.endsWith("'") || /(^|[^\x27])\x27([^\x27]|$)/.test(v.slice(1, -1)))
      throw invalid('syntax')
    return v.slice(1, -1).replace(/''/g, "'")
  }
  if (/^[&*!|>%@\x60{[\]]/.test(v)) throw invalid('syntax')
  return v
}

/** 行内列表 `[a, "b"]`（不支持嵌套）。 */
function inlineList(raw: string): string[] {
  const inner = raw.trim().slice(1, -1).trim()
  if (!inner) return []
  return inner.split(',').map((s) => {
    if (!s.trim()) throw invalid('syntax')
    return scalar(s)
  })
}

/**
 * 解析 `SKILL.md`：开头是 `---` 包起来的前言，只允许 `name`、`description`、可选的 `tools`（行内列表或
 * `- 项` 列表），之后是正文。格式不对、出现别的键、名称 / 描述 / 正文 / 工具不合规都报 AGENT_SKILL_INVALID
 * （原因码说明哪一项）。技能只是说明文字：这里不求值、不执行任何内容。
 */
export function parseSkillMd(text: string): SkillMd {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
  if (lines[0]?.trim() !== '---') throw invalid('front_matter')
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (end < 0) throw invalid('front_matter')
  const meta: Record<string, string | string[]> = {}
  let list: string[] | null = null
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const item = /^\s+-\s+(.*)$/.exec(line)
    if (item) {
      if (!list) throw invalid('syntax')
      list.push(scalar(item[1]!))
      continue
    }
    const kv = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(line)
    if (!kv) throw invalid('syntax')
    const [, key, value = ''] = kv as unknown as [string, string, string | undefined]
    if (!KEYS.has(key)) throw invalid('unknown_key')
    if (key in meta) throw invalid('duplicate_key')
    list = null
    if (key === 'tools') {
      const v = value.trim()
      if (!v) meta.tools = list = []
      else if (v.startsWith('[') && v.endsWith(']')) meta.tools = inlineList(v)
      else throw invalid('tools')
    } else meta[key] = scalar(value)
  }
  const name = typeof meta.name === 'string' ? meta.name.trim() : ''
  const description = typeof meta.description === 'string' ? meta.description.trim() : ''
  const body = lines
    .slice(end + 1)
    .join('\n')
    .trim()
  const tools = Array.isArray(meta.tools) ? meta.tools.map((t) => t.trim()) : null
  if (!AGENT_SKILL_NAME.test(name)) throw invalid('name')
  if (!description || description.length > 512) throw invalid('description')
  if (!body || body.length > AGENT_SKILL_BODY_MAX) throw invalid('body')
  if (tools && (tools.length > 100 || tools.some((t) => !t || t.length > 160)))
    throw invalid('tools')
  return { name, description, tools, body }
}

/** 导出为 `SKILL.md`：字符串一律写成 JSON 双引号形式（也是合法的 YAML），能被 {@link parseSkillMd} 原样读回。 */
export function formatSkillMd(s: SkillMd): string {
  const head = [
    '---',
    `name: ${s.name}`,
    `description: ${JSON.stringify(s.description)}`,
    ...(s.tools ? [`tools: [${s.tools.map((t) => JSON.stringify(t)).join(', ')}]`] : []),
    '---',
  ]
  return `${head.join('\n')}\n\n${s.body}\n`
}
