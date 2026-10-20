import type {
  WxoaAccountKind,
  WxoaButton,
  WxoaCryptoMode,
  WxoaMediaKind,
  WxoaMenuKind,
  WxoaReplyKind,
  WxoaReplyTrigger,
} from '@qiwu/shared'
import { Column, Entity } from 'typeorm'
import { BaseEntity } from '../../../../core/db/base.entity.js'
import { referencedBy } from '../../../../core/db/references.js'
import { TenantColumn } from '../../../../core/db/tenant-filter.js'

// The WeChat Official Account tables (see docs/design-notes.md#wxoa). Every row but the account belongs
// to one account by `account_id`; deleting an account soft-deletes that row only. The three secrets are
// SecretBox ciphertext, never selected unless asked for (`addSelect('a.appSecretEnc')`). Generated
// columns (`alive`, `sole`, `default_one`) live in the DDL only.

// a rule replying with a material holds it: the material is not deleted while the rule lives
referencedBy('wxoa_material', { table: 'wxoa_reply_rule', column: 'material_id' })

const datetime = { type: 'datetime', precision: 3, nullable: true } as const

/** `wxoa_account`: one Official Account (its AppID fixed once created). */
@Entity('wxoa_account')
export class WxoaAccount extends BaseEntity {
  @TenantColumn()
  tenantId: number

  @Column({ length: 64 })
  label: string

  @Column({ name: 'app_id', length: 32 })
  appId: string

  @Column({ name: 'account_kind', type: 'varchar', length: 16 })
  accountKind: WxoaAccountKind

  @Column({ type: 'boolean', default: false })
  verified: boolean

  @Column({ name: 'crypto_mode', type: 'varchar', length: 16, default: 'plain' })
  cryptoMode: WxoaCryptoMode

  /** SecretBox ciphertext */
  @Column({ name: 'app_secret_enc', length: 512, select: false })
  appSecretEnc: string

  /** SecretBox ciphertext of the push Token */
  @Column({ name: 'push_token_enc', length: 512, select: false })
  pushTokenEnc: string

  /** SecretBox ciphertext of the EncodingAESKey; null in plain mode */
  @Column({ name: 'aes_key_enc', type: 'varchar', length: 512, nullable: true, select: false })
  aesKeyEnc: string | null

  /** the callback path's key (22 base64url characters), generated, never changed */
  @Column({ name: 'callback_key', type: 'char', length: 22 })
  callbackKey: string

  @Column({ type: 'boolean', default: true })
  enabled: boolean

  /** the last signed push (written only when it moves by more than 60 s) */
  @Column({ name: 'last_push_at', ...datetime })
  lastPushAt: Date | null

  @Column({ type: 'varchar', length: 500, nullable: true })
  note: string | null
}

/** `wxoa_fan`: a user of an account (written by the callback, completed by syncs). */
@Entity('wxoa_fan')
export class WxoaFan extends BaseEntity {
  @TenantColumn()
  tenantId: number

  @Column({ name: 'account_id', type: 'bigint', unsigned: true })
  accountId: number

  @Column({ name: 'open_id', length: 64 })
  openId: string

  @Column({ name: 'union_id', type: 'varchar', length: 64, nullable: true })
  unionId: string | null

  @Column({ type: 'boolean', default: false })
  subscribed: boolean

  @Column({ name: 'subscribed_at', ...datetime })
  subscribedAt: Date | null

  @Column({ name: 'unsubscribed_at', ...datetime })
  unsubscribedAt: Date | null

  @Column({ name: 'subscribe_scene', type: 'varchar', length: 48, nullable: true })
  subscribeScene: string | null

  @Column({ name: 'qr_scene', type: 'varchar', length: 64, nullable: true })
  qrScene: string | null

  @Column({ type: 'varchar', length: 30, nullable: true })
  remark: string | null

  @Column({ type: 'varchar', length: 16, nullable: true })
  lang: string | null

  /** upstream tag ids */
  @Column({ name: 'tag_ids', type: 'json', nullable: true })
  tagIds: number[] | null

  @Column({ type: 'boolean', default: false })
  blocked: boolean

