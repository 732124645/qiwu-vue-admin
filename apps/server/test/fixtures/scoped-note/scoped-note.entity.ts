import { Column, Entity, JoinColumn, ManyToOne, type Relation } from 'typeorm'
import { DataScoped } from '../../../src/core/data-scope/data-scope.js'
import { BaseEntity } from '../../../src/core/db/base.entity.js'
import { referencedBy } from '../../../src/core/db/references.js'
import { TestDept } from './test-dept.entity.js'

// the reference registry's kinds (core-db spec): a note's own links go with it (cascade), a note another
// note links to is in use (restrict); a dept with sub-depts is in use (a table referencing itself), its
// notes go with it (cascade into a referenced table: two levels) and must be live to be written into
referencedBy(
  'test_scoped_note',
  { table: 'test_note_link', column: 'note_id', cascade: true },
  { table: 'test_note_link', column: 'target_id' },
)
referencedBy(
  'test_dept',
  { table: 'test_dept', column: 'parent_id' },
  { table: 'test_scoped_note', column: 'dept_id', cascade: true },
)

/** Test-only data-scoped entity (see docs/design-notes.md#data-scope); `alive` exists in the DDL only. */
@DataScoped({ dept: 'dept_id', owner: 'created_by' })
@Entity('test_scoped_note')
export class ScopedNote extends BaseEntity {
  @Column()
  title: string

  @Column({ name: 'dept_id', type: 'bigint', unsigned: true, nullable: true })
  deptId: number | null

  @ManyToOne(() => TestDept, (dept) => dept.notes)
  @JoinColumn({ name: 'dept_id' })
  dept: Relation<TestDept> | null
}
