import { z } from 'zod'
import { pageQuery } from '../common/pagination.js'
import { fieldDomains } from '../validation/zod-i18n.js'
import { attendanceTimezone, clockRecordVo } from './attendance.schema.js'

export const CLOCK_DAY_ABSENCE_LIMIT = 20
const dayFields = { workDate: z.iso.date().optional(), timezone: attendanceTimezone.optional() }
const dayPage = pageQuery(['id']).omit({ sort: true }).strict()

/** 单日汇总有界分页；本人端不接受替别人查询的身份或部门参数。 */
export const clockMySummaryQuery = dayPage
  .extend(dayFields)
  .register(fieldDomains, { domain: 'oa.clock' })
export const clockSummaryQuery = dayPage
  .extend({
    ...dayFields,
    userId: z.coerce.number().int().positive().optional(),
    deptId: z.coerce.number().int().positive().optional(),
  })
  .register(fieldDomains, { domain: 'oa.clock' })
export type ClockMySummaryQuery = z.output<typeof clockMySummaryQuery>
export type ClockSummaryQuery = z.output<typeof clockSummaryQuery>

/** 关联仅提供批准事实和覆盖区间，不承载事由、目的地、金额或附件。 */
export const clockAbsenceVo = z.object({
  type: z.enum(['leave', 'trip']),
  sourceId: z.number().int().positive(),
  state: z.literal('approved'),
  startAt: z.iso.datetime(),
  endAt: z.iso.datetime(),
})
export const clockDaySummaryVo = z.object({
  userId: z.number().int().positive(),
  deptId: z.number().int().nullable(),
  employeeName: z.string().nullable(),
  deptName: z.string().nullable(),
  checkIn: z.iso.datetime().nullable(),
  checkOut: z.iso.datetime().nullable(),
  recordCount: z.number().int().nonnegative(),
  clockTimezones: z.array(z.string()),
  absences: z.array(clockAbsenceVo).max(CLOCK_DAY_ABSENCE_LIMIT),
  absenceCount: z.number().int().nonnegative(),
  absencesTruncated: z.boolean(),
})
export const clockSummaryPageVo = z.object({
  workDate: z.iso.date(),
  timezone: attendanceTimezone,
  dayStart: z.iso.datetime(),
  dayEnd: z.iso.datetime(),
  items: z.array(clockDaySummaryVo),
  total: z.number().int().nonnegative(),
})
export const clockAdminRecordVo = clockRecordVo.extend({
  employeeName: z.string().nullable(),
  deptName: z.string().nullable(),
})
export type ClockAbsenceVo = z.output<typeof clockAbsenceVo>
export type ClockDaySummaryVo = z.output<typeof clockDaySummaryVo>
export type ClockSummaryPageVo = z.output<typeof clockSummaryPageVo>
export type ClockAdminRecordVo = z.output<typeof clockAdminRecordVo>