  /** the fan's last message (the 48-hour reply window) */
  @Column({ name: 'last_inbound_at', ...datetime })
  lastInboundAt: Date | null

  /** the fan's last menu click, subscribe or scan (the 1-minute reply window) */
  @Column({ name: 'last_event_at', ...datetime })
  lastEventAt: Date | null

  @Column({ name: 'synced_at', ...datetime })
  syncedAt: Date | null
}

/** `wxoa_tag`: a fan tag of an account, mirrored from WeChat. */
@Entity('wxoa_tag')
export class WxoaTag extends BaseEntity {
  @TenantColumn()
  tenantId: number

  @Column({ name: 'account_id', type: 'bigint', unsigned: true })
  accountId: number

  /** WeChat's id, unique per account only */
  @Column({ name: 'tag_id', type: 'int', unsigned: true })
  tagId: number

  @Column({ length: 30 })
  name: string

  @Column({ name: 'fan_count', type: 'int', unsigned: true, default: 0 })
  fanCount: number
}

/** `wxoa_message`: the message log, in and out (purged after the retention period, never edited). */
@Entity('wxoa_message')
export class WxoaMessage extends BaseEntity {
  @TenantColumn()
  tenantId: number

  @Column({ name: 'account_id', type: 'bigint', unsigned: true })
  accountId: number

  @Column({ name: 'open_id', length: 64 })
  openId: string

  @Column({ type: 'varchar', length: 8 })
  direction: 'in' | 'out'

  @Column({ length: 16 })
  channel: string

  @Column({ name: 'msg_kind', length: 24 })
  msgKind: string

  @Column({ name: 'event_kind', type: 'varchar', length: 48, nullable: true })
  eventKind: string | null

  @Column({ name: 'event_key', type: 'varchar', length: 1024, nullable: true })
  eventKey: string | null

  /** whitelisted fields of the message (plain text, never markup) */
  @Column({ type: 'json' })
  payload: Record<string, unknown>

  /** an inbound row's local media copy (that row's own) */
  @Column({ name: 'object_id', type: 'bigint', unsigned: true, nullable: true })
  objectId: number | null

  /** a 64-bit id: a string */
  @Column({ name: 'wx_msg_id', type: 'varchar', length: 24, nullable: true })
  wxMsgId: string | null

  /** inbound duplicates collide on it; null for outbound rows */
  @Column({ name: 'dedup_key', type: 'char', length: 64, nullable: true })
  dedupKey: string | null

  @Column({ name: 'send_state', type: 'varchar', length: 16, nullable: true })
  sendState: string | null

  @Column({ type: 'int', nullable: true })
  errcode: number | null

  @Column({ name: 'operator_id', type: 'bigint', unsigned: true, nullable: true })
  operatorId: number | null

  @Column({ name: 'occurred_at', type: 'datetime', precision: 3 })
  occurredAt: Date
}

/** `wxoa_reply_rule`: an automatic reply of an account. */
@Entity('wxoa_reply_rule')
export class WxoaReplyRule extends BaseEntity {
  @TenantColumn()
  tenantId: number

  @Column({ name: 'account_id', type: 'bigint', unsigned: true })
  accountId: number

  @Column({ length: 64 })
  name: string

  @Column({ name: 'trigger_kind', type: 'varchar', length: 16 })
  triggerKind: WxoaReplyTrigger

  @Column({ name: 'match_mode', type: 'varchar', length: 8, nullable: true })
  matchMode: 'exact' | 'contains' | null

  @Column({ type: 'json', nullable: true })
  keywords: string[] | null

  /** a click rule's menu key, a scan rule's QR code scene */
  @Column({ name: 'event_key', type: 'varchar', length: 128, nullable: true })
  eventKey: string | null

  @Column({ type: 'int', default: 0 })
  priority: number

  @Column({ name: 'reply_kind', type: 'varchar', length: 16 })
  replyKind: WxoaReplyKind

  @Column({ name: 'reply_body', type: 'json' })
  replyBody: Record<string, unknown>

  @Column({ name: 'material_id', type: 'bigint', unsigned: true, nullable: true })
  materialId: number | null

