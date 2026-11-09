// 聊天界面的显示文字：会话标题、列表预览、系统事件与内置表情地址（纯函数，只读本地缓存里的数据）。
import {
  isImStickerCode,
  type ImDirectory,
  type ImEntry,
  type ImEvent,
  type ImPreview,
} from '@qiwu/shared'
import type { ImRoomRecord } from '@qiwu/shared/im-client'
import { t } from '../i18n'

/** 内置表情图片（分包自带的静态资源，零请求）。 */
export const builtinStickerSrc = (code: string) =>
  isImStickerCode(code) ? `/pages-im/static/stickers/${code}.png` : ''

/** 通讯录里的姓名；不在通讯录（已停用/删除）时用快照名。 */
export const userName = (
  dir: ImDirectory | undefined,
  id: number | null,
  fallback?: string | null,
) => (id !== null && dir?.users.find((u) => u.id === id)?.displayName) || fallback || ''

/** 会话标题：群名；私聊为对方姓名。 */
export function roomTitle(room: ImRoomRecord, dir: ImDirectory | undefined): string {
  const d = room.detail
  if (!d) return t('im.loading')
  if (d.kind === 'group') return d.label || t('im.group.untitled')
  return userName(dir, d.peerId ?? null) || t('im.direct.unknown')
}

/** 一条事件的文字（姓名取事件里的快照）。 */
export function eventText(ev: ImEvent, dir: ImDirectory | undefined): string {
  if (ev.code === 'call.ended' && ev.call)
    return t('imMedia.call.endedSummary', {
      mode: t(`imMedia.call.${ev.call.mode}`),
      reason: t(`imMedia.call.reason.${ev.call.endReason}`),
      duration: t('imMedia.call.duration', { n: ev.call.durationSeconds }),
    })
  const actor = userName(dir, ev.actorId)
  const users = (ev.users ?? []).map((u) => u.name).join(t('im.event.sep'))
  return t(`im.event.${ev.code.replace('.', '_')}`, {
    actor,
    users,
    label: ev.label ?? '',
    role: ev.role ? t(`im.role.${ev.role}`) : '',
  })
}

/** 消息体的简短文字（列表预览、引用）。 */
export function kindText(kind: string, text: string | null, stickerCode: string | null): string {
  if (kind === 'text') return text ?? ''
  if (kind === 'sticker')
    return stickerCode && isImStickerCode(stickerCode)
      ? `[${t(`im.sticker.${stickerCode}`)}]`
      : t('im.preview.sticker')
  if (kind === 'image') return t('im.preview.image')
  if (kind === 'file') return t('im.preview.file')
  if (kind === 'voice') return t('imMedia.voice.preview')
  return ''
}

/** 会话列表的第二行：群里带发送人。 */
export function previewText(room: ImRoomRecord, dir: ImDirectory | undefined): string {
  const p: ImPreview | null | undefined = room.detail?.preview
  if (!p) return ''
  if (p.recalled) return t('im.recalled')
  if (p.kind === 'event') return p.eventCode ? t(`im.preview.event`) : ''
  const body = kindText(p.kind, p.text, p.stickerCode)
  const who = room.detail?.kind === 'group' ? userName(dir, p.authorId, p.authorLabel) : ''
  return who ? `${who}: ${body}` : body
}

/** 一条消息是否显示为“已撤回”。 */
export const isRecalled = (e: Pick<ImEntry, 'recalledAt'>) => !!e.recalledAt

/** 头像底色：按用户 id 取模（visual-system §12.4）。 */
export const avatarTone = (id: number) => ['brand', 'success', 'warning', 'neutral'][id % 4]

/** 名字首字（头像）。 */
export const initial = (name: string) => [...name.trim()][0] ?? '?'
