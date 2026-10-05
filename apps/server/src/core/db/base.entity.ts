import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  type ValueTransformer,
} from 'typeorm'

/**
 * The key and the soft-delete mark every table has: deleting a row writes `deleted_at`
 * (core/db/references.ts `softDeleteRows`), and repository / query-builder reads leave such rows out by
 * themselves (raw SQL names `deleted_at` itself, `pnpm arch:check` soft-delete-sql). Uniqueness among live
 * rows uses the DDL-only generated column `alive tinyint as (if(deleted_at is null,1,null)) virtual` +
 * `unique(<col>, alive)`; entities never map `alive`.
 * Alone: an append-only table (logs; see docs/design-notes.md#audit) without `created_at`; rows are inserted by the server,
 * never edited through a page, so there are no audit columns (the generator's append-only path,
 * docs/codegen-golden.md).
 */
export abstract class IdEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: number

  @DeleteDateColumn({ name: 'deleted_at', type: 'datetime', precision: 3 })
  deletedAt: Date | null
}

/** An append-only table with `created_at` (when the row was written). */
export abstract class CreatedEntity extends IdEntity {
  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date
}

/** + audit columns; `created_by`/`updated_by` are filled by AuditSubscriber. */
export abstract class BaseEntity extends IdEntity {
  @Column({ name: 'created_by', type: 'bigint', unsigned: true, nullable: true })
  createdBy: number | null

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date

  @Column({ name: 'updated_by', type: 'bigint', unsigned: true, nullable: true })
  updatedBy: number | null

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt: Date
}

/**
 * DECIMAL columns as numbers: mysql2 returns DECIMAL as a string (exact); the generated CRUD code and its
 * zod schemas use numbers. A JS number holds 15-16 significant digits; keep strings for wider
 * decimals.
 */
export const decimalNumber: ValueTransformer = {
  to: (value: unknown) => value,
  from: (value: unknown) => (value === null || value === undefined ? value : Number(value)),
}
