import { z } from 'zod'
import { pageQuery } from '../common/pagination.js'
import { fieldDomains } from '../validation/zod-i18n.js'

export const attendancePolicyPerms = {
  view: 'oa.attendance-policy.view',
  modify: 'oa.attendance-policy.modify',
} as const
export const attendanceSitePerms = {
  browse: 'oa.attendance-site.browse',
  view: 'oa.attendance-site.view',
  create: 'oa.attendance-site.create',
  modify: 'oa.attendance-site.modify',
  remove: 'oa.attendance-site.remove',
} as const
export const clockPerms = { browse: 'oa.clock.browse', view: 'oa.clock.view' } as const

export const ATTENDANCE_LOCATION_MODES = ['none', 'site'] as const
export const CLOCK_ACTIONS = ['check_in', 'check_out'] as const
export const CLOCK_VALIDATION_RESULTS = ['not_required', 'passed'] as const
export const attendanceLocationMode = z.enum(ATTENDANCE_LOCATION_MODES)
export const clockAction = z.enum(CLOCK_ACTIONS)
export type AttendanceLocationMode = z.infer<typeof attendanceLocationMode>
export type ClockAction = z.infer<typeof clockAction>

/** 工作日时区只接受运行环境能识别的 IANA 名称，不允许用户提交任意时区偏移。 */
export const attendanceTimezone = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(
    (value) => {
      if (!/^[A-Za-z_][A-Za-z0-9_+./-]*$/.test(value)) return false
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0)
        return true
      } catch {
        return false
      }
    },
    { error: 'validation.invalid' },
  )

const policyFields = {
  enabled: z.boolean(),
  timezone: attendanceTimezone,
  locationMode: attendanceLocationMode,
  retentionDays: z.number().int().min(30).max(730),
}
export const attendancePolicyCreate = z
  .strictObject(policyFields)
  .register(fieldDomains, { domain: 'oa.attendancePolicy' })
export const attendancePolicyUpdate = attendancePolicyCreate
  .partial()
  .register(fieldDomains, { domain: 'oa.attendancePolicy' })
export type AttendancePolicyCreate = z.output<typeof attendancePolicyCreate>
export type AttendancePolicyUpdate = z.output<typeof attendancePolicyUpdate>
export type AttendancePolicySnapshot = AttendancePolicyCreate & { site?: AttendanceSiteSnapshot }

const auditVo = {
  id: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  createdBy: z.number().int().nullable(),
  updatedBy: z.number().int().nullable(),
}
export const attendancePolicyVo = z.object({ ...auditVo, ...policyFields })
export type AttendancePolicyVo = z.output<typeof attendancePolicyVo>

/** 地点配置以十进制文本传输，规范为六位小数，避免持久化时暗中换算坐标。 */
function coordinate(limit: number) {
  return z
    .string()
    .regex(/^-?(?:0|[1-9]\d{0,2})(?:\.\d{1,6})?$/)
    .refine((value) => Math.abs(Number(value)) <= limit, { error: 'validation.invalid' })
    .transform((value) => {
      const negative = value.startsWith('-')
      const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.')
      const digits = fraction.padEnd(6, '0')
      return `${negative && (whole !== '0' || /[1-9]/.test(digits)) ? '-' : ''}${whole}.${digits}`
    })
}
const siteFields = {
  name: z.string().trim().min(1).max(100),
  latitude: coordinate(90),
  longitude: coordinate(180),
  radiusM: z.number().int().min(50).max(10000),
  maxAccuracyM: z.number().int().min(5).max(1000),
  enabled: z.boolean(),
}
export const attendanceSiteCreate = z
  .strictObject(siteFields)
  .register(fieldDomains, { domain: 'oa.attendanceSite' })
export const attendanceSiteUpdate = attendanceSiteCreate
  .partial()
  .register(fieldDomains, { domain: 'oa.attendanceSite' })
