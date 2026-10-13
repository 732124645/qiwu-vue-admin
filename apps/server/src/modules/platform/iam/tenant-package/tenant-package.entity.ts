import { Column, Entity } from 'typeorm'
import { BaseEntity } from '../../../../core/db/base.entity.js'
import { referencedBy } from '../../../../core/db/references.js'

// what holds a package (no foreign keys: core/db/references.ts): a tenant using it refuses its delete
// (409 `in_use`), its menu rows go with it; a deleted menu leaves no row in any package. Platform rows
// on both sides: these run across every tenant.
referencedBy(
  'iam_tenant_package',
  { table: 'iam_tenant', column: 'package_id' },
  { table: 'iam_tenant_package_menus', column: 'package_id', cascade: true },
)
referencedBy('iam_menu', { table: 'iam_tenant_package_menus', column: 'menu_id', cascade: true })

/** `iam_tenant_package`: a tenant package, the menus a tenant may use (a platform table). */
@Entity('iam_tenant_package')
export class TenantPackage extends BaseEntity {
  @Column({ length: 64 })
  name: string

  @Column({ type: 'boolean', default: true })
  enabled: boolean

  @Column({ type: 'varchar', length: 500, nullable: true })
  note: string | null
}
