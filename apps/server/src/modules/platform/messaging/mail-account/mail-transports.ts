import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import nodemailer, { type SendMailOptions, type Transporter } from 'nodemailer'
import { isIP } from 'node:net'
import { AppConfigService } from '../../../../core/config/config.module.js'
import { SecretBox } from '../../../../core/crypto/secret-box.js'
import {
  assertPublicHost,
  NET_TIMEOUT_MS,
  outboundRule,
  OutboundRefused,
} from '../../../../core/net/net-guard.js'
import { MailAccount } from './mail-account.entity.js'

type Options = {
  host: string
  port: number
  secure: boolean
  requireTLS: boolean
  ignoreTLS: boolean
  tls?: { servername: string }
  auth?: { user: string; pass: string }
  connectionTimeout: number
  greetingTimeout: number
  socketTimeout: number
}

export class MailDeliveryError extends Error {
  constructor(readonly code: 'no_account' | 'refused' | 'send_failed') {
    super(code)
  }
}

/** One SMTP transport per stored version; every use rechecks the outbound rule before dialing. */
@Injectable()
export class MailTransports {
  private readonly logger = new Logger(MailTransports.name)
  private readonly cache = new Map<number, { updatedAt: number; transport: Transporter }>()

  constructor(
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly cfg: AppConfigService,
    private readonly box: SecretBox,
  ) {}

  /** Kept small so a spec can replace the SMTP socket with a JSON transport. */
  protected create(options: Options): Transporter {
    return nodemailer.createTransport(options)
  }

  private async account(id: number): Promise<MailAccount> {
    const row = await this.txHost.tx
      .getRepository(MailAccount)
      .createQueryBuilder('a')
      .addSelect('a.passwordEnc')
      .where('a.id = :id', { id })
      .getOne()
    if (!row) {
      this.close(id)
      throw new NotFoundException()
    }
    return row
  }

  private async transport(row: MailAccount): Promise<Transporter> {
    if (!row.enabled) {
      this.close(row.id)
      throw new Error('mail account unavailable')
    }
    const [checked] = await assertPublicHost(row.host, row.port, outboundRule(this.cfg, 'smtp'))
    if (!checked) throw new Error('mail account unavailable')
    const version = row.updatedAt.getTime()
    const cached = this.cache.get(row.id)
    if (cached?.updatedAt === version) return cached.transport
    this.close(row.id)
    const host = row.host.replace(/^\[(.*)\]$/, '$1')
    const transport = this.create({
      host: checked.address,
      port: row.port,
      secure: row.security === 'ssl',
      requireTLS: row.security === 'starttls',
      ignoreTLS: row.security === 'none',
      ...(isIP(host) ? {} : { tls: { servername: host } }),
      ...(row.username
        ? { auth: { user: row.username, pass: this.box.decrypt(row.passwordEnc ?? '') } }
        : {}),
      connectionTimeout: NET_TIMEOUT_MS,
      greetingTimeout: NET_TIMEOUT_MS,
      socketTimeout: NET_TIMEOUT_MS,
    })
    this.cache.set(row.id, { updatedAt: version, transport })
    return transport
  }

  private close(id: number): void {
    this.cache.get(id)?.transport.close()
    this.cache.delete(id)
  }

  async test(id: number): Promise<{ ok: boolean }> {
    const row = await this.account(id)
    try {
      await (await this.transport(row)).verify()
      return { ok: true }
    } catch (error) {
      this.logger.warn(
        `Mail account ${id} connection failed: ${error instanceof Error ? error.name : 'Error'}`,
      )
      return { ok: false }
    }
  }

  async send(accountId: number, message: SendMailOptions) {
    try {
      const row = await this.account(accountId)
      return await (await this.transport(row)).sendMail({ from: row.address, ...message })
    } catch (error) {
      this.logger.warn(
        `Mail account ${accountId} send failed: ${error instanceof Error ? error.name : 'Error'}`,
      )
      throw new MailDeliveryError(
        error instanceof NotFoundException ||
          (error instanceof Error && error.message === 'mail account unavailable')
          ? 'no_account'
          : error instanceof OutboundRefused
            ? 'refused'
            : 'send_failed',
      )
    }
  }
}
