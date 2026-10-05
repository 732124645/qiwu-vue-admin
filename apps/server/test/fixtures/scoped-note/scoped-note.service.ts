import { Injectable } from '@nestjs/common'
import { TransactionHost, Transactional } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  deptScopeRule,
  SkipDataScope,
  tenantRule,
} from '../../../src/core/data-scope/data-scope.js'
import { BaseCrudService } from '../../../src/core/db/base-crud.service.js'
import { ScopedNote } from './scoped-note.entity.js'

@Injectable()
export class ScopedNoteService extends BaseCrudService<ScopedNote> {
  // the fixture's own dept tree stands in for iam_dept
  protected override scopeRules = [deptScopeRule('test_dept'), tenantRule]

  constructor(txHost: TransactionHost<TransactionalAdapterTypeOrm>) {
    super(txHost, ScopedNote)
  }

  /** GET /options: id + title of the caller's rows. */
  options(): Promise<Pick<ScopedNote, 'id' | 'title'>[]> {
    return this.scopedQb('n').select(['n.id', 'n.title']).orderBy('n.id').getMany()
  }

  /** A system job's view: every live row, whoever (if anyone) calls. */
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
