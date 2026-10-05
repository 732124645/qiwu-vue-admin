import {
  Global,
  Injectable,
  Logger,
  Module,
  type BeforeApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import { DEFAULT_LOCALE, LOCALES, type Locale } from '@qiwu/shared'
import { I18nService } from 'nestjs-i18n'
import {
  EventSubscriber,
  type DataSource,
  type EntityManager,
  type EntitySubscriberInterface,
  type QueryRunner,
  type TransactionCommitEvent,
  type TransactionRollbackEvent,
} from 'typeorm'
import { currentLocale, currentTimezone, timezoneOf } from '../i18n/locale.js'
import { clsGet } from '../context/cls.js'
import { formatInZone } from '../excel/excel.js'
import { DictService } from '../settings/dict.service.js'
import { ParamService } from '../settings/param.service.js'
import { JobHandler, type JobContext } from '../scheduler/job-handler.js'

/**
 * Notification port: `Notifier.send` is the one entry (scheduler alerts, workflow
 * messages; SMS sign-in/reset codes bypass it via `SmsNotifyChannel.writeClaimed`); each channel
 * (inbox, mail, sms, in modules/platform/messaging) implements `NotifyChannel` over its own template and
 * record tables and registers in `NotifyChannels`. There is no `ws` channel: the inbox channel pushes
 * `notify:new` itself once it delivered a row.
 */
export const NOTIFY_CHANNELS = ['inbox', 'mail', 'sms'] as const
export type NotifyChannelCode = (typeof NOTIFY_CHANNELS)[number]
export const NOTIFY_MAX_ATTEMPTS = 3
/**
 * A `sending` row claimed longer ago than this lost its sender (crash, kill): far above the longest send
 * (SMTP connection/greeting/socket 5 s each, SMS SDK 5 s), so a live sender is never claimed twice.
 */
export const NOTIFY_CLAIM_TIMEOUT_MS = 10 * 60_000

/**
 * A channel's `expire` over its record `table`: rows stuck in `sending` past NOTIFY_CLAIM_TIMEOUT_MS
 * with no attempt left become `failed` (+ `error` = 'interrupted' when the table has that column).
 * Candidates by a plain (non-locking) read, then an update by primary key that re-checks the condition:
 * the rows are locked like `deliver`'s claim locks them (primary key first). An UPDATE over the status
 * index range locked that index first and deadlocked with a concurrent claim.
 */
export async function expireClaims(
  q: EntityManager,
  table: string,
  withError: boolean,
): Promise<void> {
  const stale = "status = 'sending' AND claimed_at < ? AND attempts >= ? AND deleted_at IS NULL"
  const args = [new Date(Date.now() - NOTIFY_CLAIM_TIMEOUT_MS), NOTIFY_MAX_ATTEMPTS]
  // arch-allow: sql-concat the table is a channel's constant; values bound
  const rows: { id: number }[] = await q.query(`SELECT id FROM ${table} WHERE ${stale}`, args)
  if (!rows.length) return
  await q.query(
    // arch-allow: sql-concat the table is a channel's constant; values bound
    `UPDATE ${table} SET status = 'failed'${withError ? ", error = 'interrupted'" : ''}
      WHERE id IN (?) AND ${stale}`,
    [rows.map((r) => r.id), ...args],
  )
}

export type NotifyParam =
  | string
  | number
  | boolean
  | null
  | { dict: string; value: string | number }
  | { i18n: string }
  | { datetime: string }
export type NotifyParams = Record<string, NotifyParam>
/** A user id, or a direct address that belongs to no user: rendered in the request's language and time zone. */
export type NotifyTo = number | { email: string } | { mobile: string }

export interface NotifySend {
  /** Template code, e.g. `scheduler.job.timeout`. */
  template: string
  to: NotifyTo[]
  params?: NotifyParams
  /** Omitted means every channel with an enabled template row for this code. */
  channels?: NotifyChannelCode[]
}

export type NotifyRecordIds = Partial<Record<NotifyChannelCode, number[]>>

/** Resolved by Notifier: users from iam_user, direct addresses from request CLS. */
export interface NotifyRecipient {
  userId: number | null
  email: string | null
  mobile: string | null
  /** Recipient's chosen language. */
  locale: Locale
  /** Recipient's IANA time zone. */
  timezone: string
}

/** Minimum fields of an enabled channel template row. */
export interface NotifyTemplate {
  id: number
  code: string
  locale: string
}

export interface NotifyDraft<T extends NotifyTemplate> {
  /** Enabled row in the recipient's locale, or zh-CN when absent. */
  template: T
  recipient: NotifyRecipient
  /** Original typed parameters, unchanged from send(). */
  params: NotifyParams
  /** Dict labels, i18n keys and datetimes formatted for this recipient; other values via String(). */
  values: Record<string, string>
}

export interface NotifyChannel<T extends NotifyTemplate = NotifyTemplate> {
  readonly code: NotifyChannelCode
  /** All enabled locale rows of this code; no rows means this channel sends nothing. */
  templates(code: string): Promise<T[]>
  /**
   * Insert one record using the caller's TransactionHost.tx so rollback removes it. Write `pending`,
   * or `skipped` with a reason if the recipient lacks this channel's address. Render text with
   * fillTemplate(text, draft.values, html), where html is true only for mail bodies, and truncate to
   * each record column's length. Return the inserted row id, or null when no row applies.
   */
  write(draft: NotifyDraft<T>): Promise<number | null>
  /** Record ids eligible for a first claim or a retry, including stale claims. */
  due(limit: number): Promise<number[]>
  /** Mark interrupted claims that have exhausted their attempts. */
  expire(): Promise<void>
  /**
   * First claim with an atomic UPDATE to sending, attempts = attempts + 1 and claimed_at = now,
   * conditional on this id, attempts < NOTIFY_MAX_ATTEMPTS and a pending/failed status or a claim older
   * than NOTIFY_CLAIM_TIMEOUT_MS (its sender died). If zero rows change, return: another dispatcher owns
   * it. Then send and mark sent/delivered or failed with an error, only while claimed_at is still this
   * claim's (a stale sender never overwrites its successor). A failed send must not throw.
   */
  deliver(id: number): Promise<void>
}

/** Escape only substituted values in HTML mail bodies, never the template itself. */
export function escapeHtml(s: string): string {
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }
  return s.replace(/[&<>"']/g, (char) => entities[char]!)
}

/** One-pass placeholder expansion: missing names stay intact; replacement values are never re-read. */
export function fillTemplate(text: string, values: Record<string, string>, html = false): string {
  return text.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = Object.hasOwn(values, name) ? values[name] : undefined
    return value === undefined ? match : html ? escapeHtml(value) : value
  })
}

