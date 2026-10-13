import {
  EventSubscriber,
  type EntitySubscriberInterface,
  type InsertEvent,
  type ObjectLiteral,
  type UpdateEvent,
} from 'typeorm'
import { clsGet } from '../context/cls.js'
import { tenantId, TenantContextMissing } from '../context/tenant.js'
import { tenantColumnOf } from './tenant-filter.js'

/**
 * Writes of tenant entities (see docs/design-notes.md#tenancy): an insert gets the context's tenant,
 * whatever the entity carried (a tenantId in a request body counts for nothing); under `allTenants` the
 * entity names its tenant itself or the insert fails. An update never moves a row to another tenant.
 * Covers `save()` and QueryBuilder `insert()/update()` on entities; listed in
 * `dataSourceOptions().subscribers`.
 */
@EventSubscriber()
export class TenantSubscriber implements EntitySubscriberInterface {
  beforeInsert(event: InsertEvent<ObjectLiteral>) {
    const column = tenantColumnOf(event.metadata)
    if (!column || !event.entity) return
    if (!clsGet('allTenants')) column.setEntityValue(event.entity, tenantId())
    else if (column.getEntityValue(event.entity) == null)
      throw new TenantContextMissing(
        `${event.metadata.tableName}: a new row under allTenants names no tenant`,
      )
  }

  beforeUpdate(event: UpdateEvent<ObjectLiteral>) {
    const column = tenantColumnOf(event.metadata)
    const entity = event.entity
    if (!column || !entity) return
    // save(): keep the stored tenant on the entity; QueryBuilder update(): drop it from the values
    if (event.databaseEntity)
      column.setEntityValue(entity, column.getEntityValue(event.databaseEntity))
    else delete entity[column.propertyName]
  }
}