export type AttendanceSiteCreate = z.output<typeof attendanceSiteCreate>
export type AttendanceSiteUpdate = z.output<typeof attendanceSiteUpdate>
export const attendanceSiteQuery = pageQuery(['id', 'name', 'createdAt'])
  .strict()
  .extend({
    name: z.string().trim().max(100).optional(),
    enabled: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
  })
  .register(fieldDomains, { domain: 'oa.attendanceSite' })
export type AttendanceSiteQuery = z.output<typeof attendanceSiteQuery>
export const attendanceSiteVo = z.object({ ...auditVo, ...siteFields })
export type AttendanceSiteVo = z.output<typeof attendanceSiteVo>

/** 固定办公地点快照，只保存管理员配置的地点，不包含员工当次坐标。 */
export const attendanceSiteSnapshot = attendanceSiteCreate
  .omit({ enabled: true })
  .extend({ id: z.number().int().positive() })
export type AttendanceSiteSnapshot = z.output<typeof attendanceSiteSnapshot>
export const attendanceSiteOptionQuery = pageQuery(['id', 'name'])
  .strict()
  .extend({ name: z.string().trim().max(100).optional() })
export type AttendanceSiteOptionQuery = z.output<typeof attendanceSiteOptionQuery>

/** 只接收动作、请求标识与一次定位；身份、时刻、工作日和来源由服务端决定。 */
export const clockPunch = z
  .strictObject({
    action: clockAction,
    requestId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
    position: z
      .strictObject({
        siteId: z.number().int().positive(),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        accuracyM: z.number().positive().max(10000),
      })
      .optional(),
  })
  .register(fieldDomains, { domain: 'oa.clock' })
export type ClockPunch = z.output<typeof clockPunch>

const dateRange = {
  workDateFrom: z.iso.date().optional(),
  workDateTo: z.iso.date().optional(),
  action: clockAction.optional(),
}
export const clockMyQuery = pageQuery(['id', 'workDate', 'punchedAt', 'action'])
  .strict()
  .extend(dateRange)
  .register(fieldDomains, { domain: 'oa.clock' })
export const clockQuery = pageQuery(['id', 'workDate', 'punchedAt', 'action'])
  .strict()
  .extend({
    ...dateRange,
    userId: z.coerce.number().int().positive().optional(),
    deptId: z.coerce.number().int().positive().optional(),
  })
  .register(fieldDomains, { domain: 'oa.clock' })
export type ClockMyQuery = z.output<typeof clockMyQuery>
export type ClockQuery = z.output<typeof clockQuery>

/** 公开记录仅有校验结果与规则快照，不返回请求摘要或员工原始坐标。 */
export const clockRecordVo = z.object({
  id: z.number().int().positive(),
  userId: z.number().int().positive(),
  deptId: z.number().int().nullable(),
  workDate: z.iso.date(),
  action: clockAction,
  punchedAt: z.iso.datetime(),
  timezone: attendanceTimezone,
  policyId: z.number().int().positive(),
  policySnapshot: attendancePolicyCreate,
  siteId: z.number().int().nullable(),
  siteName: z.string().nullable(),
  siteSnapshot: attendanceSiteSnapshot.nullable().default(null),
  distanceM: z.number().int().nonnegative().nullable(),
  accuracyM: z.string().nullable(),
  validationResult: z.enum(CLOCK_VALIDATION_RESULTS),
  source: z.literal('native'),
  requestId: z.string(),
})
export type ClockRecordVo = z.output<typeof clockRecordVo>

/** 今日摘要供员工移动端使用，不暴露管理审计字段或内部请求摘要。 */
export const clockTodayVo = z.object({
  serverAt: z.iso.datetime(),
  workDate: z.iso.date(),
  policy: z.object({
    id: z.number().int().positive(),
    enabled: z.boolean(),
    timezone: attendanceTimezone,
    locationMode: attendanceLocationMode,
  }),
  checkIn: clockRecordVo.nullable(),
  checkOut: clockRecordVo.nullable(),
})
export type ClockTodayVo = z.output<typeof clockTodayVo>
export const clockRequestId = clockPunch.shape.requestId
