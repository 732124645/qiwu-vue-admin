import { Injectable, NotFoundException } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  Err,
  type Page,
  type RoleMenuNode,
  type TenantPackageCreate,
  type TenantPackageDetailVo,
  type TenantPackageOption,
  type TenantPackageQuery,
  type TenantPackageUpdate,
  type TenantPackageVo,
} from '@qiwu/shared'
import type { SelectQueryBuilder } from 'typeorm'
import { GRANT_SWITCHES, type Switch, switchedOff } from '../../../../core/auth/menu-features.js'
import { PermVersion } from '../../../../core/auth/perm-version.js'
import { AppConfigService } from '../../../../core/config/config.module.js'
import { BaseCrudService } from '../../../../core/db/base-crud.service.js'
import { forest } from '../../../../core/db/base-tree.service.js'
import { type LinkTable, replaceLinks } from '../../../../core/db/links.js'
import { contains } from '../../../../core/db/page.js'
import { BizError } from '../../../../core/http/biz-error.js'
import { seedKeysLike } from '../../../../core/i18n/seed-names.js'
import { packageMenuIds } from './package-menus.js'
import { TenantPackage } from './tenant-package.entity.js'

/** A package's menus (a platform join table: no tenant), written through core/db/links.ts. */
const PACKAGE_MENUS: LinkTable = {
  table: 'iam_tenant_package_menus',
  owner: 'package_id',
  target: 'menu_id',
}

const toVo = (r: TenantPackage, tenantCount: number): TenantPackageVo => ({
  id: r.id,
  name: r.name,
  enabled: r.enabled,
  note: r.note,
  tenantCount,
  createdBy: r.createdBy,
  createdAt: r.createdAt.toISOString(),
  updatedBy: r.updatedBy,
  updatedAt: r.updatedAt.toISOString(),
})

/**
 * Tenant packages over BaseCrudService (platform rows, see docs/design-notes.md#tenancy): the menus a
 * tenant other than the default one may use, enforced where a session is loaded (IamUserLookup) and in
 * the role grant tree (RoleService). A package holds live menus open to tenants only (unknown 404,
 * platform-only 422 `iam.tenant_package_platform_menu`), replaced whole. Name uniqueness is the DB's (409
 * `duplicate`); a package a tenant uses is not deleted (409 `in_use`, tenant-package.entity.ts). A change
 * of its menus or of `enabled` reloads every session after the commit (`bumpAll`): the sessions of its
 * tenants take the new set at their next request. Every session, not just those tenants': one counter
 * per tenant once tenants are many (docs/design-notes.md#tenancy).
 */
@Injectable()
export class TenantPackageService extends BaseCrudService<TenantPackage> {
  constructor(
    txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly permVersion: PermVersion,
    private readonly cfg: AppConfigService,
  ) {
    super(txHost, TenantPackage)
  }

  protected override filter(
    qb: SelectQueryBuilder<TenantPackage>,
    { name, enabled }: TenantPackageQuery,
  ): SelectQueryBuilder<TenantPackage> {
    if (name) {
      // the sample packages' names are keys (seed.tenantPackage.*): match the text users see too
      const seeded = seedKeysLike('seed.tenantPackage.', name)
      qb.andWhere(
        seeded.length ? '(t.name LIKE :name OR t.name IN (:...seeded))' : 't.name LIKE :name',
        { name: contains(name), seeded },
      )
    }
    if (enabled !== undefined) qb.andWhere('t.enabled = :enabled', { enabled })
    return qb
  }

  /** GET: a page of packages, each with the number of tenants using it. */
  async list(query: TenantPackageQuery): Promise<Page<TenantPackageVo>> {
    const { items, total } = await this.page(query)
    const counts = await this.tenantCounts(items.map((r) => r.id))
    return { items: items.map((r) => toVo(r, counts.get(r.id) ?? 0)), total }
  }

  /** GET /:id: the package and its live menus. */
  async detail(id: number): Promise<TenantPackageDetailVo> {
    const row = await this.get(id)
    const menus = await this.txHost.tx.query<{ menu_id: number }[]>(
      `SELECT pm.menu_id FROM iam_tenant_package_menus pm
         JOIN iam_menu m ON m.id = pm.menu_id AND m.deleted_at IS NULL
        WHERE pm.package_id = ? AND pm.deleted_at IS NULL ORDER BY pm.menu_id`,
      [id],
    )
    return {
      ...toVo(row, (await this.tenantCounts([id])).get(id) ?? 0),
      menuIds: menus.map((m) => Number(m.menu_id)),
    }
  }

