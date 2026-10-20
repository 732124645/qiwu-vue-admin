import { Injectable, Logger } from '@nestjs/common'
import { BizError } from '../../../../core/http/biz-error.js'
import { DEFAULT_TENANT_ID, withTenant } from '../../../../core/context/tenant.js'

/** A newly inserted inbound `wxoa_message` row, as the callback wrote it. */
export interface WxoaInbound {
  /** `wxoa_message.id` */
  id: number
  accountId: number
  openId: string
  msgKind: string
  eventKind: string | null
  eventKey: string | null
  wxMsgId: string | null
  payload: Record<string, unknown>
  occurredAt: Date
  /** tenant resolved from the callback account; optional for unit fixtures created before tenancy */
  tenantId?: number
}

export type WxoaInboundHandler = (row: WxoaInbound) => Promise<void>

/**
 * What happens to an inbound message after the callback answered WeChat (see docs/design-notes.md#wxoa):
 * the feature modules register a handler at init (fan profiles, QR code counts and tags, template
 * receipts, media copies, realtime hints) and the callback emits each newly inserted row once its
 * response is written. Nothing here is retried: a process stopping in between loses that work.
 */
@Injectable()
export class WxoaInboundHub {
  private readonly logger = new Logger(WxoaInboundHub.name)
  private readonly handlers: WxoaInboundHandler[] = []

  on(handler: WxoaInboundHandler): void {
    this.handlers.push(handler)
  }

  /**
   * Runs every handler on `row`, one after another; a failing one is logged (its error code only) and
   * the others still run. Resolves once all are done.
   */
  async emit(row: WxoaInbound): Promise<void> {
    const run = async () => {
      for (const handler of this.handlers)
        try {
          await handler(row)
        } catch (err) {
          const code = err instanceof BizError ? err.err.code : 'error'
          this.logger.warn(`inbound message ${row.id}: a handler failed (${code})`)
        }
    }
    // qw:cross-tenant callback row lookup selects the account tenant before hub work begins
    if (row.tenantId !== undefined) await withTenant(row.tenantId, run)
    else {
      // qw:cross-tenant legacy unit fixtures have no tenant column; keep their handlers in tenant 1.
      await withTenant(DEFAULT_TENANT_ID, run)
    }
  }
}