/** Channel services register themselves in onModuleInit. A code has exactly one owner. */
@Injectable()
export class NotifyChannels {
  private readonly channels = new Map<NotifyChannelCode, NotifyChannel>()

  register(channel: NotifyChannel): void {
    if (this.channels.has(channel.code))
      throw new Error(`NotifyChannels: '${channel.code}' already registered`)
    this.channels.set(channel.code, channel)
  }

  get(code: NotifyChannelCode): NotifyChannel | undefined {
    return this.channels.get(code)
  }

  all(): NotifyChannel[] {
    return [...this.channels.values()]
  }
}

const PENDING = 'notifyPending'
type Pending = NotifyRecordIds[]
function pendingNotifications(runner: QueryRunner): Pending {
  return (runner.data[PENDING] ??= []) as Pending
}

/** Flush committed records immediately or via the dispatch job; idle waits for queued commit flushes. */
@Injectable()
export class NotifyDispatcher implements BeforeApplicationShutdown {
  private readonly logger = new Logger(NotifyDispatcher.name)
  private readonly inFlight = new Set<Promise<void>>()

  constructor(private readonly channels: NotifyChannels) {}

  async flush(ids: NotifyRecordIds): Promise<void> {
    await Promise.all(
      Object.entries(ids).map(async ([code, rows]) => {
        for (const id of rows ?? []) {
          try {
            await this.channels.get(code as NotifyChannelCode)?.deliver(id)
          } catch (error) {
            this.logger.error(`Notification ${code}/${id} failed`, error)
          }
        }
      }),
    )
  }

