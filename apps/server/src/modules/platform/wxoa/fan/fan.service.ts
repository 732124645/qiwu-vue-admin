import { Inject, Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  Err,
  type Page,
  type WxoaFanBlockingBody,
  type WxoaFanQuery,
  type WxoaFanTaggingBody,
  type WxoaFanVo,
  type WxoaSyncVo,
} from '@qiwu/shared'
import { type EntityManager, In, type SelectQueryBuilder } from 'typeorm'
import { AppConfigService } from '../../../../core/config/config.module.js'
import { BaseCrudService } from '../../../../core/db/base-crud.service.js'
import { allTenants, tenantId, withTenant } from '../../../../core/context/tenant.js'
import { contains } from '../../../../core/db/page.js'
import type { ExcelColumn } from '../../../../core/excel/excel.service.js'
import { type Lease, RedisLock } from '../../../../core/guard/redis-lock.js'
import { BizError } from '../../../../core/http/biz-error.js'
import { redisKey } from '../../../../core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../../../core/redis/redis.module.js'
import { JobHandler, type JobContext } from '../../../../core/scheduler/job-handler.js'
import { WxoaAccount, WxoaFan, WxoaTag } from '../core/wxoa.entity.js'
import { type WxoaCaller, type WxoaCall, type WxoaJson, WxoaGateway } from '../core/wxoa-gateway.js'
import { type WxoaInbound, WxoaInboundHub } from '../core/wxoa-inbound-hub.js'
import { wxoaTenantServes } from '../core/wxoa-util.js'

/** `user/info/batchget` takes at most 100 users */
const INFO_BATCH = 100
/** `batchtagging` / `batchuntagging` take at most 50 openids */
const TAG_BATCH = 50
/** `batchblacklist` / `batchunblacklist` take at most 20 openids */
const BLOCK_BATCH = 20
/** fans written back per statement when the blacklist is mirrored */
const WRITE_BATCH = 1000
const LOCK_TTL_MS = 30_000
/** seconds a sync's progress stays readable */
const PROGRESS_TTL = 7 * 24 * 3600

const iso = (d: Date | null) => d?.toISOString() ?? null
const now = () => new Date().toISOString()

/** printable ASCII of at most `max` characters (an ascii column), else null */
const ascii = (v: unknown, max: number) =>
  typeof v === 'string' && v.length <= max && /^[\x21-\x7e]+$/.test(v) ? v : null
/** text cut to `max` characters (code points: a surrogate pair is never split); empty → null */
const text = (v: unknown, max: number) =>
  typeof v === 'string' && v ? [...v].slice(0, max).join('') : null
const tagIdsOf = (v: unknown) =>
  Array.isArray(v)
    ? v.filter((id): id is number => Number.isInteger(id) && id >= 0 && id <= 4_294_967_295)
    : []
/** `user/get` and `getblacklist` list the openids under `data.openid` */
const openIdsOf = (page: WxoaJson) => {
  const list = (page.data as { openid?: unknown } | undefined)?.openid
  return Array.isArray(list)
    ? list.filter((id): id is string => ascii(id, 64) !== null)
    : ([] as string[])
}

/** A fan's profile as `user/info` (or `batchget`) answers it: what a sync and the hub write. */
function profileOf(info: WxoaJson) {
  return {
    unionId: ascii(info.unionid, 64),
    remark: text(info.remark, 30),
    lang: ascii(info.language, 16),
    tagIds: tagIdsOf(info.tagid_list),
    subscribeScene: ascii(info.subscribe_scene, 48),
    syncedAt: new Date(),
  }
}

const vo = (f: WxoaFan): WxoaFanVo => ({
  id: f.id,
  accountId: f.accountId,
  openId: f.openId,
  unionId: f.unionId,
  subscribed: f.subscribed,
  subscribedAt: iso(f.subscribedAt),
  unsubscribedAt: iso(f.unsubscribedAt),
  subscribeScene: f.subscribeScene,
  qrScene: f.qrScene,
  remark: f.remark,
  lang: f.lang,
  tagIds: f.tagIds ?? [],
  blocked: f.blocked,
  lastInboundAt: iso(f.lastInboundAt),
  lastEventAt: iso(f.lastEventAt),
  syncedAt: iso(f.syncedAt),
  createdAt: f.createdAt.toISOString(),
})

const idle = (): WxoaSyncVo => ({
  state: 'idle',
  done: 0,
  total: null,
  startedAt: null,
  finishedAt: null,
  code: null,
})

