import { Err } from '@qiwu/shared'
import type {
  DeepPartial,
  FindOptionsWhere,
  ObjectLiteral,
  QueryDeepPartialEntity,
  SelectQueryBuilder,
} from 'typeorm'
import { BizError } from '../http/biz-error.js'
import { BaseCrudService } from './base-crud.service.js'
import { assertReferencesLive } from './references.js'

/**
 * A tree table row: `parent_id` (0 = top level) and `tree_path` (`/1/5/9/`: the ids of the
 * ancestors and itself, always ending with `/`). `enabled` and `sortNo` are optional columns.
 */
export interface TreeEntity extends ObjectLiteral {
  id: number
  parentId: number
  treePath: string
  enabled?: boolean
  sortNo?: number
}

export type TreeNode<T> = T & { children: TreeNode<T>[] }

/**
 * Ordered rows as a forest, children in row order: a row whose parent is not among `rows` (filtered out,
 * out of scope, disabled) is a root.
 */
export function forest<T extends { id: number; parentId: number }>(rows: T[]): TreeNode<T>[] {
  const nodes = new Map<number, TreeNode<T>>(rows.map((r) => [r.id, { ...r, children: [] }]))
  const roots: TreeNode<T>[] = []
  for (const n of nodes.values()) (nodes.get(n.parentId)?.children ?? roots).push(n)
  return roots
}

/** The ids of the ancestors of the row with `treePath`, top first (itself excluded). */
const ancestorsOf = (treePath: string): number[] =>
  treePath.split('/').filter(Boolean).map(Number).slice(0, -1)

/**
 * CRUD of a tree table (`tree` template, extracted from iam/dept; see docs/design-notes.md#codegen) over BaseCrudService: the
 * same data-scope hook (every read through `scopedQb`, every write after `lockScopedIds`), plus the tree
 * rules every tree module shares:
 * - `list(query)`: the caller's rows matching `filter()` as a forest (not paged), siblings by `sort_no, id`;
 * - create: the parent (0 = top level) must be the caller's and enabled; `tree_path` = parent's + own id;
 *   every registered reference the row holds must name a live row (`assertReferencesLive`, 404; update too);
 * - update: a new parent moves the node with its whole subtree in ONE statement (never below itself);
 *   enabling enables its disabled ancestors, disabling needs no enabled child;
 * - remove: no children left (deleting a parent with all its children in one call is fine).
 * A write is judged by the rows as it leaves them: every row it created, moved or changed must still be
 * visible to the caller (`lockScopedIds` again before the commit; else 404 and nothing is kept) — the
 * `assertWritableScope` rule (see docs/design-notes.md#data-scope) for tables whose scope column is the row's own id (`iam_dept`),
 * whose id is unknown before the insert. Every read inside a write is a locking read, so concurrent moves,
 * adds and enables see each other's committed paths.
 * Module hooks (defaults do nothing): `beforeWrite` (checks of the module's own columns, inside the
 * transaction), `beforeRemove` (references that block a delete), `afterMove` (after the commit).
 * Paths longer than the 512-character column are refused before writing (422), including deleted
 * descendants of a moved subtree.
 */
export abstract class BaseTreeService<E extends TreeEntity> extends BaseCrudService<E> {
  /** GET / (browse): the caller's rows matching `filter()` as a forest. */
  async list(query: object): Promise<TreeNode<E>[]> {
    return forest(await this.rows(query))
  }

  /** The caller's rows matching `filter()`, in siblings' order. */
  protected rows(query: object): Promise<E[]> {
    return this.ordered(this.filter(this.scopedQb('t'), query)).getMany()
  }

  /** Siblings' order on a query of alias `t`: `sort_no` (when the table has it), then `id`. */
  protected ordered(qb: SelectQueryBuilder<E>): SelectQueryBuilder<E> {
    if (this.has('sortNo')) qb.addOrderBy('t.sortNo')
    return qb.addOrderBy('t.id')
  }

