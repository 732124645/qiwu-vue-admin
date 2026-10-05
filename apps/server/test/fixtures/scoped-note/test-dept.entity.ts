import { Column, Entity, OneToMany, PrimaryGeneratedColumn, type Relation } from 'typeorm'
import { ScopedNote } from './scoped-note.entity.js'

/** Minimal dept tree (`test_dept`), stands in for iam_dept; circular relation with ScopedNote. */
@Entity('test_dept')
export class TestDept {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: number

  @Column({ name: 'parent_id', type: 'bigint', unsigned: true })
  parentId: number

  @Column({ name: 'tree_path' })
  treePath: string

  @Column()
  name: string

  @OneToMany(() => ScopedNote, (note) => note.dept)
  notes: Relation<ScopedNote>[]
}