/** The fan export: the list's columns (tags by name, flags as yes / no). */
export const wxoaFanColumns: ExcelColumn[] = [
  { prop: 'openId', label: 'field.wxoa.fan.openId', width: 32 },
  { prop: 'remark', label: 'field.wxoa.fan.remark' },
  { prop: 'tags', label: 'field.wxoa.fan.tagId', width: 30 },
  { prop: 'subscribed', label: 'field.wxoa.fan.subscribed', dict: 'core.yes_no' },
  { prop: 'blocked', label: 'field.wxoa.fan.blocked', dict: 'core.yes_no' },
  { prop: 'createdAt', label: 'field.common.createdAt', type: 'datetime' },
]

/**
 * Takes upstream tag `tagId` off the account's fans (only `fanIds`, when given); the number of fans
 * changed.
 */
export async function untagFans(
  em: EntityManager,
  accountId: number,
  tagId: number,
  fanIds?: readonly number[],
): Promise<number> {
  const res: { affectedRows: number } = fanIds
    ? await em.query(
        `UPDATE wxoa_fan SET tag_ids = (SELECT COALESCE(JSON_ARRAYAGG(j.v), JSON_ARRAY())
           FROM JSON_TABLE(tag_ids, '$[*]' COLUMNS (v BIGINT PATH '$')) AS j WHERE j.v <> ?)
         WHERE tenant_id = ? AND account_id = ? AND id IN (?) AND deleted_at IS NULL AND ? MEMBER OF (tag_ids)`,
        [tagId, tenantId(), accountId, fanIds, tagId],
      )
    : await em.query(
        `UPDATE wxoa_fan SET tag_ids = (SELECT COALESCE(JSON_ARRAYAGG(j.v), JSON_ARRAY())
           FROM JSON_TABLE(tag_ids, '$[*]' COLUMNS (v BIGINT PATH '$')) AS j WHERE j.v <> ?)
         WHERE tenant_id = ? AND account_id = ? AND deleted_at IS NULL AND ? MEMBER OF (tag_ids)`,
        [tagId, tenantId(), accountId, tagId],
      )
  return res.affectedRows
}

/**
 * Fans of the accounts (see docs/design-notes.md#wxoa). The callback writes a fan's row and its
 * subscription inside the push; a subscribe then has its profile completed once through `user/info`
 * (inbound hub). A full sync (`user/get` + `info/batchget`, then the blacklist) runs in the background,
 * one per account across instances, and only after a whole round marks the fans it did not see as
 * unsubscribed; what the callback learnt during the round wins over what the round read. Remarks, tags
 * and the blacklist are set on WeChat first, then here. Every route goes through the account: alive
 * (404) and enabled (`B6011`); every fan and tag a request names must be the account's (404).
 */
@Injectable()
export class WxoaFanService extends BaseCrudService<WxoaFan> implements OnModuleInit {
  private readonly logger = new Logger(WxoaFanService.name)

  constructor(
    txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly gateway: WxoaGateway,
    private readonly hub: WxoaInboundHub,
    private readonly locks: RedisLock,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly cfg: AppConfigService,
  ) {
    super(txHost, WxoaFan)
  }

  onModuleInit(): void {
    this.hub.on((row) => this.completeProfile(row))
  }

  async list(query: WxoaFanQuery): Promise<Page<WxoaFanVo>> {
    await this.account(query.accountId)
    const page = await this.page(query)
    return { items: page.items.map(vo), total: page.total }
  }

  /** The list's rows in batches for the export, tags by name; the account checked on the first batch. */
  async *exportFans(query: WxoaFanQuery): AsyncGenerator<object[]> {
    await this.account(query.accountId)
    const tags = await this.txHost.tx
      .getRepository(WxoaTag)
      .find({ select: { tagId: true, name: true }, where: { accountId: query.accountId } })
    const names = new Map(tags.map((t) => [t.tagId, t.name]))
    for await (const batch of this.exportRows(query))
      yield batch.map((f) => ({
        ...f,
        tags: (f.tagIds ?? []).map((id) => names.get(id) ?? String(id)).join(', '),
      }))
  }

  async one(id: number): Promise<WxoaFanVo> {
    const row = await this.get(id)
    await this.account(row.accountId)
    return vo(row)
  }

