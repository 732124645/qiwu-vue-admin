import dayjs from 'dayjs'
import type { AgentUsageQuery, AgentUsageRowVo } from '@qiwu/shared'

/** 积分是最多 6 位小数的定点字符串；换成百万分之一的整数，汇总时不经浮点数相加。 */
const toMicro = (credits: string) => {
  const [whole, fraction = ''] = credits.split('.')
  return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0').slice(0, 6))
}
const fromMicro = (micro: bigint) => {
  const fraction = (micro % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return `${micro / 1_000_000n}${fraction ? `.${fraction}` : ''}`
}

/** 各分组积分的精确合计（保留全部小数，悬停时给管理员核对）。 */
export const sumCredits = (rows: Pick<AgentUsageRowVo, 'credits'>[]) =>
  fromMicro(rows.reduce((sum, row) => sum + toMicro(row.credits), 0n))

/**
 * 页面上显示的积分：四舍五入到最多 2 位小数并去掉末尾的 0，整数部分加千分位；
 * 大于 0 但不到 0.01 时显示“<0.01”，不让少量消耗看起来像没花。
 */
export function formatCredits(credits: string) {
  const micro = toMicro(credits)
  const cents = (micro + 5_000n) / 10_000n
  if (micro > 0n && cents === 0n) return '<0.01'
  const fraction = (cents % 100n).toString().padStart(2, '0').replace(/0+$/, '')
  return `${(cents / 100n).toLocaleString()}${fraction ? `.${fraction}` : ''}`
}

export type IntegrityKind = 'unpriced' | 'unreported' | 'legacy'
const INTEGRITY: [IntegrityKind, 'unpricedCalls' | 'unreportedCalls' | 'legacyCalls'][] = [
  ['unpriced', 'unpricedCalls'],
  ['unreported', 'unreportedCalls'],
  ['legacy', 'legacyCalls'],
]
/** 数据完整性提示：未设价格、未返回用量、早期无明细三类调用各合计多少次；为 0 的不提示。 */
export const integrityNotes = (rows: AgentUsageRowVo[]) =>
  INTEGRITY.map(([kind, prop]) => ({
    kind,
    count: rows.reduce((sum, row) => sum + row[prop], 0),
  })).filter((note) => note.count > 0)

/** 已知 token 的合计；有分组未知时 `partial` 为真，页面注明“部分未知”而不是把未知当 0。 */
export function sumTokens(rows: AgentUsageRowVo[], prop: 'promptTokens' | 'completionTokens') {
  return rows.reduce(
    (acc, row) => {
      const value = row[prop]
      return value == null
        ? { ...acc, partial: true }
        : { ...acc, total: acc.total + value, known: true }
    },
    { total: 0, partial: false, known: false },
  )
}

/** 用量最多的一组：先比积分，积分相同比调用次数；没有数据时为 undefined。 */
export const topRow = (rows: AgentUsageRowVo[]) =>
  rows.reduce<AgentUsageRowVo | undefined>((best, row) => {
    if (!best) return row
    const diff = toMicro(row.credits) - toMicro(best.credits)
    return diff > 0n || (diff === 0n && row.calls > best.calls) ? row : best
  }, undefined)

/**
 * 图表的点：按日分组时把日期范围内每一天都补出来（没有调用的日子记 0），只有一两天有数据时
 * 横轴仍是完整的日期，不会只剩一根柱子；按用户、按模型时原样使用接口返回的分组。
 */
export function chartPoints(
  rows: AgentUsageRowVo[],
  groupBy: AgentUsageQuery['groupBy'],
  [from, to]: [string, string],
) {
  const point = (row: AgentUsageRowVo) => ({
    label: row.label,
    credits: Number(row.credits),
    calls: row.calls,
  })
  if (groupBy !== 'day') return rows.map(point)
  const byDay = new Map(rows.map((row) => [row.key, row]))
  const points = []
  // 逐日补齐：范围很长（几年）时横轴会很密，需要时再按周或按月聚合
  for (let d = dayjs(from); !d.isAfter(to, 'day'); d = d.add(1, 'day')) {
    const key = d.format('YYYY-MM-DD')
    const row = byDay.get(key)
    points.push(row ? point(row) : { label: key, credits: 0, calls: 0 })
  }
  return points
}
