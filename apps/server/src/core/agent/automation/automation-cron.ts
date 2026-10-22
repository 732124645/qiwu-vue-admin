import { AGENT_AUTOMATION_MIN_INTERVAL_MIN } from '@qiwu/shared'
import { CronTime, validateCronExpression } from 'cron'

/** 5 段 cron：每段只有数字与 `* , - /`（不收名字、`?`、`L` 之类与秒段）。 */
const FIELD = /^[\d*,\-/]+$/
/** 检查最短间隔时最多看接下来这么多次触发，且不超过一年（足以跨过小时、日、周、月的边界）。 */
const LOOKAHEAD = 500
const HORIZON_MS = 366 * 24 * 3600_000

/** 时区是不是运行环境认识的 IANA 名字。 */
export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return tz.includes('/') || tz === 'UTC'
  } catch {
    return false
  }
}

/**
 * 校验一个定时：须是 5 段、cron 库能解析、在时区里确实会触发，且相邻两次触发至少隔
 * {@link AGENT_AUTOMATION_MIN_INTERVAL_MIN} 分钟。返回出错的原因（`invalid` 或 `too_often`），合格为 null。
 * 间隔按接下来至多 {@link LOOKAHEAD} 次、一年之内的触发的 UTC 时刻算：夏令时切换时重复的本地小时不会被误判
 * 为过密；一年一次的定时只看到一次触发，自然合格。
 */
export function cronProblem(cron: string, tz: string): 'invalid' | 'too_often' | null {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5 || !fields.every((f) => FIELD.test(f))) return 'invalid'
  if (!validateCronExpression(cron).valid) return 'invalid'
  const times: number[] = []
  try {
    const ct = new CronTime(cron, tz)
    const until = Date.now() + HORIZON_MS
    let at = ct.getNextDateFrom(new Date())
    while (times.length < LOOKAHEAD && at.toMillis() <= until) {
      times.push(at.toMillis())
      at = ct.getNextDateFrom(at.toJSDate())
    }
  } catch {
    return 'invalid'
  }
  if (!times.length) return 'invalid'
  const min = AGENT_AUTOMATION_MIN_INTERVAL_MIN * 60_000
  for (let i = 1; i < times.length; i++) if (times[i]! - times[i - 1]! < min) return 'too_often'
  return null
}

/** 下一次触发的时刻（不合格的定时为 null）。 */
export function nextFire(cron: string, tz: string): Date | null {
  try {
    const [next] = new CronTime(cron, tz).sendAt(1)
    return next ? next.toJSDate() : null
  } catch {
    return null
  }
}
