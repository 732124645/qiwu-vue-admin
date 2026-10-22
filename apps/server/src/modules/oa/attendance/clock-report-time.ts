import { ValidationException } from '../../../core/http/validation.pipe.js'

/** 用日期而非固定24小时找自然日边界，覆盖夏令时23/25小时及午夜跳变。 */
export function clockDayBounds(workDate: string, timezone: string): { start: Date; end: Date } {
  const anchor = Date.parse(`${workDate}T00:00:00.000Z`)
  if (!Number.isFinite(anchor))
    throw new ValidationException([
      { code: 'custom', path: ['workDate'], message: 'validation.invalid' },
    ])
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    era: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const keyAt = (time: number) => {
    const parts = formatter.formatToParts(time)
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value
    const eraYear = Number(part('year'))
    const year = part('era') === 'BC' ? 1 - eraYear : eraYear
    return year * 10000 + Number(part('month')) * 100 + Number(part('day'))
  }
  const key = (time: number) => {
    const date = new Date(time)
    return date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate()
  }
  const first = (utcDay: number) => {
    let low = utcDay - 48 * 3600000
    let high = utcDay + 48 * 3600000
    const target = key(utcDay)
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if (keyAt(middle) < target) low = middle + 1
      else high = middle
    }
    return { time: low, exists: keyAt(low) === target }
  }
  const start = first(anchor)
  const end = first(anchor + 86400000)
  const startDate = new Date(start.time)
  const endDate = new Date(end.time)
  if (!start.exists || startDate.getUTCFullYear() < 1000 || endDate.getUTCFullYear() > 9999)
    throw new ValidationException([
      { code: 'custom', path: ['workDate'], message: 'validation.invalid' },
    ])
  return { start: startDate, end: endDate }
}

/** 保留期按日历日回退，避免夏令时切换把当天或临界日误删。 */
export function clockCutoffDay(workDate: string, retentionDays: number): string {
  return new Date(Date.parse(`${workDate}T00:00:00.000Z`) - retentionDays * 86400000)
    .toISOString()
    .slice(0, 10)
}