  /** Sets the fan's remark on WeChat, then here ('' clears it). */
  async remark(id: number, remark: string): Promise<void> {
    const row = await this.get(id)
    const account = await this.account(row.accountId)
    await this.gateway.json(account, '/cgi-bin/user/info/updateremark', {
      body: { openid: row.openId, remark },
    })
    await this.repo.update(id, { remark: remark || null })
  }

  async tagging({ accountId, fanIds, tagId, op }: WxoaFanTaggingBody): Promise<void> {
    const account = await this.account(accountId)
    await this.tagFans(account, await this.fans(accountId, fanIds), tagId, op)
  }

  /**
   * Puts tag `tagId` on (or takes it off) the account's fans with these openids, for the QR code scans
   * (fans not here are left out); the tag must be one of the account's (404).
   */
  async tagOpenIds(
    accountId: number,
    openIds: readonly string[],
    tagId: number,
    op: 'add' | 'remove',
  ): Promise<void> {
    const account = await this.account(accountId)
    const fans = openIds.length
      ? await this.repo.find({
          select: { id: true, openId: true },
          where: { accountId, openId: In([...new Set(openIds)]) },
        })
      : []
    await this.tagFans(account, fans, tagId, op)
  }

  /** Blacklists (or frees) the fans on WeChat, then here, batch by batch. */
  async blocking({ accountId, fanIds, blocked }: WxoaFanBlockingBody): Promise<void> {
    const account = await this.account(accountId)
    const fans = await this.fans(accountId, fanIds)
    const path = blocked
      ? '/cgi-bin/tags/members/batchblacklist'
      : '/cgi-bin/tags/members/batchunblacklist'
    for (let i = 0; i < fans.length; i += BLOCK_BATCH) {
      const batch = fans.slice(i, i + BLOCK_BATCH)
      await this.gateway.json(account, path, {
        body: { openid_list: batch.map((f) => f.openId) },
      })
      await this.repo.update({ id: In(batch.map((f) => f.id)) }, { blocked })
    }
  }

  /** Starts a full sync of the account's fans in the background; one already running → `B6010`. */
  async startSync(accountId: number): Promise<WxoaSyncVo> {
    const account = await this.account(accountId)
    const run = await this.begin(account.id)
    if (!run) throw new BizError(Err.WXOA_SYNC_RUNNING)
    void this.sync(account, run.lease, run.progress).catch((err: unknown) =>
      this.logger.warn({ accountId, err }, 'wxoa fan sync: progress or lock not settled'),
    )
    return { ...run.progress }
  }

  /** The last sync's progress; one left running by a stopped instance (its lock gone) is `interrupted`. */
  async syncProgress(accountId: number): Promise<WxoaSyncVo> {
    await this.account(accountId)
    const raw = await this.redis.get(this.progressKey(accountId))
    if (!raw) return idle()
    const progress = JSON.parse(raw) as WxoaSyncVo
    if (progress.state === 'running' && !(await this.redis.exists(this.lockKey(accountId))))
      progress.state = 'interrupted'
    return progress
  }

  /**
   * 夜间任务：逐个同步可用租户里每个启用账号的全部粉丝；正在同步的账号跳过。调度器不带租户上下文运行，
   * 所以先在 allTenants 下扫全部启用账号，只留所属租户可用（`wxoaTenantServes`：启用、未删除、未到期、
   * 套餐含公众号；多租户开关关闭时只有默认租户）的，再在账号所属租户里同步，套餐不含公众号的租户不再
   * 消耗微信调用次数；一个账号失败只记日志，其余照常。
   */
  @JobHandler('wxoa.fan.sync')
  async nightly(_params: object, { signal, log }: JobContext): Promise<string> {
    // qw:cross-tenant the nightly sync scans the enabled accounts of every tenant; each syncs in its own
    const enabled = await allTenants(() =>
      this.txHost.tx.query<{ id: number; appId: string; accountKind: string; tenantId: number }[]>(
        // qw:cross-tenant the enabled accounts of every tenant; wxoaTenantServes keeps the usable ones
        `SELECT a.id, a.app_id AS appId, a.account_kind AS accountKind, a.tenant_id AS tenantId
           FROM wxoa_account a
          WHERE a.enabled = 1 AND a.deleted_at IS NULL
          ORDER BY a.id`,
      ),
    )
    const serves = new Map<number, boolean>()
    for (const tid of new Set(enabled.map((row) => Number(row.tenantId))))
      serves.set(tid, await wxoaTenantServes(this.txHost.tx, this.cfg.get('APP_MULTI_TENANT'), tid))
    const accounts = enabled.filter((row) => serves.get(Number(row.tenantId)))
    let synced = 0
    for (const row of accounts) {
      signal.throwIfAborted()
      const account: WxoaCaller = {
        id: Number(row.id),
        appId: row.appId,
        accountKind: row.accountKind as WxoaCaller['accountKind'],
        tenantId: Number(row.tenantId),
      }
      try {
        // qw:cross-tenant the account's own tenant
        const state = await withTenant(account.tenantId!, async () => {
          const run = await this.begin(account.id)
          if (!run) return null
          await this.sync(account, run.lease, run.progress, signal)
          return run.progress.state
        })
        if (state === null) {
          log(`account ${account.id}: a sync is running, skipped`)
          continue
        }
        log(`account ${account.id}: ${state}`)
        if (state === 'done') synced++
      } catch (err) {
        signal.throwIfAborted()
        this.logger.error({ accountId: account.id, err }, 'wxoa nightly fan sync failed')
        log(`account ${account.id}: failed`)
      }
    }
    return `${synced} of ${accounts.length} accounts synced`
  }