  /** Under an enabled parent of the caller's scope (0 = top level); the new row must be the caller's. */
  override create(dto: DeepPartial<E>): Promise<E> {
    return this.txHost.withTransaction(async () => {
      const parentId = Number(dto.parentId ?? 0)
      const parent = parentId ? (await this.lockRows([parentId]))[0]! : null
      if (parent && this.has('enabled') && !parent.enabled)
        throw new BizError(Err.TREE_PARENT_DISABLED)
      await this.beforeWrite(dto as Partial<E>)
      await assertReferencesLive(this.txHost.tx, this.repo.metadata.tableName, dto)
      // '/' until the id is known (the path ends with it)
      const row = await this.repo.save(
        this.repo.create({ ...dto, id: undefined, parentId, treePath: '/' }),
      )
      const path = `${parent?.treePath ?? '/'}${row.id}/`
      if (path.length > 512) throw new BizError(Err.TREE_PATH_TOO_LONG)
      await this.repo.update(row.id, {
        treePath: path,
      } as unknown as QueryDeepPartialEntity<E>)
      await this.lockScopedIds([row.id])
      // as stored (the path update moved updated_at too): what GET /:id answers
      return this.repo.findOneByOrFail({ id: row.id } as FindOptionsWhere<E>)
    })
  }

  /**
   * The fields sent change (`treePath` never directly). A new `parentId` moves the subtree, `enabled`
   * follows the tree rules; the moved subtree and the row must stay the caller's. `afterMove` runs after
   * the commit with the moved ids.
   */
  override async update(id: number, dto: QueryDeepPartialEntity<E>): Promise<void> {
    const moved = await this.txHost.withTransaction(async () => {
      const [stored] = await this.lockRows([id])
      // treePath only ever changes by a move
      const set = Object.fromEntries(
        Object.entries(dto).filter(([k, v]) => v !== undefined && k !== 'id' && k !== 'treePath'),
      ) as Partial<E>
      const parentId = set.parentId === undefined ? stored!.parentId : Number(set.parentId)
      const subtree = parentId === stored!.parentId ? [] : await this.move(stored!, parentId)
      if (this.has('enabled') && set.enabled !== undefined && set.enabled !== stored!.enabled) {
        if (set.enabled) await this.enableAncestors(stored!.treePath)
        else await this.assertNoEnabledChild(id)
      }
      await this.beforeWrite(set, stored)
      await assertReferencesLive(
        this.txHost.tx,
        this.repo.metadata.tableName,
        set,
        async () => stored!,
      )
      if (Object.keys(set).length) await this.repo.update(id, set as QueryDeepPartialEntity<E>)
      // the rows as the write leaves them are still the caller's
      await this.lockScopedIds([id, ...subtree])
      return subtree
    })
    if (moved.length) await this.afterMove(moved)
  }

  /**
   * All or nothing: no child may stay behind (409 `tree.has_children`), then `beforeRemove`, then the soft
   * delete with its reference checks (`deleteRows`).
   */
  override remove(ids: readonly number[]): Promise<void> {
    const byId = [...new Set(ids)]
    return this.txHost.withTransaction(async () => {
      await this.lockScopedIds(byId)
      if (!byId.length) return
      const child = await this.repo
        .createQueryBuilder('t')
        .select('t.id')
        .where('t.parentId IN (:...ids) AND t.id NOT IN (:...ids)', { ids: byId })
        .setLock('pessimistic_read')
        .getOne()
      if (child) throw new BizError(Err.TREE_HAS_CHILDREN)
      await this.beforeRemove(byId)
      await this.deleteRows(byId)
    })
  }

  /**
   * Hook: checks of the module's own columns inside the write transaction, before the row is written;
   * `set` = the fields being written, `stored` = the locked row (update) or none (create).
   */
  protected async beforeWrite(_set: Partial<E>, _stored?: E): Promise<void> {}

  /** Hook: rows elsewhere that keep the locked `ids` from being deleted (throw to refuse). */
  protected async beforeRemove(_ids: number[]): Promise<void> {}

  /** Hook, after the commit: `ids` = the moved row and every row under it (their paths changed). */
  protected async afterMove(_ids: number[]): Promise<void> {}

