import { Injectable, NotFoundException } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import { Err, type DeptQuery, type DeptTreeNode } from '@qiwu/shared'
import type { DeepPartial, SelectQueryBuilder } from 'typeorm'
import { PermVersion } from '../../../../core/auth/perm-version.js'
import { applyScopes, dataScopeOf } from '../../../../core/data-scope/data-scope.js'
import { BaseTreeService, forest, type TreeNode } from '../../../../core/db/base-tree.service.js'
import { contains } from '../../../../core/db/page.js'
import { BizError } from '../../../../core/http/biz-error.js'
import { seedKeysLike } from '../../../../core/i18n/seed-names.js'
import { User } from '../user/user.entity.js'
import { Dept } from './dept.entity.js'

/** A dept with the display name of its head (joined, read-only). */
export type DeptRow = Dept & { headUserName: string | null }

/**
 * Departments, the tree golden sample (docs/codegen-golden.md "Tree"): the tree rules and the data scope
 * (a dept is scoped by its own id; see docs/design-notes.md#data-scope) come from BaseTreeService; this class adds only the dept's
 * own parts: the name filter (seeded names match their text too), the head's name, the head as a user of
 * the caller's scope, no delete while users belong to the dept, and live sessions after a move.
 */
@Injectable()
export class DeptService extends BaseTreeService<Dept> {
  constructor(
    txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly permVersion: PermVersion,
  ) {
    super(txHost, Dept)
  }

  protected override filter(
    qb: SelectQueryBuilder<Dept>,
    { name, enabled }: Partial<DeptQuery>,
  ): SelectQueryBuilder<Dept> {
    if (name) {
      // seeded names are keys (seed.dept.*): also match the text users see, in any language
      const seeded = seedKeysLike('seed.dept.', name)
      qb.andWhere(
        seeded.length ? '(t.name LIKE :name OR t.name IN (:...seeded))' : 't.name LIKE :name',
        { name: contains(name), seeded },
      )
    }
    if (enabled !== undefined) qb.andWhere('t.enabled = :enabled', { enabled })
    return qb
  }

  override async list(query: DeptQuery): Promise<TreeNode<DeptRow>[]> {
    return forest(await this.withHead(await this.rows(query)))
  }

  /** GET /:id: one dept of the caller's scope with its head's name (404 otherwise). */
  async detail(id: number): Promise<DeptRow> {
    return (await this.withHead([await this.get(id)]))[0]!
  }

  /** POST: the created dept as GET /:id shows it. */
  async add(dto: DeepPartial<Dept>): Promise<DeptRow> {
    return this.detail((await this.create(dto)).id)
  }

  /**
   * GET /tree (any signed-in user: filters and pickers): enabled depts of the caller's data scope as a
   * forest; a dept whose parent is not in the result (out of scope or disabled) is a root.
   */
  async tree(): Promise<DeptTreeNode[]> {
    const rows = await this.ordered(
      this.scopedQb('t')
        .select(['t.id', 't.parentId', 't.name'])
        .andWhere('t.enabled = :enabled', { enabled: true }),
    ).getMany()
    return forest(rows.map(({ id, parentId, name }) => ({ id, parentId, name })))
  }

  /**
   * A new head must be a live user of the caller's scope for this route's perm (the UserPicker offers no
   * others), else 404; an unchanged head is not judged again (someone with a wider scope may have set it).
   */
  protected override async beforeWrite(set: Partial<Dept>, stored?: Dept): Promise<void> {
    const head = set.headUserId
    if (head == null || head === stored?.headUserId) return
    if (!(await this.users().andWhere('u.id = :head', { head }).getExists()))
      throw new NotFoundException()
  }

  /** Users still in one of the depts (409); a locking read, so none moves in before the delete commits. */
  protected override async beforeRemove(ids: number[]): Promise<void> {
    const [user] = await this.txHost.tx.query<unknown[]>(
      'SELECT id FROM iam_user WHERE dept_id IN (?) AND deleted_at IS NULL LIMIT 1 FOR SHARE',
      [ids],
    )
    if (user) throw new BizError(Err.IAM_DEPT_HAS_USERS)
  }

  /**
   * Sessions carry their dept's `tree_path` (the `own_dept_tree` prefix; see docs/design-notes.md#data-scope): the users of every
   * moved dept reload at their next request. Others need nothing: scopes read the paths live.
   */
  protected override async afterMove(ids: number[]): Promise<void> {
    const users = await this.txHost.tx.query<{ id: number }[]>(
      'SELECT id FROM iam_user WHERE dept_id IN (?) AND deleted_at IS NULL',
      [ids],
    )
    await this.permVersion.bumpUsers(users.map((u) => Number(u.id)))
  }

  /**
   * Rows plus the display name of their head when the caller's scope sees that user (for this route's
   * perm), else null: a head set by someone with a wider scope keeps its id but never shows its name.
   */
  protected async withHead(rows: Dept[]): Promise<DeptRow[]> {
    const ids = [...new Set(rows.flatMap((r) => (r.headUserId ? [r.headUserId] : [])))]
    const users = ids.length
      ? await this.users()
          .select(['u.id', 'u.displayName'])
          .andWhere('u.id IN (:...ids)', { ids })
          .getMany()
      : []
    const names = new Map(users.map((u) => [u.id, u.displayName]))
    return rows.map((r) =>
      Object.assign(r, { headUserName: (r.headUserId && names.get(r.headUserId)) || null }),
    )
  }

  /** Live users of the caller's scope (`iam_user`'s `@DataScoped`, alias `u`). */
  protected users(): SelectQueryBuilder<User> {
    const qb = this.txHost.tx.getRepository(User).createQueryBuilder('u')
    return applyScopes(qb, 'u', dataScopeOf(User)!, this.scopeRules)
  }
}