  @Column({ type: 'boolean', default: true })
  enabled: boolean
}

/** `wxoa_menu`: an account's default menu (one) or a conditional menu. */
@Entity('wxoa_menu')
export class WxoaMenu extends BaseEntity {
  @TenantColumn()
  tenantId: number

  @Column({ name: 'account_id', type: 'bigint', unsigned: true })
  accountId: number

  @Column({ name: 'menu_kind', type: 'varchar', length: 16 })
  menuKind: WxoaMenuKind

  @Column({ length: 64 })
  label: string

  @Column({ name: 'match_tag_id', type: 'int', unsigned: true, nullable: true })
  matchTagId: number | null

  @Column({ name: 'match_platform', type: 'varchar', length: 8, nullable: true })
  matchPlatform: string | null

  @Column({ type: 'json' })
  buttons: WxoaButton[]

  /** a published conditional menu's menuid */
  @Column({ name: 'wx_menu_id', type: 'varchar', length: 32, nullable: true })
  wxMenuId: string | null

  @Column({ name: 'published_at', ...datetime })
  publishedAt: Date | null

  /** digest of the buttons last published (unpublished changes differ) */
  @Column({ name: 'published_digest', type: 'char', length: 64, nullable: true })
  publishedDigest: string | null
}

/** `wxoa_material`: a permanent material of an account. */
@Entity('wxoa_material')
export class WxoaMaterial extends BaseEntity {
  @TenantColumn()
  tenantId: number

  @Column({ name: 'account_id', type: 'bigint', unsigned: true })
  accountId: number

  @Column({ name: 'media_kind', type: 'varchar', length: 8 })
  mediaKind: WxoaMediaKind

  @Column({ name: 'media_id', length: 128 })
  mediaId: string

  @Column({ type: 'varchar', length: 64, nullable: true })
  title: string | null

  @Column({ type: 'varchar', length: 255, nullable: true })
  intro: string | null

  @Column({ name: 'file_name', type: 'varchar', length: 255, nullable: true })
  fileName: string | null

  @Column({ name: 'byte_size', type: 'bigint', unsigned: true, nullable: true })
  byteSize: number | null

  /** an image's https URL on WeChat */
  @Column({ name: 'wx_url', type: 'varchar', length: 1024, nullable: true })
  wxUrl: string | null

  @Column({ name: 'object_id', type: 'bigint', unsigned: true, nullable: true })
  objectId: number | null

  @Column({ type: 'varchar', length: 8 })
  origin: 'local' | 'pulled'
}

/** `wxoa_qrcode`: a channel QR code (string scene) of an account. */
@Entity('wxoa_qrcode')
export class WxoaQrcode extends BaseEntity {
  @TenantColumn()
  tenantId: number

  @Column({ name: 'account_id', type: 'bigint', unsigned: true })
  accountId: number

  @Column({ length: 64 })
  label: string

  @Column({ name: 'qr_kind', type: 'varchar', length: 12 })
  qrKind: 'temporary' | 'permanent'

  @Column({ length: 64 })
  scene: string

  @Column({ name: 'expires_at', ...datetime })
  expiresAt: Date | null

  @Column({ length: 255 })
  ticket: string

  @Column({ name: 'qr_url', length: 255 })
  qrUrl: string

  /** the image's local copy */
  @Column({ name: 'object_id', type: 'bigint', unsigned: true, nullable: true })
  objectId: number | null

  /** the upstream tag a scan puts on the fan */
  @Column({ name: 'tag_id', type: 'int', unsigned: true, nullable: true })
  tagId: number | null

  @Column({ name: 'scan_count', type: 'int', unsigned: true, default: 0 })
  scanCount: number

  @Column({ name: 'subscribe_count', type: 'int', unsigned: true, default: 0 })
  subscribeCount: number
}

/** `wxoa_draft`: a locally edited news draft synced to WeChat's draft box. */
@Entity('wxoa_draft')
export class WxoaDraft extends BaseEntity {
  @TenantColumn()
  tenantId: number