  start(ids: NotifyRecordIds, txHost: TransactionHost<TransactionalAdapterTypeOrm>): void {
    this.track(
      new Promise<void>((resolve) => setImmediate(resolve)).then(() =>
        txHost.withoutTransaction(() => this.flush(ids)),
      ),
    )
  }

  track(work: Promise<unknown>): void {
    const done = work
      .catch((error: unknown) =>
        this.logger.error(
          `Notification work failed: ${error instanceof Error ? error.name : 'Error'}`,
        ),
      )
      .then(() => undefined)
    this.inFlight.add(done)
    void done.finally(() => this.inFlight.delete(done))
  }

  async idle(): Promise<void> {
    while (this.inFlight.size) await Promise.all(this.inFlight)
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.idle()
  }

  @JobHandler('notify.dispatch')
  async dispatch(_params: object, { signal }: JobContext): Promise<string> {
    let count = 0
    for (const channel of this.channels.all()) {
      signal.throwIfAborted()
      // a failed expire (a lock wait timeout, say) is retried next round; the deliveries go on
      await channel
        .expire()
        .catch((error: unknown) =>
          this.logger.error(`Notification ${channel.code} expire failed`, error),
        )
      for (const id of await channel.due(100)) {
        signal.throwIfAborted()
        try {
          await channel.deliver(id)
          count++
        } catch (error) {
          this.logger.error(`Notification ${channel.code}/${id} failed`, error)
        }
      }
    }
    return `processed ${count}`
  }
}

/** Nest creates this for DI, so onModuleInit adds it to ds.subscribers; only outer commits flush and outer rollbacks clear. */
@EventSubscriber()
@Injectable()
export class NotifyTransactionSubscriber implements EntitySubscriberInterface, OnModuleInit {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly dispatcher: NotifyDispatcher,
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
  ) {}

  onModuleInit(): void {
    this.ds.subscribers.push(this)
  }

  afterTransactionCommit({ queryRunner }: TransactionCommitEvent): void {
    if (queryRunner.isTransactionActive) return
    const pending = pendingNotifications(queryRunner).splice(0)
    if (!pending.length) return
    const ids: NotifyRecordIds = {}
    for (const group of pending)
      for (const [code, rows] of Object.entries(group))
        (ids[code as NotifyChannelCode] ??= []).push(...rows)
    this.dispatcher.start(ids, this.txHost)
  }

  afterTransactionRollback({ queryRunner }: TransactionRollbackEvent): void {
    if (!queryRunner.isTransactionActive) pendingNotifications(queryRunner).length = 0
  }
}

/**
 * The messaging module implements this port. send() writes one record per selected channel and recipient in
 * the caller's transaction, collecting ids on its QueryRunner. Flush via channel.deliver only after the OUTERMOST
 * transaction commits; without a transaction, flush just after insertion. Rollback must leave no rows
 * or sends. Only TransactionHost / @Transactional() transactions count: a send inside a raw
 * dataSource.transaction() writes and flushes at once. The minute-based notify.dispatch job retries
 * channel.due() rows after a missed flush.
 */
@Injectable()
export class Notifier {
  constructor(
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly channels: NotifyChannels,
    private readonly dispatcher: NotifyDispatcher,
    private readonly dict: DictService,
    private readonly i18n: I18nService,
    private readonly settings: ParamService,
  ) {}

