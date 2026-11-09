import dayjs from 'dayjs'
import {
  IM_SILENT_EVENT_CODES,
  type ImDirectory,
  type ImDirectoryUser,
  type ImEntry,
  type ImPreview,
} from '@qiwu/shared'
import type { ImRoomRecord } from '@qiwu/shared/im-client'
import { i18n, localized } from '@/core/i18n'

const t = (key: string, params?: Record<string, unknown>) =>
  params ? i18n.global.t(key, params) : i18n.global.t(key)

/** 通讯录按编号索引（界面里多处按人取姓名与头像）。 */
export function usersById(directory: ImDirectory | null): Map<number, ImDirectoryUser> {
  return new Map((directory?.users ?? []).map((u) => [u.id, u]))
}

/** 部门名：每语言文字优先，再按 i18n 键或原文。 */
export function deptName(directory: ImDirectory | null, deptId: number | null): string {
  const d = directory?.depts.find((x) => x.id === deptId)
  return d ? localized(d.nameI18n ?? null, d.name) : ''
}

/** 会话标题：群名；私聊显示对方姓名（通讯录里没有时用通用称呼）。 */
export function roomTitle(room: ImRoomRecord, users: Map<number, ImDirectoryUser>): string {
  const d = room.detail
  if (d?.label) return d.label
  if (d?.peerId) return users.get(d.peerId)?.displayName ?? t('im.rooms.direct')
  return d?.kind === 'group' ? t('im.rooms.group') : t('im.rooms.direct')
}

/** 头像占位：名字的第一个字符。 */
export const initialOf = (name: string) => [...name][0]?.toUpperCase() ?? ''

/** 列表与消息里的时间：今天只显示时分，今年显示月日，更早显示年月日。 */
export function shortTime(at: string | null): string {
  if (!at) return ''
  const d = dayjs(at)
  if (d.isSame(dayjs(), 'day')) return d.format('HH:mm')
  return d.format(d.isSame(dayjs(), 'year') ? 'MM-DD' : 'YYYY-MM-DD')
}

/** 列表里的预览文字（撤回行无正文、事件只按编码）。 */
export function previewText(p: ImPreview | null | undefined): string {
  if (!p) return ''
  if (p.recalled) return t('im.preview.recalled')
  switch (p.kind) {
    case 'text':
      return p.text ?? ''
    case 'voice':
      return t('im.preview.voice')
    case 'image':
      return t('im.preview.image')
    case 'file':
      return t('im.preview.file')
    case 'sticker':
      return p.stickerCode ? `[${t(`im.sticker.${p.stickerCode}`)}]` : t('im.preview.sticker')
    default:
      return t('im.preview.event')
  }
}

/** 编辑/撤回事件不单独显示（它们只改目标行）。 */
export const isSilentEvent = (e: ImEntry) =>
  e.kind === 'event' &&
  !!e.event &&
  (IM_SILENT_EVENT_CODES as readonly string[]).includes(e.event.code)

/** 系统事件的一句话（姓名取事件里的快照，操作人取通讯录）。 */
export function eventText(e: ImEntry, users: Map<number, ImDirectoryUser>): string {
  const ev = e.event
  if (!ev) return ''
  const actor = ev.actorId === null ? '' : (users.get(ev.actorId)?.displayName ?? t('im.someone'))
  if (ev.code === 'call.ended' && ev.call)
    return t('im.calls.summary', {
      mode: t(`im.calls.mode.${ev.call.mode}`),
      reason: t(`im.calls.reason.${ev.call.endReason}`),
      seconds: ev.call.durationSeconds,
    })
  return t(`im.event.${ev.code}`, {
    actor,
    users: (ev.users ?? []).map((u) => u.name).join(t('im.listSeparator')),
    label: ev.label ?? '',
    role: ev.role ? t(`im.group.role.${ev.role}`) : '',
  })
}

/** 文件大小。 */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 确认框的按钮文字（与本页语言一致，不用组件库自带的）。 */
export const boxButtons = () => ({
  type: 'warning' as const,
  confirmButtonText: t('im.action.confirm'),
  cancelButtonText: t('im.action.cancel'),
})

/** 扩展名（小写，不带点）。 */
export const extOf = (name: string) => name.split('.').pop()?.toLowerCase() ?? ''