  protected override filter(
    qb: SelectQueryBuilder<WxoaFan>,
    { accountId, subscribed, blocked, tagId, openId, remark }: WxoaFanQuery,
  ): SelectQueryBuilder<WxoaFan> {
    qb.andWhere('t.accountId = :accountId', { accountId })
    if (subscribed !== undefined) qb.andWhere('t.subscribed = :subscribed', { subscribed })
    if (blocked !== undefined) qb.andWhere('t.blocked = :blocked', { blocked })
    // no index on tag_ids: a multi-valued one once accounts have many fans (see docs/design-notes.md#wxoa)
    if (tagId !== undefined) qb.andWhere(':tagId MEMBER OF (t.tagIds)', { tagId })
    if (openId) qb.andWhere('t.openId LIKE :openId', { openId: contains(openId) })
    if (remark) qb.andWhere('t.remark LIKE :remark', { remark: contains(remark) })
    return qb
  }

  /** A subscribe (new or again) gets the fan's profile once; the subscription itself the callback wrote. */
  private async completeProfile(row: WxoaInbound): Promise<void> {
    if (row.msgKind !== 'event' || row.eventKind !== 'subscribe') return
    const account = await this.account(row.accountId)
    const info = await this.gateway.json(account, '/cgi-bin/user/info', {
      query: { openid: row.openId, lang: 'zh_CN' },
    })
    // unsubscribed again meanwhile: WeChat answers nothing but that
    if (Number(info.subscribe) !== 1) return
    await this.repo.update({ accountId: row.accountId, openId: row.openId }, profileOf(info))
  }

  /** The fans `fanIds`, all of them the account's (else 404). */
  private async fans(accountId: number, fanIds: readonly number[]) {
    const ids = [...new Set(fanIds)]
    const fans = await this.repo.find({
      select: { id: true, openId: true },
      where: { id: In(ids), accountId },
      order: { id: 'ASC' },
    })
    if (fans.length !== ids.length) throw new NotFoundException()
    return fans
  }

  /** Tags (or untags) `fans` on WeChat, then here, batch by batch; the tag's fan count follows. */
  private async tagFans(
    account: WxoaCaller,
    fans: readonly Pick<WxoaFan, 'id' | 'openId'>[],
    tagId: number,
    op: 'add' | 'remove',
  ): Promise<void> {
    const tags = this.txHost.tx.getRepository(WxoaTag)
    if (!(await tags.existsBy({ accountId: account.id, tagId }))) throw new NotFoundException()
    const path =
      op === 'add' ? '/cgi-bin/tags/members/batchtagging' : '/cgi-bin/tags/members/batchuntagging'
    for (let i = 0; i < fans.length; i += TAG_BATCH) {
      const batch = fans.slice(i, i + TAG_BATCH)
      await this.gateway.json(account, path, {
        body: { openid_list: batch.map((f) => f.openId), tagid: tagId },
      })
      const ids = batch.map((f) => f.id)
      const em = this.txHost.tx
      if (op === 'remove') {
        const changed = await untagFans(em, account.id, tagId, ids)
        await em.query(
          `UPDATE wxoa_tag SET fan_count = fan_count - LEAST(fan_count, ?)
           WHERE tenant_id = ? AND account_id = ? AND tag_id = ? AND deleted_at IS NULL`,
          [changed, tenantId(), account.id, tagId],
        )
        continue
      }
      const res: { affectedRows: number } = await em.query(
        `UPDATE wxoa_fan SET tag_ids = JSON_ARRAY_APPEND(COALESCE(tag_ids, JSON_ARRAY()), '$', ?)
         WHERE tenant_id = ? AND account_id = ? AND id IN (?) AND deleted_at IS NULL
           AND NOT (? MEMBER OF (COALESCE(tag_ids, JSON_ARRAY())))`,
        [tagId, tenantId(), account.id, ids, tagId],
      )
      await em.query(
        'UPDATE wxoa_tag SET fan_count = fan_count + ? WHERE tenant_id = ? AND account_id = ? AND tag_id = ? AND deleted_at IS NULL',
        [res.affectedRows, tenantId(), account.id, tagId],
      )
    }
  }