  async send(input: NotifySend): Promise<NotifyRecordIds> {
    const ids: NotifyRecordIds = {}
    const selected = (input.channels ?? NOTIFY_CHANNELS)
      .map((code) => this.channels.get(code))
      .filter((channel): channel is NotifyChannel => channel !== undefined)
    const templates = await Promise.all(
      selected.map((channel) => channel.templates(input.template)),
    )
    const userIds = [...new Set(input.to.filter((to): to is number => typeof to === 'number'))]
    const manager = this.txHost.tx
    const users = userIds.length
      ? await manager.query<
          {
            id: number
            email: string | null
            mobile: string | null
            locale: string | null
            timezone: string | null
          }[]
        >(
          'SELECT id, email, mobile, locale, timezone FROM iam_user WHERE id IN (?) AND deleted_at IS NULL',
          [userIds],
        )
      : []
    const byId = new Map(users.map((user) => [Number(user.id), user]))
    const fallbackZone = await currentTimezone(this.settings, null)
    const recipients: NotifyRecipient[] = [...new Set(input.to)].flatMap(
      (to): NotifyRecipient[] => {
        if (typeof to === 'number') {
          const user = byId.get(to)
          return user
            ? [
                {
                  userId: to,
                  email: user.email,
                  mobile: user.mobile,
                  locale: LOCALES.includes(user.locale as Locale)
                    ? (user.locale as Locale)
                    : DEFAULT_LOCALE,
                  timezone: timezoneOf(user.timezone ?? undefined) ?? fallbackZone,
                },
              ]
            : []
        }
        return [
          {
            userId: null,
            email: 'email' in to ? to.email : null,
            mobile: 'mobile' in to ? to.mobile : null,
            locale: currentLocale(),
            timezone: clsGet('timezone') ?? fallbackZone,
          },
        ]
      },
    )
    const dicts = new Map<string, Awaited<ReturnType<DictService['entries']>>>()
    for (let i = 0; i < selected.length; i++) {
      const rows = templates[i]!
      if (!rows.length) continue
      const channel = selected[i]!
      for (const recipient of recipients) {
        const template =
          rows.find((row) => row.locale === recipient.locale) ??
          rows.find((row) => row.locale === DEFAULT_LOCALE) ??
          rows[0]!
        const values: Record<string, string> = {}
        for (const [key, value] of Object.entries(input.params ?? {})) {
          if (value !== null && typeof value === 'object' && 'dict' in value) {
            if (!dicts.has(value.dict)) dicts.set(value.dict, await this.dict.entries(value.dict))
            const entry = dicts
              .get(value.dict)
              ?.entries.find((e) => e.value === String(value.value))
            values[key] =
              entry?.labelI18n?.[recipient.locale] ?? entry?.label ?? String(value.value)
          } else if (value !== null && typeof value === 'object' && 'i18n' in value) {
            values[key] = String(
              this.i18n.translate(value.i18n, { lang: recipient.locale, defaultValue: value.i18n }),
            )
          } else if (value !== null && typeof value === 'object' && 'datetime' in value) {
            const date = new Date(value.datetime)
            values[key] = Number.isNaN(date.getTime())
              ? value.datetime
              : formatInZone(date, recipient.timezone).slice(0, 16)
          } else values[key] = value === null ? '' : String(value)
        }
        const id = await channel.write({ template, recipient, params: input.params ?? {}, values })
        if (id !== null) (ids[channel.code] ??= []).push(id)
      }
    }
    if (this.txHost.isTransactionActive()) {
      const runner = (this.txHost.tx as EntityManager).queryRunner
      if (!runner) throw new Error('Notifier: active transaction has no QueryRunner')
      pendingNotifications(runner).push(ids)
    } else await this.dispatcher.flush(ids)
    return ids
  }
}

@Global()
@Module({
  providers: [NotifyChannels, Notifier, NotifyDispatcher, NotifyTransactionSubscriber],
  exports: [NotifyChannels, Notifier, NotifyDispatcher],
})
export class CoreNotifyModule {}
