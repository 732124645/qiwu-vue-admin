import {
  DEFAULT_PASSWORD_POLICY,
  PASSWORD_MAX_BYTES,
  type PasswordPolicy,
} from './password-policy.js'

/**
 * Runtime parameters (`cfg_param.param_key`). Values are stored as strings;
 * readers parse them and fall back to the defaults here when a row is missing or invalid.
 */

/** Sign-in lockout (see docs/design-notes.md#auth-sessions, #security). */
export interface LoginSecurity {
  /** failed sign-ins of one username+IP pair before that pair is locked */
  lockThreshold: number
  /** how long a username+IP pair stays locked */
  lockMinutes: number
  /** failures of one username across all IPs within an hour before a captcha ticket is required */
  crossIpThreshold: number
}

export const DEFAULT_LOGIN_SECURITY: LoginSecurity = {
  lockThreshold: 5,
  lockMinutes: 10,
  crossIpThreshold: 10,
}

export const loginSecurityParams = {
  lockThreshold: 'auth.lock_threshold',
  lockMinutes: 'auth.lock_minutes',
  crossIpThreshold: 'auth.cross_ip_threshold',
} as const satisfies Record<keyof LoginSecurity, string>

/** One row per `PasswordPolicy` field; defaults in `DEFAULT_PASSWORD_POLICY`. */
export const passwordPolicyParams = {
  minLength: 'iam.password_min_length',
  charClasses: 'iam.password_char_classes',
  expireDays: 'iam.password_expire_days',
} as const satisfies Record<keyof PasswordPolicy, string>

/** Parse cfg_param password settings with the same bounds on server and public forms. */
export function passwordPolicyOf(get: (key: string) => string | null | undefined): PasswordPolicy {
  const int = (raw: string | null | undefined, min: number, max: number, fallback: number) => {
    const n = Number(raw)
    return raw?.trim() && Number.isInteger(n) && n >= min && n <= max ? n : fallback
  }
  const p = DEFAULT_PASSWORD_POLICY
  return {
    minLength: int(get(passwordPolicyParams.minLength), 8, PASSWORD_MAX_BYTES, p.minLength),
    charClasses: int(get(passwordPolicyParams.charClasses), 0, 4, p.charClasses),
    expireDays: int(get(passwordPolicyParams.expireDays), 0, 3650, p.expireDays),
  }
}

/** Public signup defaults; role and dept are server-owned settings, never request fields. */
export const signupParams = {
  enabled: 'auth.signup.enabled',
  defaultRoleId: 'auth.signup.default_role_id',
  defaultDeptId: 'auth.signup.default_dept_id',
} as const
export const DEFAULT_SIGNUP = {
  enabled: false,
  defaultDeptId: null,
} as const

/** IANA zone for server-rendered times when neither `X-Timezone` nor `iam_user.timezone` is known (see docs/design-notes.md#api-envelope). */
export const DEFAULT_TIMEZONE_PARAM = 'core.default_timezone'
export const DEFAULT_TIMEZONE = 'Asia/Shanghai'

/**
 * Sign-in IP blacklist (see docs/design-notes.md#auth-sessions): IPv4/IPv6 addresses and CIDR subnets separated by commas, spaces or
 * line breaks; empty = none. Invalid entries are ignored.
 */
export const IP_BLACKLIST_PARAM = 'auth.ip_blacklist'

/** Excel import limits (see docs/design-notes.md#security): larger files → 413, more rows/columns → 413; macros/external links refused. */
export interface ExcelImportLimits {
  maxMb: number
  maxRows: number
  maxColumns: number
}

export const DEFAULT_EXCEL_IMPORT_LIMITS: ExcelImportLimits = {
  maxMb: 10,
  maxRows: 5000,
  maxColumns: 100,
}

export const excelImportParams = {
  maxMb: 'excel.import_max_mb',
  maxRows: 'excel.import_max_rows',
  maxColumns: 'excel.import_max_columns',
} as const satisfies Record<keyof ExcelImportLimits, string>

/**
 * Log retention (see docs/design-notes.md#audit): the `audit.purge` job deletes for good, soft-deleted or
 * not, action, sign-in and API access logs, handled (resolved / ignored) or deleted API error logs, job
 * runs, inbox / mail / SMS records and SMS codes older than this many days (1 … 36500), and the files
 * deleted longer ago than that (body and row).
 */
