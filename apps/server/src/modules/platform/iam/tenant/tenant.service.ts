import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common'
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm'
import {
  DEFAULT_TENANT_ID,
  Err,
  type Page,
  type tenantCreate,
  type TenantCreatedVo,
  type TenantInitialPasswordVo,
  type TenantOption,
  type TenantQuery,
  type tenantUpdate,
  type TenantVo,
} from '@qiwu/shared'
import type { Request } from 'express'
import { type DataSource, type EntityManager, IsNull, type Repository } from 'typeorm'
import type { z } from 'zod'
import { AuthParams } from '../../../../core/auth/auth-params.js'
import { PermVersion } from '../../../../core/auth/perm-version.js'
import { SessionRevoker } from '../../../../core/auth/session-revoker.js'
import { TenantActing } from '../../../../core/auth/tenant-acting.js'
import {
  CONSOLE_CLIENT,
  TENANT_UNAVAILABLE,
  TokenService,
} from '../../../../core/auth/token.service.js'
import { AppConfigService } from '../../../../core/config/config.module.js'
import { clsGet } from '../../../../core/context/cls.js'
import { withTenant } from '../../../../core/context/tenant.js'
import { SecretBox } from '../../../../core/crypto/secret-box.js'
import { contains, paginate } from '../../../../core/db/page.js'
import { BizError } from '../../../../core/http/biz-error.js'
import { seedKeysLike } from '../../../../core/i18n/seed-names.js'
import { StorageService } from '../../storage/storage.service.js'
import { IamTenantLookup } from './iam-tenant-lookup.js'
import { Tenant } from './tenant.entity.js'
import { randomPassword, TenantProvisioner } from './tenant-provisioner.js'

type TenantCreateDto = z.output<typeof tenantCreate>
type TenantUpdateDto = z.output<typeof tenantUpdate>

const caller = () => clsGet('principal')?.userId ?? null
const time = (d: Date | null) => d?.getTime() ?? null

/** 404 unless package `id` is live and enabled; read FOR SHARE, so it cannot be deleted meanwhile. */
async function assertUsablePackage(q: EntityManager, id: number): Promise<void> {
  const [row] = await q.query<unknown[]>(
    'SELECT id FROM iam_tenant_package WHERE id = ? AND enabled = 1 AND deleted_at IS NULL FOR SHARE',
    [id],
  )
  if (!row) throw new NotFoundException()
}

/**
 * New host names of tenant `tid`: plain INSERTs, one row each. A name another tenant holds (its live
 * row) fails the unique key (errno 1062 → 409 `duplicate`, naming nobody).
 */
async function insertDomains(q: EntityManager, tid: number, domains: readonly string[]) {
  if (!domains.length) return
  const by = caller()
  await q.query(
    'INSERT INTO iam_tenant_domain (tenant_id, domain, created_by, updated_by) VALUES ?',
    [domains.map((d) => [tid, d, by, by])],
  )
}

/**
 * Tenant `tid`'s host names become `domains`: the names dropped are soft-deleted (free for another tenant
 * at once), the new ones inserted (never a deleted row revived), the rest left alone. Returns the names
 * that changed hands.
 */
async function replaceDomains(q: EntityManager, tid: number, domains: readonly string[]) {
  const held = (
    await q.query<{ domain: string }[]>(
      'SELECT domain FROM iam_tenant_domain WHERE tenant_id = ? AND deleted_at IS NULL',
      [tid],
    )
  ).map((r) => r.domain)
  const dropped = held.filter((d) => !domains.includes(d))
  const added = domains.filter((d) => !held.includes(d))
  if (dropped.length)
    await q.query(
      `UPDATE iam_tenant_domain SET deleted_at = NOW(3), updated_by = ?
        WHERE tenant_id = ? AND domain IN (?) AND deleted_at IS NULL`,
      [caller(), tid, dropped],
    )
  await insertDomains(q, tid, added)
  return [...dropped, ...added]
}

/**
 * Tenant management (`/api/iam/tenants`, see docs/design-notes.md#tenancy), platform pages only. A tenant
 * is never deleted: disabled or let expire, its data stays. Writes that take a tenant out of service end
 * its sessions after the commit (`revokeTenant`), and writes that change what its sessions may do
 * (package, end) make every session reload (`bumpAll`; one counter for all tenants, see the notes), the
 * reload first: a revoke failing halfway still leaves every session to end at its next use.
 * The default tenant keeps no package (unrestricted), no end and stays enabled (422 B1015).
 */