  /** Takes the account's sync lock and writes a running progress; null when a sync is running. */
  private async begin(accountId: number): Promise<{ lease: Lease; progress: WxoaSyncVo } | null> {
    const lease = await this.locks.acquire(this.lockKey(accountId), LOCK_TTL_MS)
    if (!lease) return null
    const progress: WxoaSyncVo = { ...idle(), state: 'running', startedAt: now() }
    try {
      await this.saveProgress(accountId, progress)
    } catch (err) {
      // renewal stops on release; a failed release leaves the key to expire within LOCK_TTL_MS
      await lease.release().catch(() => false)
      throw err
    }
    return { lease, progress }
  }

  /**
   * One round: every openid of `user/get` page by page, their profiles by `info/batchget`; once the
   * round is whole, the fans it did not see are marked unsubscribed (not those subscribed since it
   * began); then the blacklist (`getblacklist`) is mirrored. Stops when the lock is lost or `signal`
   * aborts; the progress tells how it ended.
   */
  private async sync(
    account: WxoaCaller,
    lease: Lease,
    progress: WxoaSyncVo,
    signal?: AbortSignal,
  ): Promise<void> {
    const since = new Date()
    const check = () => {
      lease.lost.throwIfAborted()
      signal?.throwIfAborted()
    }
    const save = () => lease.held && this.saveProgress(account.id, progress)
    try {
      await this.everyOpenId(
        account,
        '/cgi-bin/user/get',
        (next) => (next ? { query: { next_openid: next } } : {}),
        check,
        async (openIds, total) => {
          progress.total = total
          for (let i = 0; i < openIds.length; i += INFO_BATCH) {
            check()
            const batch = openIds.slice(i, i + INFO_BATCH)
            const answer = await this.gateway.json(account, '/cgi-bin/user/info/batchget', {
              body: { user_list: batch.map((openid) => ({ openid, lang: 'zh_CN' })) },
            })
            const infos = Array.isArray(answer.user_info_list)
              ? (answer.user_info_list as WxoaJson[])
              : []
            await this.saveSynced(account.id, infos, since)
            progress.done += batch.length
            await save()
          }
        },
      )
      check()
      await this.txHost.tx.query(
        `UPDATE wxoa_fan SET subscribed = 0
         WHERE tenant_id = ? AND account_id = ? AND subscribed = 1 AND deleted_at IS NULL
           AND (synced_at IS NULL OR synced_at < ?) AND (subscribed_at IS NULL OR subscribed_at < ?)`,
        [tenantId(), account.id, since, since],
      )
      await this.syncBlacklist(account, check)
      progress.state = 'done'
    } catch (err) {
      progress.state = 'failed'
      progress.code = err instanceof BizError ? err.err.code : Err.INTERNAL.code
      this.logger.warn({ accountId: account.id, err }, 'wxoa fan sync failed')
    }
    progress.finishedAt = now()
    try {
      await save()
    } finally {
      await lease.release()
    }
  }

