import { NotFoundException } from '@nestjs/common'
import type { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import { Err, type ErrorDef, type Page } from '@qiwu/shared'
import {
  type DeepPartial,
  type EntityTarget,
  type FindOptionsWhere,
  Not,
  type ObjectLiteral,
  type QueryDeepPartialEntity,
  type Repository,
  type SelectQueryBuilder,
} from 'typeorm'
import { clsGet } from '../context/cls.js'
import {
  applyScopes,
  dataScopeOf,
  defaultScopeRules,
  type ScopeRule,
} from '../data-scope/data-scope.js'
import { BizError } from '../http/biz-error.js'
import { exportBatches, type PageParams, paginate, sorted } from './page.js'
import { assertReferencesLive, softDeleteRows } from './references.js'

/** Rows per `exportRows` batch. */
export const EXPORT_BATCH = 1000

/**
 * CRUD base (see docs/design-notes.md#layering). The single data-scope hook (see docs/design-notes.md#data-scope): every read of a `@DataScoped` entity
 * goes through `scopedQb` (list, get, export, options), every write by id first through
 * `lockScopedIds`, then writes by primary key; create/update values pass `assertWritableScope`.
 * Subclasses override what they need (filters, joins, relations) and keep going through these.
 */
export abstract class BaseCrudService<E extends ObjectLiteral & { id: number }> {
  /** Rule chain applied to scoped entities; subclasses may replace it. */
  protected scopeRules: readonly ScopeRule[] = defaultScopeRules()

  constructor(
    protected readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    protected readonly entity: EntityTarget<E> & object,
  ) {}

  /** Repository bound to the current `@Transactional()` transaction, if any. */
  protected get repo(): Repository<E> {
    return this.txHost.tx.getRepository(this.entity)
  }

  /** Query builder with the caller's data scope applied (soft-deleted rows are excluded by TypeORM). */
  scopedQb(alias: string): SelectQueryBuilder<E> {
    const qb = this.repo.createQueryBuilder(alias)
    const columns = dataScopeOf(this.entity)
    return columns ? applyScopes(qb, alias, columns, this.scopeRules) : qb
  }

  /**
   * The list filters of `query` (alias `t`) that `page` and `exportRows` share; none by default.
   * Add conditions with `andWhere` only: `where` would replace the data scope already on `qb`.
   */
  protected filter(qb: SelectQueryBuilder<E>, _query: object): SelectQueryBuilder<E> {
    return qb
  }

  /** One page of the caller's rows, filtered; `columns` maps sort fields (see `sorted`). */
  page<F extends string>(
    query: PageParams<F>,
    columns?: Partial<Record<F, string>>,
  ): Promise<Page<E>> {
    return paginate(this.filter(this.scopedQb('t'), query), query, columns)
  }

  /**
   * Every filtered row of the caller's scope in list order, `EXPORT_BATCH` rows at a time (ExcelService
   * renders them as they come), so an export never holds the whole table (`exportBatches`: keyset batches
   * on the default id order, rows written during the export never shift a batch).
   */
  exportRows<F extends string>(
    query: Pick<PageParams<F>, 'sort'>,
    columns?: Partial<Record<F, string>>,
  ): AsyncGenerator<E[]> {
    return exportBatches(
      () => sorted(this.filter(this.scopedQb('t'), query), query.sort, columns),
      EXPORT_BATCH,
    )
  }

  /** One row of the caller's scope; missing or out of scope → 404 (existence is not leaked). */
  async get(id: number): Promise<E> {
    const row = await this.scopedQb('t').andWhere('t.id = :id', { id }).getOne()
    if (!row) throw new NotFoundException()
    return row
  }

  /**
   * Always an insert (an `id` in the DTO is dropped: save() would update that row unlocked). The new
   * row is owned by the caller: AuditSubscriber sets `created_by` from the CLS principal. Every
   * registered reference it holds must name a live row (`assertReferencesLive`, 404).
   */
  create(dto: DeepPartial<E>): Promise<E> {
    return this.txHost.withTransaction(async () => {
      const row = { ...dto, id: undefined }
      await this.assertWritableScope({ ...row, createdBy: clsGet('principal')?.userId ?? null })
      await assertReferencesLive(this.txHost.tx, this.repo.metadata.tableName, row)
      return this.repo.save(this.repo.create(row))
    })
  }

  /**
   * Locks the row in scope, then writes by primary key; a DTO that sets a scoped column (dept, owner)
   * must leave the row in scope too (`assertWritableScope` on the stored row + the DTO), a reference
   * it changes must name a live row (`assertReferencesLive`, 404).
   */
  update(id: number, dto: QueryDeepPartialEntity<E>): Promise<void> {
    return this.txHost.withTransaction(async () => {
      await this.lockScopedIds([id])
      const set = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined))
      let row: E | undefined
      const stored = async () =>
        (row ??= await this.repo.findOneByOrFail({ id } as FindOptionsWhere<E>))
      const columns = dataScopeOf(this.entity)
      if (columns && [columns.dept, columns.owner].some((c) => c && this.propOf(c) in set)) {
        // created_by is write-once (AuditSubscriber drops it from updates): judge the stored owner
        const before = await stored()
        await this.assertWritableScope({ ...before, ...set, createdBy: before.createdBy })
      }
      await assertReferencesLive(this.txHost.tx, this.repo.metadata.tableName, set, stored)
      if (Object.keys(set).length) await this.repo.update(id, set as QueryDeepPartialEntity<E>)
    })
  }

  /**
   * Soft delete: any id out of scope → 404, a row still referenced → 409 `in_use` (core/db/
   * references.ts), and nothing is deleted; cascaded rows go with them.
   */
  remove(ids: readonly number[]): Promise<void> {
    return this.txHost.withTransaction(async () => {
      await this.lockScopedIds(ids)
      await this.deleteRows([...new Set(ids)])
    })
  }

  /** Soft-deletes the rows `ids`, locked by the caller: `softDeleteRows` on the entity's table. */
  protected deleteRows(ids: readonly number[]): Promise<void> {
    return softDeleteRows(this.txHost.tx, this.repo.metadata.tableName, ids)
  }

  /**
   * Locks the rows `ids` inside the current transaction (`SELECT … FOR UPDATE` through `scopedQb`);
   * any id missing or out of scope → 404 for the whole batch (existence is not leaked).
   */
  async lockScopedIds(ids: readonly number[]): Promise<void> {
    // getRawMany does not enforce it, and FOR UPDATE in autocommit releases the lock at once
    if (!this.txHost.isTransactionActive()) throw new Error('lockScopedIds needs a transaction')
    const wanted = [...new Set(ids)]
    if (!wanted.length) return
    const rows = await this.scopedQb('t')
      .select('t.id', 'id')
      .andWhere('t.id IN (:...lockIds)', { lockIds: wanted })
      .setLock('pessimistic_write')
      .getRawMany<{ id: number }>()
    if (rows.length !== wanted.length) throw new NotFoundException()
  }

  /**
   * Create/update (see docs/design-notes.md#data-scope): `row` = the row as the write leaves it (update: stored row + DTO;
   * create: DTO + `createdBy` = me) must be visible to the caller. Judged by the read rule chain on a
   * one-row derived table `{dept, owner}`, so reads and writes never disagree: the dept must be
   * picked / mine / under mine, or (`own_rows`) the owner me; an unset dept/owner counts as NULL.
   * Outside → 404, like any out-of-scope id.
   */
  async assertWritableScope(row: object): Promise<void> {
    const columns = dataScopeOf(this.entity)
    if (!columns) return
    const valueOf = (column: string | null) =>
      column ? ((row as Record<string, unknown>)[this.propOf(column)] ?? null) : null
    const derived = [
      columns.dept && `:wDept AS ${columns.dept}`,
      columns.owner && `:wOwner AS ${columns.owner}`,
    ].filter(Boolean)
    const qb = this.txHost.tx
      .createQueryBuilder()
      .select('1', 'ok')
      .from(`(SELECT ${derived.join(', ')})`, 'w') // arch-allow: sql-concat column identifiers from @DataScoped; values are :params
      .setParameters({ wDept: valueOf(columns.dept), wOwner: valueOf(columns.owner) })
    if (!(await applyScopes(qb, 'w', columns, this.scopeRules).getRawOne()))
      throw new NotFoundException()
  }

  /** Entity property of a DB column (`dept_id` → `deptId`). */
  private propOf(column: string): string {
    return this.repo.metadata.findColumnWithDatabaseName(column)?.propertyName ?? column
  }

  /**
   * 409 `err` (default `Err.DUPLICATE`, params `{ [field]: value }`) when another live row already holds
   * `value` in `field`; `excludeId` = the row being updated. Checks the whole table, not the caller's
   * scope, like the DB unique index it mirrors (`unique(col, alive)`; soft-deleted rows don't count).
   * The index stays the real guard: a race still ends as errno 1062 → 409.
   */
  async assertUnique<K extends keyof E & string>(
    field: K,
    value: E[K],
    excludeId?: number,
    err: ErrorDef = Err.DUPLICATE,
  ): Promise<void> {
    const where = { [field]: value, ...(excludeId === undefined ? {} : { id: Not(excludeId) }) }
    if (await this.repo.exists({ where: where as FindOptionsWhere<E> }))
      throw new BizError(err, { [field]: value })
  }
}