@Injectable()
export class TenantService {
  private readonly logger = new Logger(TenantService.name)

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(Tenant) private readonly repo: Repository<Tenant>,
    private readonly provisioner: TenantProvisioner,
    private readonly lookup: IamTenantLookup,
    private readonly storage: StorageService,
    private readonly revoker: SessionRevoker,
    private readonly permVer: PermVersion,
    private readonly cfg: AppConfigService,
    private readonly box: SecretBox,
    private readonly authParams: AuthParams,
    private readonly tokens: TokenService,
    private readonly acting: TenantActing,
  ) {}

  async page({ code, name, packageId, enabled, ...paging }: TenantQuery): Promise<Page<TenantVo>> {
    const qb = this.repo.createQueryBuilder('t')
    if (code) qb.andWhere('t.code LIKE :code', { code: contains(code) })
    if (name) {
      // the default tenant's name is a key (seed.tenant.*): match the text users see too
      const seeded = seedKeysLike('seed.tenant.', name)
      qb.andWhere(
        seeded.length ? '(t.name LIKE :name OR t.name IN (:...seeded))' : 't.name LIKE :name',
        { name: contains(name), seeded },
      )
    }
    if (packageId !== undefined) qb.andWhere('t.packageId = :packageId', { packageId })
    if (enabled !== undefined) qb.andWhere('t.enabled = :enabled', { enabled })
    const { items, total } = await paginate(qb, paging)
    return { items: await this.vos(items), total }
  }

  /** Every tenant (id, code, name), for filters. */
  options(): Promise<TenantOption[]> {
    return this.repo.find({ select: { id: true, code: true, name: true }, order: { id: 'ASC' } })
  }

  async get(id: number): Promise<TenantVo> {
    const row = await this.repo.findOneBy({ id })
    if (!row) throw new NotFoundException()
    return (await this.vos([row]))[0]!
  }

  /**
   * Opens a tenant in one transaction (TenantProvisioner): its row, an enabled package (404 otherwise),
   * its host names, its logo, its seeds and its administrator. The initial password is answered here only.
   */
  async create(dto: TenantCreateDto, host: string | undefined): Promise<TenantCreatedVo> {
    const domains = dto.domains ?? []
    this.assertNotPlatformHost(domains, host)
    const { id, initialPassword } = await this.provisioner.provision(
      {
        ...dto,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      },
      async (q, tid) => {
        await assertUsablePackage(q, dto.packageId)
        await insertDomains(q, tid, domains)
        await this.bindLogo(q, tid, dto.logoObjectId)
      },
    )
    this.lookup.forget(domains)
    return { ...(await this.get(id)), initialPassword }
  }

  /**
   * PUT /:id: the fields sent change. `domains` replaces the host names as a whole. A new package or end
   * makes every session reload after the commit (capped at the new end, narrowed to the new package); an
   * end not in the future ends the tenant's sessions and sockets at once, as disabling it does. A logo
   * replaced or cleared is deleted after the commit (`dropLogo`).
   */
  async update(id: number, dto: TenantUpdateDto, host: string | undefined): Promise<void> {
    if (dto.domains) this.assertNotPlatformHost(dto.domains, host)
    const { expiresAt, domains, ...fields } = dto
    const end = expiresAt === undefined ? undefined : expiresAt ? new Date(expiresAt) : null
    const done = await this.ds.transaction(async (q) => {
      const row = await this.locked(q, id)
      if (id === DEFAULT_TENANT_ID && (dto.packageId !== undefined || end))
        throw new BizError(Err.IAM_TENANT_DEFAULT_FIXED)
      if (dto.packageId !== undefined) await assertUsablePackage(q, dto.packageId)
      const hosts = domains ? await replaceDomains(q, id, domains) : []
      if (dto.logoObjectId != null && dto.logoObjectId !== row.logoObjectId)
        await this.bindLogo(q, id, dto.logoObjectId)
      const set = Object.fromEntries(
        Object.entries({ ...fields, expiresAt: end }).filter(([, v]) => v !== undefined),
      )
      if (Object.keys(set).length) await q.getRepository(Tenant).update(id, set)
      return {
        hosts,
        oldLogo:
          dto.logoObjectId !== undefined && dto.logoObjectId !== row.logoObjectId
            ? row.logoObjectId
            : null,
        repackaged: dto.packageId !== undefined && dto.packageId !== row.packageId,
        endMoved: end !== undefined && time(end) !== time(row.expiresAt),
      }
    })
    this.lookup.forget(done.hosts)
    if (done.oldLogo !== null) await this.dropLogo(id, done.oldLogo)
    if (done.repackaged || done.endMoved) await this.permVer.bumpAll()
    if (done.endMoved && end && end.getTime() <= Date.now())
      await this.revoker.revokeTenant(id, TENANT_UNAVAILABLE)
  }

  /** PUT /:id/enabled: disabling ends the tenant's sessions and sockets after the commit. */
  async setEnabled(id: number, enabled: boolean): Promise<void> {
    if (id === DEFAULT_TENANT_ID && !enabled) throw new BizError(Err.IAM_TENANT_DEFAULT_FIXED)
    const { affected } = await this.repo.update({ id, deletedAt: IsNull() }, { enabled })
    if (!affected) throw new NotFoundException()
    if (enabled) return
    await this.permVer.bumpAll()
    await this.revoker.revokeTenant(id, TENANT_UNAVAILABLE)
  }

  /**
   * POST /:id/initial-password: a new initial password for the tenant's users made without one, answered
   * this once. No user's password changes (the owner's is reset by root inside the tenant). The default
   * tenant's is the `iam.user.initial_password` param (422).
   */
  async resetInitialPassword(id: number): Promise<TenantInitialPasswordVo> {
    if (id === DEFAULT_TENANT_ID) throw new BizError(Err.IAM_TENANT_DEFAULT_FIXED)
    const { policy } = await this.authParams.load()
    const initialPassword = randomPassword(policy)
    const { affected } = await this.repo.update(
      { id, deletedAt: IsNull() },
      { initialPasswordEnc: this.box.encrypt(initialPassword) },
    )
    if (!affected) throw new NotFoundException()
    return { initialPassword }
  }

  /**
   * POST /:id/enter: the caller's web console session works inside tenant `id` (another tenant than its
   * own, whatever its state; 404 otherwise) until it leaves, at most two hours (TenantActing); a tenant it
   * was inside is left first. No mobile or third-party session enters (403).
   */
  async enter(id: number, reason: string, req: Request): Promise<null> {
    const p = clsGet('principal')
    if (p?.clientId !== CONSOLE_CLIENT) throw new ForbiddenException()
    if (id === p.tenantId || !(await this.repo.existsBy({ id }))) throw new NotFoundException()
    const session = p.sid ? await this.tokens.load(p.sid) : null
    if (!session || !(await this.acting.enter(session, id, reason, req)))
      throw new UnauthorizedException()
    return null
  }

  /** POST /leave: the caller's session back in its own tenant; 403 when it is not inside another one. */
  async leave(req: Request): Promise<null> {
    const sid = clsGet('principal')?.sid
    const session = sid ? await this.tokens.load(sid) : null
    if (session?.actingTenantId === undefined) throw new ForbiddenException()
    if (!(await this.acting.leave(session, 'left', req))) throw new UnauthorizedException()
    return null
  }

  /** The tenant row locked for the write (404 when there is none). */
  private async locked(q: EntityManager, id: number): Promise<Tenant> {
    const row = await q
      .getRepository(Tenant)
      .findOne({ where: { id }, lock: { mode: 'pessimistic_write' } })
    if (!row) throw new NotFoundException()
    return row
  }

  /**
   * A tenant bound to the platform's own host name would take every sign-in on it, locking the platform
   * users out (their tokens are refused on a host bound to another tenant): the request's host and the
   * hosts of `CORS_ORIGIN` are never bound (422 B1016).
   */
  private assertNotPlatformHost(domains: readonly string[], host: string | undefined): void {
    const own = new Set(host ? [host.toLowerCase()] : [])
    for (const origin of (this.cfg.get('CORS_ORIGIN') ?? '').split(',')) {
      if (URL.canParse(origin.trim())) own.add(new URL(origin.trim()).hostname.toLowerCase())
    }
    if (domains.some((d) => own.has(d))) throw new BizError(Err.IAM_TENANT_DOMAIN_RESERVED)
  }

  /**
   * The logo: a live public `cover` object of the default tenant the caller uploaded and nothing else
   * holds, bound to the tenant so no cleanup takes it (400 C1009 otherwise, StorageService.bindRefs).
   */
  private async bindLogo(q: EntityManager, tid: number, objectId: number | null | undefined) {
    if (objectId == null) return
    // qw:cross-tenant every tenant's logo is an object of the default tenant, uploaded on this page
    await withTenant(DEFAULT_TENANT_ID, () =>
      this.storage.bindRefs([objectId], 'cover', `iam.tenant:${tid}`, caller() ?? 0, q),
    )
  }

  /**
   * A logo the tenant no longer shows, while still bound to it: deleted as any file (unpublished at once,
   * purged later), so no public object stays behind. Best effort: the change is committed already.
   */
  private async dropLogo(tid: number, objectId: number): Promise<void> {
    // qw:cross-tenant every tenant's logo is an object of the default tenant
    await withTenant(DEFAULT_TENANT_ID, async () => {
      const [held] = await this.ds.query<unknown[]>(
        'SELECT id FROM fs_object WHERE id = ? AND tenant_id = ? AND biz_ref = ? AND deleted_at IS NULL',
        [objectId, DEFAULT_TENANT_ID, `iam.tenant:${tid}`],
      )
      if (held) await this.storage.remove(objectId)
    }).catch((e: unknown) =>
      this.logger.warn(`logo object ${objectId} of tenant ${tid} not removed: ${String(e)}`),
    )
  }

  /** The rows as the API shows them: package name, live users, host names and the logo's URL. */
  private async vos(rows: Tenant[]): Promise<TenantVo[]> {
    if (!rows.length) return []
    const ids = rows.map((r) => r.id)
    const logoIds = rows.map((r) => r.logoObjectId).filter((v) => v !== null)
    const packageIds = rows.map((r) => r.packageId).filter((v) => v !== null)
    const [packages, users, domains, logos] = await Promise.all([
      packageIds.length
        ? this.ds.query<{ id: number; name: string }[]>(
            'SELECT id, name FROM iam_tenant_package WHERE id IN (?) AND deleted_at IS NULL',
            [packageIds],
          )
        : [],
      // qw:cross-tenant the live users of each listed tenant (platform page)
      this.ds.query<{ tid: number; n: number | string }[]>(
        // qw:no-data-scope platform page: each listed tenant's size
        `SELECT tenant_id AS tid, COUNT(*) AS n FROM iam_user
          WHERE tenant_id IN (?) AND deleted_at IS NULL GROUP BY tenant_id`,
        [ids],
      ),
      this.ds.query<{ tid: number; domain: string }[]>(
        `SELECT tenant_id AS tid, domain FROM iam_tenant_domain
          WHERE tenant_id IN (?) AND deleted_at IS NULL ORDER BY id`,
        [ids],
      ),
      logoIds.length
        ? this.ds.query<{ id: number; url: string | null }[]>(
            `SELECT id, public_url AS url FROM fs_object
              WHERE id IN (?) AND tenant_id = ? AND is_public = 1 AND deleted_at IS NULL`,
            [logoIds, DEFAULT_TENANT_ID],
          )
        : [],
    ])
    const packageName = new Map(packages.map((p) => [Number(p.id), p.name]))
    const userCount = new Map(users.map((u) => [Number(u.tid), Number(u.n)]))
    const logoUrl = new Map(logos.map((l) => [Number(l.id), l.url]))
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      packageId: r.packageId,
      packageName: r.packageId === null ? null : (packageName.get(r.packageId) ?? null),
      enabled: r.enabled,
      expiresAt: r.expiresAt?.toISOString() ?? null,
      userQuota: r.userQuota,
      userCount: userCount.get(r.id) ?? 0,
      domains: domains.filter((d) => Number(d.tid) === r.id).map((d) => d.domain),
      brandName: r.brandName,
      logoObjectId: r.logoObjectId,
      logoUrl: r.logoObjectId === null ? null : (logoUrl.get(r.logoObjectId) ?? null),
      ownerUserId: r.ownerUserId,
      note: r.note,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
      updatedBy: r.updatedBy,
      updatedAt: r.updatedAt.toISOString(),
    }))
  }
}
