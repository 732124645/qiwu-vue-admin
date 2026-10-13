// The boot check of the tenant condition (core/db/tenant-filter.ts `assertTenantFilter`, run by
// CoreDbModule on init): the app refuses to start when TypeORM renders tenant-table SQL without the
// condition (the wrappers gone, as after a TypeORM change) or when no tenant table is known.
import { Test, type TestingModule } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { DataSource, Entity, JoinTable, ManyToMany, PrimaryGeneratedColumn } from 'typeorm'
import { CoreContextModule } from '../../src/core/context/context.module.js'
import { CoreDbModule } from '../../src/core/db/db.module.js'
import {
  assertTenantFilter,
  installTenantFilter,
  refreshTenantTables,
  TenantColumn,
  tenantTablesOf,
  uninstallTenantFilter,
} from '../../src/core/db/tenant-filter.js'
import { dataSourceOptions } from '../../src/db/data-source.js'
import { ScopedNoteFixtureModule } from '../fixtures/scoped-note/scoped-note.module.js'

const boot = async (): Promise<TestingModule> => {
  const moduleRef = await Test.createTestingModule({
    imports: [CoreContextModule, CoreDbModule, ScopedNoteFixtureModule],
  }).compile()
  try {
    return await moduleRef.init()
  } catch (err) {
    await moduleRef.close()
    throw err
  }
}

let moduleRef: TestingModule
let ds: DataSource

beforeAll(async () => {
  moduleRef = await boot()
  ds = moduleRef.get(getDataSourceToken())
})

afterAll(async () => {
  installTenantFilter()
  await moduleRef?.close()
})

it('starts with the condition in place', () => {
  expect(tenantTablesOf(ds)?.size).toBeGreaterThan(0)
  expect(() => assertTenantFilter(ds)).not.toThrow()
})

it('refuses to start without the wrappers', async () => {
  uninstallTenantFilter()
  try {
    expect(() => assertTenantFilter(ds)).toThrow(
      /no tenant condition in select, join, update, delete, entity select, entity join, entity update, entity delete/,
    )
    await expect(boot()).rejects.toThrow(/tenant filter/)
  } finally {
    installTenantFilter()
  }
  expect(() => assertTenantFilter(ds)).not.toThrow()
})

it('refuses to start when no tenant table is known', async () => {
  tenantTablesOf(ds)?.clear()
  try {
    expect(() => moduleRef.get(CoreDbModule).onModuleInit()).toThrow(/no tenant table known/)
  } finally {
    await refreshTenantTables(ds)
  }
  expect(() => assertTenantFilter(ds)).not.toThrow()
})

it('refuses to start with a many-to-many relation on a tenant table', async () => {
  @Entity('test_scoped_note')
  class LinkedNote {
    @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
    id: number

    @TenantColumn()
    tenantId: number

    @ManyToMany(() => LinkedNote)
    @JoinTable({
      name: 'test_note_link',
      joinColumn: { name: 'note_id' },
      inverseJoinColumn: { name: 'target_id' },
    })
    links: LinkedNote[]
  }
  const probe = await new DataSource({
    ...dataSourceOptions(),
    entities: [LinkedNote],
  }).initialize()
  try {
    expect(() => assertTenantFilter(probe)).toThrow(
      /many-to-many on a tenant table \(LinkedNote\.links\)/,
    )
  } finally {
    await probe.destroy()
  }
})