  @Column({ name: 'account_id', type: 'bigint', unsigned: true })
  accountId: number

  @Column({ length: 64 })
  title: string

  @Column({ type: 'json' })
  articles: Record<string, unknown>[]

  @Column({ name: 'media_id', type: 'varchar', length: 128, nullable: true })
  mediaId: string | null

  @Column({ type: 'varchar', length: 8 })
  origin: 'local' | 'pulled'

  @Column({ name: 'synced_at', ...datetime })
  syncedAt: Date | null

  @Column({ name: 'synced_digest', type: 'char', length: 64, nullable: true })
  syncedDigest: string | null
}

/** `wxoa_publish`: a freepublish submission or a record pulled from WeChat. */
@Entity('wxoa_publish')
export class WxoaPublish extends BaseEntity {
  @TenantColumn()
  tenantId: number

  @Column({ name: 'account_id', type: 'bigint', unsigned: true })
  accountId: number

  @Column({ name: 'draft_id', type: 'bigint', unsigned: true, nullable: true })
  draftId: number | null

  @Column({ name: 'publish_id', type: 'varchar', length: 64, nullable: true })
  publishId: string | null

  @Column({ name: 'article_id', type: 'varchar', length: 128, nullable: true })
  articleId: string | null

  @Column({ length: 64 })
  title: string

  @Column({ name: 'publish_state', type: 'varchar', length: 16 })
  publishState: 'publishing' | 'succeeded' | 'failed' | 'removed'

  @Column({ name: 'fail_idx', type: 'json', nullable: true })
  failIdx: number[] | null

  @Column({ name: 'article_urls', type: 'json', nullable: true })
  articleUrls: string[] | null

  @Column({ name: 'finished_at', ...datetime })
  finishedAt: Date | null
}

/** `wxoa_mass_job`: a one-shot mass message request. */
@Entity('wxoa_mass_job')
export class WxoaMassJob extends BaseEntity {
  @TenantColumn()
  tenantId: number

  @Column({ name: 'account_id', type: 'bigint', unsigned: true })
  accountId: number

  @Column({ name: 'target_kind', type: 'varchar', length: 8 })
  targetKind: 'all' | 'tag' | 'openids'

  @Column({ name: 'tag_id', type: 'int', unsigned: true, nullable: true })
  tagId: number | null

  @Column({ name: 'open_ids', type: 'json', nullable: true })
  openIds: string[] | null

  @Column({ name: 'msg_kind', type: 'varchar', length: 16 })
  msgKind: string

  @Column({ type: 'json' })
  payload: Record<string, unknown>

  @Column({ name: 'client_msg_id', type: 'varchar', length: 64 })
  clientMsgId: string

  @Column({ name: 'wx_msg_id', type: 'varchar', length: 32, nullable: true })
  wxMsgId: string | null

  @Column({ name: 'msg_data_id', type: 'varchar', length: 32, nullable: true })
  msgDataId: string | null

  @Column({ name: 'job_state', type: 'varchar', length: 16 })
  jobState: 'submitted' | 'succeeded' | 'failed' | 'removed'

  @Column({ type: 'json', nullable: true })
  result: Record<string, unknown> | null

  @Column({ name: 'finished_at', ...datetime })
  finishedAt: Date | null
}

/** `wxoa_inline_image`: one uploadimg URL per local rich-text object and account. */
@Entity('wxoa_inline_image')
export class WxoaInlineImage extends BaseEntity {
  @TenantColumn()
  tenantId: number

  @Column({ name: 'account_id', type: 'bigint', unsigned: true })
  accountId: number

  @Column({ name: 'object_id', type: 'bigint', unsigned: true })
  objectId: number

  @Column({ name: 'wx_url', type: 'varchar', length: 1024 })
  wxUrl: string
}

export const WXOA_ENTITIES = [
  WxoaAccount,
  WxoaFan,
  WxoaTag,
  WxoaMessage,
  WxoaReplyRule,
  WxoaMenu,
  WxoaMaterial,
  WxoaQrcode,
  WxoaDraft,
  WxoaPublish,
  WxoaMassJob,
  WxoaInlineImage,
]
