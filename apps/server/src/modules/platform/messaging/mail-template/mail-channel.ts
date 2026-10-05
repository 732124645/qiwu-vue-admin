import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  expireClaims,
  fillTemplate,
  NOTIFY_CLAIM_TIMEOUT_MS,
  NOTIFY_MAX_ATTEMPTS,
  NotifyChannels,
  type NotifyChannel,
  type NotifyDraft,
} from '../../../../core/notify/notify.js'
import { MailAccount } from '../mail-account/mail-account.entity.js'
import { MailDeliveryError, MailTransports } from '../mail-account/mail-transports.js'
import { MailRecord } from '../mail-record/mail-record.entity.js'
import { MailTemplate } from './mail-template.entity.js'

@Injectable()
export class MailChannel implements NotifyChannel<MailTemplate>, OnModuleInit {
  readonly code = 'mail' as const
  private readonly logger = new Logger(MailChannel.name)

  constructor(
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly channels: NotifyChannels,
    private readonly transports: MailTransports,
  ) {}

  onModuleInit(): void {
    this.channels.register(this)
  }

  templates(code: string): Promise<MailTemplate[]> {
    return this.txHost.tx.getRepository(MailTemplate).findBy({ code, enabled: true })
  }

  async write({ template, recipient, params, values }: NotifyDraft<MailTemplate>): Promise<number> {
    const accountId =
      template.accountId ??
      (
        await this.txHost.tx.getRepository(MailAccount).findOne({
          where: { enabled: true },
          order: { id: 'ASC' },
          select: { id: true },
        })
      )?.id ??
      null
    const row = await this.txHost.tx.getRepository(MailRecord).save({
      userId: recipient.userId,
      toList: recipient.email ? [recipient.email] : [],
      ccList: null,
      bccList: null,
      accountId,
      templateCode: template.code,
      locale: template.locale,
      subject: fillTemplate(template.subject, values).slice(0, 255),
      body: fillTemplate(template.body, values, true),
      params,
      status: recipient.email ? 'pending' : 'skipped',
      error: recipient.email ? null : 'no_address',
      attempts: 0,
      providerMsgId: null,
      sentAt: null,
    })
    return row.id
  }

  async due(limit: number): Promise<number[]> {
    if (limit <= 0) return []
    const rows = await this.txHost.tx
      .getRepository(MailRecord)
      .createQueryBuilder('r')
      .select('r.id', 'id')
      .where(
        "r.attempts < :max AND (r.status IN ('pending', 'failed') OR (r.status = 'sending' AND r.claimed_at < :cutoff))",
        {
          max: NOTIFY_MAX_ATTEMPTS,
          cutoff: new Date(Date.now() - NOTIFY_CLAIM_TIMEOUT_MS),
        },
      )
      .orderBy('r.created_at', 'ASC')
      .addOrderBy('r.id', 'ASC')
      .limit(limit)
      .getRawMany<{ id: number }>()
    return rows.map((row) => row.id)
  }

  expire(): Promise<void> {
    return expireClaims(this.txHost.tx, 'msg_mail_record', true)
  }

  async deliver(id: number): Promise<void> {
    const repo = this.txHost.tx.getRepository(MailRecord)
    const claimedAt = new Date()
    const claimed = await repo
      .createQueryBuilder()
      .update()
      .set({ status: 'sending', attempts: () => 'attempts + 1', claimedAt })
      .where(
        "id = :id AND attempts < :max AND (status IN ('pending', 'failed') OR (status = 'sending' AND claimed_at < :cutoff))",
        {
          id,
          max: NOTIFY_MAX_ATTEMPTS,
          cutoff: new Date(claimedAt.getTime() - NOTIFY_CLAIM_TIMEOUT_MS),
        },
      )
      .execute()
    if (!claimed.affected) return

    try {
      const row = await repo.findOneByOrFail({ id })
      if (row.accountId === null) throw new MailDeliveryError('no_account')
      const account = await this.txHost.tx
        .getRepository(MailAccount)
        .findOneBy({ id: row.accountId, enabled: true })
      if (!account) throw new MailDeliveryError('no_account')
      const template = await this.txHost.tx
        .getRepository(MailTemplate)
        .findOneBy({ code: row.templateCode, locale: row.locale })
      const result = await this.transports.send(account.id, {
        from: { name: template?.senderLabel || account.name, address: account.address },
        to: row.toList as string[],
        subject: row.subject,
        html: row.body,
      })
      const done = await repo
        .createQueryBuilder()
        .update()
        .set({
          status: 'sent',
          sentAt: new Date(),
          providerMsgId: result.messageId,
          error: null,
        })
        .where("id = :id AND status = 'sending' AND claimed_at = :claimedAt", { id, claimedAt })
        .execute()
      if (!done.affected) this.logger.warn(`Mail record ${id} claim taken over`)
    } catch (error) {
      this.logger.warn(
        `Mail record ${id} delivery failed: ${error instanceof Error ? error.name : 'Error'}`,
      )
      const done = await repo
        .createQueryBuilder()
        .update()
        .set({
          status: 'failed',
          error: error instanceof MailDeliveryError ? error.code : 'send_failed',
        })
        .where("id = :id AND status = 'sending' AND claimed_at = :claimedAt", { id, claimedAt })
        .execute()
      if (!done.affected) this.logger.warn(`Mail record ${id} claim taken over`)
    }
  }
}