export const AUDIT_RETENTION_PARAM = 'audit.retention_days'
export const DEFAULT_AUDIT_RETENTION_DAYS = 180

/**
 * API access log (see docs/design-notes.md#audit): `off` records nothing, `write` (default) every non-GET request, `all`
 * every request; routes with `@SkipHttpTrace()` never. Anything else counts as the default.
 */
export const HTTP_TRACE_MODE_PARAM = 'audit.http_trace.mode'
export const HTTP_TRACE_MODES = ['off', 'write', 'all'] as const
export type HttpTraceMode = (typeof HTTP_TRACE_MODES)[number]
export const DEFAULT_HTTP_TRACE_MODE: HttpTraceMode = 'write'

/**
 * API access log path exclusion (see docs/design-notes.md#audit): requests never recorded whatever the mode, besides
 * `@SkipHttpTrace()` routes. Entries separated by commas or line breaks, each a path prefix (matched
 * against the path without the query) optionally preceded by a method and a space
 * (`GET /api/monitor/`); anything else is ignored. The error log (5xx) still records them.
 */
export const HTTP_TRACE_EXCLUDE_PARAM = 'audit.http_trace.exclude_paths'
export const DEFAULT_HTTP_TRACE_EXCLUDE =
  '/api/health, GET /api/monitor/, GET /api/messaging/bulletins/feed'

/**
 * App 会话期限与单 App 会话（只作用于移动端声明为 App 的会话）：`sessionDays` 为 0 表示不过期
 * （每次刷新滑动延长），1–36500 为自登录起的绝对天数，非法值按 0；`singleSession` 为 `true` 时同一
 * 用户只保留最新登录的一个 App 会话。两者都只许 root 修改。
 */
export const appSessionParams = {
  sessionDays: 'auth.mobile.session_days',
  singleSession: 'auth.app.single_session',
} as const
export const DEFAULT_APP_SESSION_DAYS = 0
export const APP_SESSION_DAYS_MAX = 36500
export const DEFAULT_APP_SINGLE_SESSION = true

/**
 * 即时通讯参数（see docs/im.md）。数值参数按 `IM_INT_PARAMS` 的边界读取（越界或非法回落默认值），
 * 布尔参数 `=== 'true'`；`epoch` 是首次种子写入的随机 UUID，改值让所有客户端缓存重建。保留天数与
 * epoch 只许 root 修改。
 */
export const imParams = {
  retentionDays: 'im.history.retention_days',
  epoch: 'im.sync.epoch',
  textMaxChars: 'im.message.text_max_chars',
  recallMinutes: 'im.message.recall_minutes',
  editMinutes: 'im.message.edit_minutes',
  groupRecallAnytime: 'im.message.group_recall_anytime',
  groupMaxMembers: 'im.group.max_members',
  fileMaxMb: 'im.file.max_mb',
  fileExts: 'im.file.exts',
  voiceMaxSeconds: 'im.voice.max_seconds',
  voiceMaxMb: 'im.voice.max_mb',
  callEnabled: 'im.call.enabled',
} as const

/** 数值参数的读取边界与默认值（`ParamService.int(key, min, max, fallback)`）。 */
export const IM_INT_PARAMS = {
  retentionDays: { key: imParams.retentionDays, min: 0, max: 36500, fallback: 180 },
  textMaxChars: { key: imParams.textMaxChars, min: 1, max: 20000, fallback: 5000 },
  recallMinutes: { key: imParams.recallMinutes, min: 0, max: 1440, fallback: 2 },
  editMinutes: { key: imParams.editMinutes, min: 0, max: 1440, fallback: 5 },
  groupMaxMembers: { key: imParams.groupMaxMembers, min: 2, max: 2000, fallback: 200 },
  fileMaxMb: { key: imParams.fileMaxMb, min: 1, max: 1024, fallback: 20 },
  voiceMaxSeconds: { key: imParams.voiceMaxSeconds, min: 1, max: 300, fallback: 60 },
  voiceMaxMb: { key: imParams.voiceMaxMb, min: 1, max: 20, fallback: 5 },
} as const satisfies Record<string, { key: string; min: number; max: number; fallback: number }>

export const DEFAULT_IM_GROUP_RECALL_ANYTIME = true
/** 文件扩展名默认值；读取时再与 `storage.allowed_exts` 取交集。 */
export const DEFAULT_IM_FILE_EXTS = 'pdf,txt,doc,docx,xls,xlsx,ppt,pptx,zip'
