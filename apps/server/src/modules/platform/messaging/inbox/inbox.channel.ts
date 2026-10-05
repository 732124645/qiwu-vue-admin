import { Injectable, Logger, type OnModuleInit } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import { RT } from '@qiwu/shared'
import type { DataSource } from 'typeorm'
import {
  expireClaims,
  fillTemplate,
  NOTIFY_CLAIM_TIMEOUT_MS,
  NOTIFY_MAX_ATTEMPTS,
  NotifyChannels,
  NotifyDispatcher,
  type NotifyChannel,
  type NotifyDraft,
} from '../../../../core/notify/notify.js'
import { RealtimeService } from '../../../../core/realtime/realtime.service.js'
import { InboxTemplate } from '../inbox-template/inbox-template.entity.js'

/** A row this channel just delivered, for {@link InboxChannel.onDelivered} listeners. */
export interface DeliveredInbox {
  id: number
  userId: number
  templateCode: string
  locale: string
  /** rendered for the recipient */
  title: string
  /** the notification's raw params */
  params: Record<string, unknown> | null
  createdAt: Date
}

/** The inbox row is the message; delivery pushes it and moves pending → sending → delivered or failed. */
@Injectable()
export class InboxChannel implements NotifyChannel<InboxTemplate>, OnModuleInit {
  readonly code = 'inbox'
  private readonly logger = new Logger(InboxChannel.name)
  private readonly listeners: ((row: DeliveredInbox) => Promise<void>)[] = []

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly channels: NotifyChannels,
    private readonly realtime: RealtimeService,
    private readonly dispatcher: NotifyDispatcher,
  ) {}

  onModuleInit(): void {
    this.channels.register(this)
  }

  /**
   * More pushes of a delivered row besides `notify:new` (WeChat subscribe messages): called once per
   * row, only by the delivery whose claim marked it `delivered`; best effort, awaited by the dispatcher's
   * `idle()`, failures logged without detail.
   */
  onDelivered(fn: (row: DeliveredInbox) => Promise<void>): void {
    this.listeners.push(fn)
  }

  templates(code: string): Promise<InboxTemplate[]> {
    return this.ds.getRepository(InboxTemplate).find({ where: { code, enabled: true } })
  }

  async write({
    template,
    recipient,
    params,
    values,
  }: NotifyDraft<InboxTemplate>): Promise<number | null> {
    if (recipient.userId === null) return null
    const title = Array.from(fillTemplate(template.title, values)).slice(0, 200).join('')
    const body = Buffer.from(fillTemplate(template.body, values))
      .subarray(0, 65_532)
      .toString('utf8')
    const result: { insertId: number } = await this.txHost.tx.query(
      `INSERT INTO msg_inbox (user_id, template_code, locale, category, sender_label, title, body, params, status, attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0)`,
      [
        recipient.userId,
        template.code,
        template.locale,
        template.category,
        template.senderLabel,
        title,
        body,
        JSON.stringify(params),
      ],
    )
    return Number(result.insertId)
  }

  /** Test a stored row exactly as edited, including disabled rows; only the caller receives it. */
  async testSend(template: InboxTemplate, userId: number, params: Record<string, string>) {
    const id = await this.write({
      template,
      recipient: {
        userId,
        email: null,
        mobile: null,
        locale: template.locale as 'zh-CN' | 'en-US',
        timezone: 'UTC',
      },
      params,
      values: params,
    })
    if (id === null) throw new Error('Inbox test send needs a user')
    await this.deliver(id)
    const [{ status }]: { status: string }[] = await this.ds.query(
      'SELECT status FROM msg_inbox WHERE id = ? AND deleted_at IS NULL',
      [id],
    )
    return { ok: status === 'delivered', recordId: id }
  }

  async due(limit: number): Promise<number[]> {
    const rows: { id: number }[] = await this.ds.query(
      `SELECT id FROM msg_inbox WHERE attempts < ? AND deleted_at IS NULL AND
       (status IN ('pending', 'failed') OR (status = 'sending' AND claimed_at < ?))
       ORDER BY created_at, id LIMIT ?`,
      [NOTIFY_MAX_ATTEMPTS, new Date(Date.now() - NOTIFY_CLAIM_TIMEOUT_MS), limit],
    )
    return rows.map((row) => Number(row.id))
  }

  expire(): Promise<void> {
    return expireClaims(this.ds.manager, 'msg_inbox', false)
  }

  async deliver(id: number): Promise<void> {
    const claimedAt = new Date()
    const result: { affectedRows: number } = await this.ds.query(
      `UPDATE msg_inbox SET status = 'sending', attempts = attempts + 1, claimed_at = ?
       WHERE id = ? AND attempts < ? AND deleted_at IS NULL AND
       (status IN ('pending', 'failed') OR (status = 'sending' AND claimed_at < ?))`,
      [claimedAt, id, NOTIFY_MAX_ATTEMPTS, new Date(claimedAt.getTime() - NOTIFY_CLAIM_TIMEOUT_MS)],
    )
    if (!result.affectedRows) return
    try {
      const [row]: Omit<DeliveredInbox, 'id'>[] = await this.ds.query(
        `SELECT user_id AS userId, title, template_code AS templateCode, locale, params, created_at AS createdAt
           FROM msg_inbox WHERE id = ? AND deleted_at IS NULL`,
        [id],
      )
      this.realtime.toUser(Number(row.userId), {
        type: RT.notifyNew,
        payload: { id, title: row.title },
      })
      const done: { affectedRows: number } = await this.ds.query(
        "UPDATE msg_inbox SET status = 'delivered' WHERE id = ? AND status = 'sending' AND claimed_at = ? AND deleted_at IS NULL",
        [id, claimedAt],
      )
      if (!done.affectedRows) {
        this.logger.warn(`Inbox record ${id} claim taken over`)
        return
      }
      const delivered = { ...row, id, userId: Number(row.userId) }
      for (const fn of this.listeners) this.dispatcher.track(fn(delivered))
    } catch {
      const done: { affectedRows: number } = await this.ds.query(
        "UPDATE msg_inbox SET status = 'failed' WHERE id = ? AND status = 'sending' AND claimed_at = ? AND deleted_at IS NULL",
        [id, claimedAt],
      )
      if (!done.affectedRows) this.logger.warn(`Inbox record ${id} claim taken over`)
    }
  }
}
