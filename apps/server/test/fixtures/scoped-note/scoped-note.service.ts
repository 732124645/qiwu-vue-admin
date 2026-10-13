import { Injectable } from '@nestjs/common'
import { TransactionHost, Transactional } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import type { Page } from '@qiwu/shared'
import { deptScopeRule, SkipDataScope } from '../../../src/core/data-scope/data-scope.js'
import { BaseCrudService } from '../../../src/core/db/base-crud.service.js'
import { type PageParams, paginate } from '../../../src/core/db/page.js'
import { ScopedNote } from './scoped-note.entity.js'

@Injectable()
export class ScopedNoteService extends BaseCrudService<ScopedNote> {
  // the fixture's own dept tree stands in for iam_dept
  protected override scopeRules = [deptScopeRule('test_dept')]

  constructor(txHost: TransactionHost<TransactionalAdapterTypeOrm>) {
    super(txHost, ScopedNote)
  }

  /** GET /with-dept: the base page with each note's dept (a join of a tenant table). */
  pageWithDept(query: PageParams<string>): Promise<Page<ScopedNote>> {
    return paginate(this.filter(this.scopedQb('t').leftJoinAndSelect('t.dept', 'd'), query), query)
  }

  /** POST /upsert: like a generated import, the row of that title the caller's scope sees is updated, else one is created. */
  async upsert(dto: { title: string; deptId?: number | null }): Promise<void> {
    const found = await this.scopedQb('t')
      .select('t.id')
      .andWhere('t.title = :title', { title: dto.title })
      .getOne()
    await (found ? this.update(found.id, dto) : this.create(dto))
  }

  /** POST /clean: every live row of the tenant soft-deleted, by a QueryBuilder without WHERE. */
  async clean(): Promise<void> {
    await this.repo.createQueryBuilder().softDelete().execute()
  }

  /** GET /options: id + title of the caller's rows. */
  options(): Promise<Pick<ScopedNote, 'id' | 'title'>[]> {
    return this.scopedQb('n').select(['n.id', 'n.title']).orderBy('n.id').getMany()
  }

  /** A system job's view: every live row of the tenant, whoever (if anyone) calls. */
  @SkipDataScope()
  countAll(): Promise<number> {
    return this.scopedQb('n').getCount()
  }

  /** Inserts a row, sees it inside the transaction, then fails: the insert must roll back. */
  @Transactional()
  async createThenFail(title: string): Promise<never> {
    await this.repo.save(this.repo.create({ title }))
    const seen = await this.repo.countBy({ title })
    throw new Error(`rollback probe (rows seen inside the transaction: ${seen})`)
  }
}