  /**
   * Locks `ids` in the caller's scope (404 for any missing or out of scope, like `lockScopedIds`) and
   * returns their current rows (a locking read: never an older snapshot).
   */
  protected async lockRows(ids: readonly number[]): Promise<E[]> {
    await this.lockScopedIds(ids)
    return this.repo
      .createQueryBuilder('t')
      .where('t.id IN (:...ids)', { ids: [...new Set(ids)] })
      .setLock('pessimistic_write')
      .getMany()
  }

  /**
   * Moves `stored` under `parentId` (0 = top level) with its subtree: every live row of the subtree and the
   * new parent must be the caller's (404), the parent enabled and not in the subtree (422). One UPDATE
   * rewrites the path prefix of the whole subtree (soft-deleted rows too, so paths stay consistent).
   * Returns the live subtree ids, `stored.treePath` becomes the new path.
   */
  protected async move(stored: E, parentId: number): Promise<number[]> {
    const old = stored.treePath
    const subtree = (
      await this.repo
        .createQueryBuilder('t')
        .select('t.id', 'id')
        .where('t.treePath LIKE :old', { old: `${old}%` })
        .setLock('pessimistic_write')
        .getRawMany<{ id: number }>()
    ).map((r) => Number(r.id))
    await this.lockScopedIds(subtree)
    let parentPath = '/'
    if (parentId !== 0) {
      const [parent] = await this.lockRows([parentId])
      // paths end with '/': /1/2/ is never a prefix of /1/23/
      if (parent!.treePath.startsWith(old)) throw new BizError(Err.TREE_PARENT_INVALID)
      if (this.has('enabled') && !parent!.enabled) throw new BizError(Err.TREE_PARENT_DISABLED)
      parentPath = parent!.treePath
    }
    const path = `${parentPath}${stored.id}/`
    // qw:include-deleted — the prefix UPDATE also rewrites soft-deleted descendants.
    // A locking read sees current paths after the scope/parent locks, not an older snapshot.
    const longest = await this.repo
      .createQueryBuilder('t')
      .withDeleted()
      .select('MAX(CHAR_LENGTH(t.treePath))', 'length')
      .where('t.treePath LIKE :old', { old: `${old}%` })
      .setLock('pessimistic_write')
      .getRawOne<{ length: number }>()
    if (path.length + Number(longest!.length) - old.length > 512)
      throw new BizError(Err.TREE_PATH_TOO_LONG)
    await this.repo
      .createQueryBuilder()
      .update()
      .set({ treePath: () => 'CONCAT(:path, SUBSTRING(tree_path, :cut))' } as never)
      .where('tree_path LIKE :old', { old: `${old}%` })
      .setParameters({ path, cut: old.length + 1 })
      .execute()
    stored.treePath = path
    return subtree
  }

  /** Enables the disabled ancestors of the row at `treePath`; each must be the caller's (404). */
  protected async enableAncestors(treePath: string): Promise<void> {
    const ancestors = ancestorsOf(treePath)
    if (!ancestors.length) return
    // enabled ancestors outside the caller's scope stay untouched and need not be visible
    const disabled = (
      await this.repo
        .createQueryBuilder('t')
        .select(['t.id', 't.enabled'])
        .where('t.id IN (:...ids)', { ids: ancestors })
        .setLock('pessimistic_write')
        .getMany()
    )
      .filter((r) => !r.enabled)
      .map((r) => r.id)
    if (!disabled.length) return
    await this.lockScopedIds(disabled)
    await this.repo.update(disabled, { enabled: true } as unknown as QueryDeepPartialEntity<E>)
  }

  protected async assertNoEnabledChild(id: number): Promise<void> {
    const child = await this.repo
      .createQueryBuilder('t')
      .select('t.id')
      .where('t.parentId = :id AND t.enabled = :on', { id, on: true })
      .setLock('pessimistic_read')
      .getOne()
    if (child) throw new BizError(Err.TREE_CHILD_ENABLED)
  }

  /** Whether the entity maps the property (`enabled`, `sortNo` are optional tree columns). */
  protected has(prop: 'enabled' | 'sortNo'): boolean {
    return !!this.repo.metadata.findColumnWithPropertyName(prop)
  }
}
