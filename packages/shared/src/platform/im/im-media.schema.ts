import { z } from 'zod'
import { fieldDomains } from '../../validation/zod-i18n.js'

export const IM_CALL_MODES = ['audio', 'video'] as const
export type ImCallMode = (typeof IM_CALL_MODES)[number]
export const IM_CALL_STATES = ['ringing', 'active', 'ending', 'ended'] as const
export type ImCallState = (typeof IM_CALL_STATES)[number]
export const IM_CALL_MEMBER_STATES = ['invited', 'accepted', 'left', 'declined'] as const
export type ImCallMemberState = (typeof IM_CALL_MEMBER_STATES)[number]
export const IM_CALL_END_REASONS = [
  'cancelled',
  'declined',
  'no_answer',
  'left',
  'ended',
  'membership_changed',
  'session_ended',
  'timeout',
  'unavailable',
  'disabled',
] as const
export type ImCallEndReason = (typeof IM_CALL_END_REASONS)[number]
/** 控制面创建结果与业务结束状态分开保存，未知创建不能当作已经清理。 */
export const IM_CALL_MEDIA_STATES = [
  'intent',
  'creating',
  'ready',
  'unknown',
  'closing',
  'closed',
] as const
export type ImCallMediaState = (typeof IM_CALL_MEDIA_STATES)[number]
export const IM_CALL_LIMITS = {
  participants: 8,
  inviteSeconds: 45,
  heartbeatSeconds: 5,
  heartbeatGraceSeconds: 30,
  maxSeconds: 2 * 60 * 60,
  grantSeconds: 60,
} as const
export const IM_VOICE_LIMITS = {
  defaultSeconds: 60,
  maxSeconds: 300,
  defaultMb: 5,
  maxMb: 20,
  sampleRates: [8000, 16000, 44100],
} as const

const id = z.int().positive()
const at = z.string()
const register = <T extends z.ZodType>(schema: T): T => {
  fieldDomains.add(schema, { domain: 'im' })
  return schema
}
/** 群通话显式邀请，私聊的对方由服务端房间决定；客户端不能指定媒体房间或自己的身份。 */
export const imCallCreate = register(
  z.strictObject({
    clientCallId: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .min(1)
      .max(64),
    mode: z.enum(IM_CALL_MODES),
    userIds: z
      .array(id)
      .min(1)
      .max(IM_CALL_LIMITS.participants - 1)
      .refine((ids) => new Set(ids).size === ids.length, { error: 'validation.invalid' })
      .optional(),
  }),
)
export type ImCallCreate = z.infer<typeof imCallCreate>
/** 接听、拒绝、加入、离开、结束和心跳均不信任调用方提交的 sid、成员状态或媒体权限。 */
export const imCallAction = register(z.strictObject({}))
export type ImCallAction = z.infer<typeof imCallAction>

export const imCallMemberVo = z.strictObject({
  userId: id,
  displayName: z.string(),
  identity: z.string(),
  state: z.enum(IM_CALL_MEMBER_STATES),
})
export type ImCallMember = z.infer<typeof imCallMemberVo>
/** 只含业务元数据与当前调用者的操作资格，不包含原始 sid、媒体房间名或票据。 */
export const imCallVo = z.strictObject({
  id,
  roomId: id,
  mode: z.enum(IM_CALL_MODES),
  state: z.enum(IM_CALL_STATES),
  callerId: id,
  rev: z.int().min(1),
  createdAt: at,
  startedAt: at.nullable(),
  endedAt: at.nullable(),
  inviteExpiresAt: at,
  endReason: z.enum(IM_CALL_END_REASONS).nullable(),
  members: z.array(imCallMemberVo).max(IM_CALL_LIMITS.participants),
  canAccept: z.boolean(),
  canDecline: z.boolean(),
  canJoin: z.boolean(),
  canLeave: z.boolean(),
  canEnd: z.boolean(),
})
export type ImCall = z.infer<typeof imCallVo>
/** 票据响应只能放在媒体连接的运行时内存，不写聊天缓存、通知或历史行。 */
export const imCallGrantVo = z.strictObject({
  call: imCallVo,
  url: z.string(),
  token: z.string(),
  identity: z.string(),
  expiresAt: at,
})
export type ImCallGrant = z.infer<typeof imCallGrantVo>
/** 通话终局写入原消息流，保留期、成员时期与附件授权仍沿用房间规则。 */
export const imCallSummaryVo = z.strictObject({
  callId: id,
  mode: z.enum(IM_CALL_MODES),
  endReason: z.enum(IM_CALL_END_REASONS),
  durationSeconds: z.int().min(0).max(IM_CALL_LIMITS.maxSeconds),
})
export type ImCallSummary = z.infer<typeof imCallSummaryVo>
/** 实时消息只提示重新读取经过鉴权的业务状态。 */
export const imCallHint = z.strictObject({ callId: id, roomId: id, rev: z.int().min(1) })
export type ImCallHint = z.infer<typeof imCallHint>
