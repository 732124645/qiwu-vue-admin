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
import { SmsChannel } from '../sms-channel/sms-channel.entity.js'
import { SmsClients, type SmsMessage } from '../sms-channel/sms-clients.js'
import { SmsRecord } from '../sms-record/sms-record.entity.js'
import { authTemplates } from './auth-sms-template.js'
import { SmsTemplate } from './sms-template.entity.js'

@Injectable()
export class SmsNotifyChannel implements NotifyChannel<SmsTemplate>, OnModuleInit {
  readonly code = 'sms' as const
  private readonly logger = new Logger(SmsNotifyChannel.name)

  constructor(
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly channels: NotifyChannels,
    private readonly clients: SmsClients,
  ) {}

  onModuleInit(): void {
    this.channels.register(this)
  }

  templates(code: string): Promise<SmsTemplate[]> {
    return this.txHost.tx.getRepository(SmsTemplate).findBy({ code, enabled: true })
  }

  async write({ template, recipient, values }: NotifyDraft<SmsTemplate>): Promise<number> {
    const channelId = template.channelId ?? (await this.fallbackChannel())
    const row = await this.txHost.tx.getRepository(SmsRecord).save({
      channelId,
      templateCode: template.code,
      mobile: recipient.mobile,
      userId: recipient.userId,
      body: fillTemplate(template.body, values).slice(0, 1000),
      params: { templateId: template.id, values },
      status: recipient.mobile ? 'pending' : 'skipped',
      error: recipient.mobile ? null : 'no_address',
      attempts: 0,
      providerMsgId: null,
      receiptStatus: null,
      receiptAt: null,
    })
    return row.id
  }

  /**
   * A template without a channel goes through the first enabled channel no auth.* template names: the
   * sign-in code route is never a default, whichever channels are later disabled or deleted.
   */
  private async fallbackChannel(): Promise<number | null> {
    const auth = new Set((await authTemplates(this.txHost.tx)).map((row) => row.channelId))
    const enabled = await this.txHost.tx.getRepository(SmsChannel).find({
      where: { enabled: true },
      order: { id: 'ASC' },
      select: { id: true },
    })
    return enabled.find((row) => !auth.has(row.id))?.id ?? null
  }

  /** OTP records contain only masked values and cannot be picked up by normal dispatch. */
  async writeClaimed(draft: NotifyDraft<SmsTemplate>): Promise<number> {
    const masked = {
      ...draft,
      params: { ...draft.params, code: '******' },
      values: { ...draft.values, code: '******' },
    }
    const id = await this.write(masked)
    await this.txHost.tx.getRepository(SmsRecord).update(id, {
      status: 'sending',
      attempts: NOTIFY_MAX_ATTEMPTS,
      claimedAt: new Date(),
    })
    return id
  }

  /** The real code exists only in the caller's transient message, never in msg_sms_record. */
  async sendClaimed(id: number, message: SmsMessage): Promise<void> {
    const repo = this.txHost.tx.getRepository(SmsRecord)
    let claimedAt: Date | null = null
    try {
      const row = await repo
        .createQueryBuilder('r')
        .addSelect('r.claimedAt')
        .where('r.id = :id', { id })
        .getOneOrFail()
      claimedAt = row.claimedAt
      if (
        row.status !== 'sending' ||
        row.attempts !== NOTIFY_MAX_ATTEMPTS ||
        !row.channelId ||
        !row.claimedAt
      )
        throw new Error('OTP record unavailable')
      const result = await (await this.clients.for(row.channelId)).send(message)
      const done = await repo
        .createQueryBuilder()
        .update()
        .set({ status: 'sent', providerMsgId: result.providerMsgId, error: null })
        .where("id = :id AND status = 'sending' AND claimed_at = :claimedAt", { id, claimedAt })
        .execute()
      if (!done.affected) this.logger.warn(`SMS OTP record ${id} claim taken over`)
    } catch (error) {
      this.logger.warn(
        `SMS OTP record ${id} delivery failed: ${error instanceof Error ? error.name : 'Error'}`,
      )
      if (!claimedAt) return
      const done = await repo
        .createQueryBuilder()
        .update()
        .set({ status: 'failed', error: 'send_failed' })
        .where("id = :id AND status = 'sending' AND claimed_at = :claimedAt", { id, claimedAt })
        .execute()
      if (!done.affected) this.logger.warn(`SMS OTP record ${id} claim taken over`)
    }
  }

  async due(limit: number): Promise<number[]> {
    if (limit <= 0) return []
    const rows = await this.txHost.tx
      .getRepository(SmsRecord)
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
    return expireClaims(this.txHost.tx, 'msg_sms_record', true)
  }

  async deliver(id: number): Promise<void> {
    const repo = this.txHost.tx.getRepository(SmsRecord)
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

    let errorCode = 'send_failed'
    try {
      const row = await repo.findOneByOrFail({ id })
      if (row.channelId === null || !row.mobile) {
        errorCode = 'no_channel'
        throw new Error(errorCode)
      }
      const channel = await this.txHost.tx
        .getRepository(SmsChannel)
        .findOneBy({ id: row.channelId, enabled: true })
      if (!channel) {
        errorCode = 'no_channel'
        throw new Error(errorCode)
      }
      const snapshot = row.params as { templateId?: number; values?: Record<string, string> } | null
      const template = snapshot?.templateId
        ? await this.txHost.tx.getRepository(SmsTemplate).findOneBy({ id: snapshot.templateId })
        : null
      if (!template) throw new Error('template unavailable')
      const values = snapshot?.values ?? {}
      const paramOrder =
        Array.isArray(template.paramNames) &&
        template.paramNames.every((name) => typeof name === 'string')
          ? (template.paramNames as string[])
          : [...new Set([...template.body.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!))]
      const result = await (
        await this.clients.for(channel.id)
      ).send({
        mobile: row.mobile,
        body: row.body,
        templateId: template.providerTemplateId,
        params: values,
        paramOrder,
      })
      const done = await repo
        .createQueryBuilder()
        .update()
        .set({ status: 'sent', providerMsgId: result.providerMsgId, error: null })
        .where("id = :id AND status = 'sending' AND claimed_at = :claimedAt", { id, claimedAt })
        .execute()
      if (!done.affected) this.logger.warn(`SMS record ${id} claim taken over`)
    } catch (error) {
      this.logger.warn(
        `SMS record ${id} delivery failed: ${error instanceof Error ? error.name : 'Error'}`,
      )
      const done = await repo
        .createQueryBuilder()
        .update()
        .set({ status: 'failed', error: errorCode })
        .where("id = :id AND status = 'sending' AND claimed_at = :claimedAt", { id, claimedAt })
        .execute()
      if (!done.affected) this.logger.warn(`SMS record ${id} claim taken over`)
    }
  }
}