  /** GET /options: the enabled packages, what a tenant may be given. */
  options(): Promise<TenantPackageOption[]> {
    return this.repo
      .createQueryBuilder('t')
      .select(['t.id', 't.name'])
      .where('t.enabled = :enabled', { enabled: true })
      .orderBy('t.name')
      .addOrderBy('t.id')
      .getMany()
  }

  /**
   * GET /menu-tree: every menu open to tenants (`platform_only = 0`) as a forest, for the grant tree;
   * 与角色授权树一样，`GRANT_SWITCHES` 里关闭的功能（如公众号模块未启用）连同其下级菜单都不列出，
   * 免得把一个不存在的模块配进套餐。
   */
  async menuTree(): Promise<RoleMenuNode[]> {
    const all = await this.txHost.tx.query<
      {
        id: number
        parent_id: number
        kind: RoleMenuNode['kind']
        name: string
        name_i18n: RoleMenuNode['nameI18n']
        perms: string | null
        enabled: number
        route_name: string | null
        tree_path: string
      }[]
    >(
      `SELECT id, parent_id, kind, name, name_i18n, perms, enabled, route_name, tree_path FROM iam_menu
        WHERE platform_only = 0 AND deleted_at IS NULL ORDER BY sort_no, id`,
    )
    const on = (s: Switch) => !GRANT_SWITCHES.has(s) || this.cfg.get(s)
    const hidden = all.filter((r) => switchedOff(r.route_name, on)).map((r) => `/${r.id}/`)
    const rows = all.filter((r) => !hidden.some((path) => r.tree_path.includes(path)))
    return forest(
      rows.map((r) => ({
        id: Number(r.id),
        parentId: Number(r.parent_id),
        kind: r.kind,
        name: r.name,
        nameI18n: r.name_i18n,
        perms: r.perms,
        enabled: Number(r.enabled) === 1,
      })),
    )
  }

  /** POST: the package with its menus. */
  async add({ menuIds, ...dto }: TenantPackageCreate): Promise<TenantPackageVo> {
    const { id } = await this.txHost.withTransaction(async () => {
      const created = await this.create(dto)
      await this.setMenus(created.id, menuIds)
      return created
    })
    return toVo(await this.get(id), 0)
  }

  /** PUT /:id: the fields sent; `menuIds` replaces its menus. */
  async change(id: number, { menuIds, ...dto }: TenantPackageUpdate): Promise<void> {
    const reload = await this.txHost.withTransaction(async () => {
      await this.lockScopedIds([id])
      const stored = await this.repo.findOneByOrFail({ id })
      await this.update(id, dto)
      if (menuIds) await this.setMenus(id, menuIds)
      return menuIds !== undefined || (dto.enabled !== undefined && dto.enabled !== stored.enabled)
    })
    if (reload) await this.permVersion.bumpAll()
  }

  /** The menus tenant `tenantId` may use, in the caller's transaction (`packageMenuIds`). */
  menusOf(tenantId: number): Promise<Set<number> | null> {
    return packageMenuIds(this.txHost.tx, tenantId)
  }

  /**
   * Replaces the menus of package `id` (locked) with `menuIds`: each a live menu (404), none
   * platform-only (422). Read FOR SHARE until the commit: a menu deleted meanwhile either waits for this
   * write and then takes its row along, or is seen deleted here.
   */
  private async setMenus(id: number, menuIds: readonly number[]): Promise<void> {
    const ids = [...new Set(menuIds)]
    const tx = this.txHost.tx
    const menus = ids.length
      ? await tx.query<{ platform_only: number }[]>(
          'SELECT platform_only FROM iam_menu WHERE id IN (?) AND deleted_at IS NULL FOR SHARE',
          [ids],
        )
      : []
    if (menus.length !== ids.length) throw new NotFoundException()
    if (menus.some((m) => Number(m.platform_only) === 1))
      throw new BizError(Err.IAM_TENANT_PACKAGE_PLATFORM_MENU)
    await replaceLinks(tx, PACKAGE_MENUS, id, ids)
  }

  /** Package id → the live tenants using it. */
  private async tenantCounts(ids: readonly number[]): Promise<Map<number, number>> {
    if (!ids.length) return new Map()
    const rows = await this.txHost.tx.query<{ package_id: number; n: number }[]>(
      `SELECT package_id, COUNT(*) AS n FROM iam_tenant
        WHERE package_id IN (?) AND deleted_at IS NULL GROUP BY package_id`,
      [ids],
    )
    return new Map(rows.map((r) => [Number(r.package_id), Number(r.n)]))
  }
}