  /**
   * Profiles of a sync round. A new fan is written subscribed; a known one gets its profile, and its
   * subscription only when the callback has not seen it subscribe or unsubscribe since the round began.
   * (MySQL assigns left to right: `subscribed_at` goes last, so every condition reads the stored one.)
   */
  private async saveSynced(accountId: number, infos: WxoaJson[], since: Date): Promise<void> {
    const rows = infos.flatMap((info) => {
      const openId = ascii(info.openid, 64)
      if (Number(info.subscribe) !== 1 || !openId) return []
      const p = profileOf(info)
      const time = Number(info.subscribe_time)
      const scene =
        text(info.qr_scene_str, 64) ?? (Number(info.qr_scene) > 0 ? String(info.qr_scene) : null)
      return [
        [
          tenantId(),
          accountId,
          openId,
          p.unionId,
          p.remark,
          p.lang,
          JSON.stringify(p.tagIds),
          p.syncedAt,
          1,
          Number.isSafeInteger(time) && time > 0 ? new Date(time * 1000) : null,
          p.subscribeScene,
          scene,
        ],
      ]
    })
    if (!rows.length) return
    await this.txHost.tx.query(
      `INSERT INTO wxoa_fan (tenant_id, account_id, open_id, union_id, remark, lang, tag_ids, synced_at,
         subscribed, subscribed_at, subscribe_scene, qr_scene)
       VALUES ? AS n
       ON DUPLICATE KEY UPDATE union_id = n.union_id, remark = n.remark, lang = n.lang,
         tag_ids = n.tag_ids, synced_at = n.synced_at,
         subscribed = IF(wxoa_fan.subscribed_at >= ? OR wxoa_fan.unsubscribed_at >= ?, wxoa_fan.subscribed, 1),
         subscribe_scene = IF(wxoa_fan.subscribed_at >= ? OR wxoa_fan.unsubscribed_at >= ?, wxoa_fan.subscribe_scene, n.subscribe_scene),
         qr_scene = IF(wxoa_fan.subscribed_at >= ? OR wxoa_fan.unsubscribed_at >= ?, wxoa_fan.qr_scene, n.qr_scene),
         subscribed_at = IF(wxoa_fan.subscribed_at >= ? OR wxoa_fan.unsubscribed_at >= ?, wxoa_fan.subscribed_at, n.subscribed_at)`,
      [rows, since, since, since, since, since, since, since, since],
    )
  }

  /** The account's blacklist mirrored: listed fans blocked, once it is whole the others freed. */
  private async syncBlacklist(account: WxoaCaller, check: () => void): Promise<void> {
    const listed = new Set<string>()
    await this.everyOpenId(
      account,
      '/cgi-bin/tags/members/getblacklist',
      (next) => ({ body: { begin_openid: next } }),
      check,
      async (openIds) => {
        for (const id of openIds) listed.add(id)
        await this.repo.update(
          { accountId: account.id, openId: In(openIds), blocked: false },
          { blocked: true },
        )
      },
    )
    check()
    const blocked = await this.repo.find({
      select: { id: true, openId: true },
      where: { accountId: account.id, blocked: true },
    })
    const freed = blocked.filter((f) => !listed.has(f.openId)).map((f) => f.id)
    for (let i = 0; i < freed.length; i += WRITE_BATCH)
      await this.repo.update({ id: In(freed.slice(i, i + WRITE_BATCH)) }, { blocked: false })
  }

  /**
   * Pages through an openid list (`user/get`, `getblacklist`): `page(next)` asks for the page after
   * `next`; the list ends on an empty page, no cursor or the same cursor again.
   */
  private async everyOpenId(
    account: WxoaCaller,
    path: string,
    page: (next: string) => WxoaCall,
    check: () => void,
    each: (openIds: string[], total: number) => Promise<void>,
  ): Promise<void> {
    for (let next = ''; ;) {
      check()
      const answer = await this.gateway.json(account, path, page(next))
      const openIds = openIdsOf(answer)
      if (openIds.length) await each(openIds, Math.trunc(Number(answer.total)) || 0)
      const after = typeof answer.next_openid === 'string' ? answer.next_openid : ''
      if (!openIds.length || !after || after === next) return
      next = after
    }
  }

  /** Account `id`, alive (else 404) and enabled (else `B6011`). */
  private async account(id: number): Promise<WxoaCaller> {
    const row = await this.txHost.tx.getRepository(WxoaAccount).findOne({
      select: { id: true, appId: true, accountKind: true, enabled: true },
      where: { id },
    })
    if (!row) throw new NotFoundException()
    if (!row.enabled) throw new BizError(Err.WXOA_ACCOUNT_DISABLED)
    return { id: row.id, appId: row.appId, accountKind: row.accountKind }
  }

  private saveProgress(accountId: number, progress: WxoaSyncVo) {
    return this.redis.set(this.progressKey(accountId), JSON.stringify(progress), {
      expiration: { type: 'EX', value: PROGRESS_TTL },
    })
  }

  private progressKey = (accountId: number) => redisKey('wxoa', 'sync', accountId, 'fan')
  private lockKey = (accountId: number) => redisKey('lock', `wxoa-sync-fan-${accountId}`)
}
