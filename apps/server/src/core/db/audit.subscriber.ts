import {
  EventSubscriber,
  type EntitySubscriberInterface,
  type InsertEvent,
  type UpdateEvent,
} from 'typeorm'
import { clsGet } from '../context/cls.js'
import { BaseEntity } from './base.entity.js'

// Outside a request (CLI scripts, jobs without a principal) the columns are left as given.
const currentUserId = (): number | undefined => clsGet('principal')?.userId

/**
 * Fills `created_by`/`updated_by` from the CLS principal for every BaseEntity. Covers `save()` and
 * QueryBuilder `insert()/update()` (their value objects arrive as `event.entity`). Listed in
 * `dataSourceOptions().subscribers` (TypeORM only instantiates `@EventSubscriber` classes); no Nest DI.
 */
@EventSubscriber()
export class AuditSubscriber implements EntitySubscriberInterface<BaseEntity> {
  listenTo() {
    return BaseEntity
  }

  beforeInsert(event: InsertEvent<BaseEntity>) {
    const userId = currentUserId()
    if (userId === undefined) return
    // always overwrite: a client-supplied createdBy/updatedBy must never forge the audit trail
    event.entity.createdBy = userId
    event.entity.updatedBy = userId
  }

  beforeUpdate(event: UpdateEvent<BaseEntity>) {
    const entity = event.entity as Partial<BaseEntity> | undefined
    if (!entity) return
    // created_by is write-once: restore it on save(), drop it from QueryBuilder update sets
    if (event.databaseEntity) entity.createdBy = event.databaseEntity.createdBy
    else delete entity.createdBy
    const userId = currentUserId()
    if (userId !== undefined) entity.updatedBy = userId
  }
}
