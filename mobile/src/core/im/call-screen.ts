import type { ImCall } from '@qiwu/shared'
import type { ImMediaFailure, ImMediaSnapshot } from '@qiwu/shared/im-media'

/** 页面通讯只带业务和媒体快照，不能加入票据、URL、登录凭据或 SDK 对象。 */
export interface ImCallScreen {
  screenId: string
  callId: number
  call: ImCall | null
  selfId: number
  media: ImMediaSnapshot
  busy: boolean
  controlBusy: boolean
  error: ImMediaFailure | null
  native: boolean
  writer: boolean
  audioBlocked: boolean
  otherCallActive: boolean
  closed: boolean
}
export const IM_CALL_SCREEN_EVENT = 'qw:im-call:screen'
export const IM_CALL_ACTION_EVENT = 'qw:im-call:action'
export const IM_CALL_ACTIONS = [
  'ready',
  'accept',
  'decline',
  'join',
  'leave',
  'end',
  'close',
  'hide',
  'microphone',
  'camera',
  'switchCamera',
  'speaker',
  'audio',
  'retryDisconnect',
] as const
export type ImCallAction = (typeof IM_CALL_ACTIONS)[number]
export interface ImCallScreenAction {
  screenId: string
  callId: number
  action: ImCallAction
  enabled?: boolean
}

/** 全局事件也校验形状，旧页面、隐藏页面与其它账号的消息不能误操作当前通话。 */
export function readImCallAction(value: unknown): ImCallScreenAction | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (Object.keys(item).some((key) => !['screenId', 'callId', 'action', 'enabled'].includes(key)))
    return null
  if (
    typeof item.screenId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,80}$/.test(item.screenId) ||
    !Number.isSafeInteger(item.callId) ||
    Number(item.callId) <= 0 ||
    !(IM_CALL_ACTIONS as readonly unknown[]).includes(item.action) ||
    (item.enabled !== undefined && typeof item.enabled !== 'boolean')
  )
    return null
  return item as unknown as ImCallScreenAction
}
