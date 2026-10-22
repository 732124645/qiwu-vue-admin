import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import { oaAmount, expenseCreate, sealCreate, tripCreate, RESERVED_NAMES, Err } from '@qiwu/shared'
import type { DataSource } from 'typeorm'
import { withTenant } from '../../src/core/context/tenant.js'
import { assertReferencesLive, referencesTo } from '../../src/core/db/references.js'
import { runTenantSeeds } from '../../src/db/seeds/index.js'
import { seedOa } from '../../src/db/seeds/project/oa.seed.js'
import { OaExpenseClaim } from '../../src/modules/oa/expense/expense.entity.js'
import { OaExpenseItem } from '../../src/modules/oa/expense/expense-item.entity.js'
import { OaSealRequest } from '../../src/modules/oa/seal/seal.entity.js'
import { OaTripRequest } from '../../src/modules/oa/trip/trip.entity.js'
import { EXCLUDED_TABLE } from '../../src/modules/platform/codegen/rules.js'
import { CodegenService } from '../../src/modules/platform/codegen/codegen.service.js'
import { bootApp, createTenant, inTenant1, type TestTenant } from '../setup/tenants.js'

let app: NestExpressApplication
let ds: DataSource
let first: TestTenant
let second: TestTenant

beforeAll(async () => {
  app = await bootApp({ multiTenant: true })
  ds = app.get<DataSource>(getDataSourceToken())
  first = await createTenant(app)
  second = await createTenant(app)
})

afterAll(async () => {
  await second?.dispose()
  await first?.dispose()
  await app?.close()
})

describe('office foundation', () => {
  it('loads tenant-aware business entities and their references without adding an approval engine', () => {
    for (const entity of [OaTripRequest, OaExpenseClaim, OaExpenseItem, OaSealRequest]) {
      const meta = ds.getMetadata(entity)
      expect(meta.findColumnWithDatabaseName('tenant_id')?.isNullable).toBe(false)
      expect(meta.findColumnWithDatabaseName('deleted_at')).toBeDefined()
      expect(meta.findColumnWithDatabaseName('alive')).toBeUndefined()
      expect(EXCLUDED_TABLE.test(meta.tableName)).toBe(true)
    }
    expect(RESERVED_NAMES.has('oa')).toBe(true)
    expect(referencesTo('oa_trip_request')).toContainEqual({
      table: 'oa_expense_claim',
      column: 'trip_id',
    })
    expect(referencesTo('oa_expense_claim')).toContainEqual({
      table: 'oa_expense_item',
      column: 'claim_id',
      cascade: true,
    })
  })

  it('refuses real office tables through the generator list, defaults and import entry points', async () => {
    const codegen = app.get(CodegenService)
    await inTenant1(async () => {
      const available = (await codegen.importable()).map((row) => row.tableName)
      for (const name of [
        'oa_trip_request',
        'oa_expense_claim',
        'oa_expense_item',
        'oa_seal_request',
      ]) {
        expect(available).not.toContain(name)
        await expect(codegen.defaults(name)).rejects.toMatchObject({
          err: Err.CODEGEN_TABLE_UNAVAILABLE,
        })
        await expect(codegen.import([name])).rejects.toMatchObject({
          err: Err.CODEGEN_TABLE_UNAVAILABLE,
        })
      }
    })
  })

  it('initializes and reseeds tenants without creating business requests or changing another tenant', async () => {
    const count = (tenant: TestTenant) =>
      withTenant(tenant.id, async () => [
        await ds.getRepository(OaTripRequest).count(),
        await ds.getRepository(OaExpenseClaim).count(),
        await ds.getRepository(OaExpenseItem).count(),
        await ds.getRepository(OaSealRequest).count(),
      ])
    expect(await count(first)).toEqual([0, 0, 0, 0])
    expect(await count(second)).toEqual([0, 0, 0, 0])
    await ds.transaction((q) => runTenantSeeds(q, first.id))
    await ds.transaction((q) => runTenantSeeds(q, first.id))
    expect(await count(first)).toEqual([0, 0, 0, 0])
    expect(await count(second)).toEqual([0, 0, 0, 0])
  })

  it('keeps all four business tables isolated and stores decimal amounts and calendar dates exactly', async () => {
    const rows = await withTenant(first.id, async () => {
      const trip = await ds.getRepository(OaTripRequest).save({
        userId: first.ownerId,
        destination: 'Branch office',
        startAt: new Date('2026-10-22T09:00:00Z'),
        endAt: new Date('2026-10-23T09:00:00Z'),
        reason: 'Visit supplier',
        estimatedAmount: '9999999999.99',
        state: 'draft',
        // 即使还没有业务端点，实体写入也不能选择另一个租户。
        tenantId: second.id,
      })
      const claim = await ds.getRepository(OaExpenseClaim).save({
        userId: first.ownerId,
        reason: 'Travel expense',
        tripId: trip.id,
        totalAmount: '0.30',
        state: 'draft',
      })
      const item = await ds.getRepository(OaExpenseItem).save({
        claimId: claim.id,
        expenseDate: '2026-10-22',
        expenseKind: 'travel',
        amount: '0.10',
        description: 'Bus',
      })
      const seal = await ds.getRepository(OaSealRequest).save({
        userId: first.ownerId,
        sealKind: 'company',
        documentName: 'Contract',
        purpose: 'Service agreement',
        copies: 2,
        expectedDate: '2026-10-22',
        state: 'draft',
      })
      expect(trip.tenantId).toBe(first.id)
      return { trip, claim, item, seal }
    })
    await withTenant(second.id, async () => {
      expect(await ds.getRepository(OaTripRequest).findOneBy({ id: rows.trip.id })).toBeNull()
      expect(await ds.getRepository(OaExpenseClaim).findOneBy({ id: rows.claim.id })).toBeNull()
      expect(await ds.getRepository(OaExpenseItem).findOneBy({ id: rows.item.id })).toBeNull()
      expect(await ds.getRepository(OaSealRequest).findOneBy({ id: rows.seal.id })).toBeNull()
      expect(
        (await ds.getRepository(OaTripRequest).update(rows.trip.id, { reason: 'Wrong tenant' }))
          .affected,
      ).toBe(0)
    })
    await withTenant(first.id, async () => {
      const trip = await ds.getRepository(OaTripRequest).findOneByOrFail({ id: rows.trip.id })
      const claim = await ds.getRepository(OaExpenseClaim).findOneByOrFail({ id: rows.claim.id })
      const item = await ds.getRepository(OaExpenseItem).findOneByOrFail({ id: rows.item.id })
      const seal = await ds.getRepository(OaSealRequest).findOneByOrFail({ id: rows.seal.id })
      expect(trip.estimatedAmount).toBe('9999999999.99')
      expect(trip.reason).toBe('Visit supplier')
      expect(claim.totalAmount).toBe('0.30')
      expect(claim.currency).toBe('CNY')
      expect(item.amount).toBe('0.10')
      expect(item.expenseDate).toBe('2026-10-22')
      expect(seal.expectedDate).toBe('2026-10-22')
    })
  })

  it('rejects untrusted ownership and totals while keeping money as decimal text', () => {
    expect(oaAmount.parse('9999999999.99')).toBe('9999999999.99')
    expect(oaAmount.safeParse(0.1).success).toBe(false)
    expect(
      expenseCreate.safeParse({
        reason: 'Travel expense',
        totalAmount: '0.01',
        items: [
          {
            expenseDate: '2026-10-22',
            expenseKind: 'travel',
            amount: '100.00',
            description: 'Train',
          },
        ],
      }).success,
    ).toBe(false)
    expect(
      tripCreate.safeParse({
        destination: 'Branch office',
        startAt: '2026-10-22T09:00:00Z',
        endAt: '2026-10-23T09:00:00Z',
        reason: 'Visit supplier',
        userId: second.ownerId,
      }).success,
    ).toBe(false)
    expect(
      sealCreate.safeParse({
        sealKind: 'company',
        documentName: 'Contract',
        purpose: 'Service agreement',
        copies: 1,
        expectedDate: '2026-10-22',
        state: 'approved',
      }).success,
    ).toBe(false)
  })

  it('rejects missing users, departments and instances through the registered business references', async () => {
    await withTenant(first.id, async () => {
      for (const table of ['oa_trip_request', 'oa_expense_claim', 'oa_seal_request'])
        for (const field of ['userId', 'deptId', 'instanceId'])
          await expect(
            ds.transaction((q) =>
              assertReferencesLive(q, table, { [field]: Number.MAX_SAFE_INTEGER }),
            ),
          ).rejects.toMatchObject({ status: 404 })
    })
  })

  it('does not recreate missing actions below a deleted office group', async () => {
    const [group] = await ds.query<{ id: number; deleted_at: Date | null }[]>(
      'SELECT id, deleted_at FROM iam_menu WHERE route_name = ?',
      ['oa'],
    )
    const [action] = await ds.query<{ id: number; perms: string }[]>(
      'SELECT id, perms FROM iam_menu WHERE perms = ? AND deleted_at IS NULL',
      ['oa.trip.create'],
    )
    expect(group).toBeDefined()
    expect(action).toBeDefined()
    try {
      await ds.query('UPDATE iam_menu SET deleted_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [
        group.id,
      ])
      // 暂时移走自然键模拟缺少的新动作，保留原行 ID，避免改动现有套餐引用。
      await ds.query('UPDATE iam_menu SET perms = ? WHERE id = ?', [
        'oa.trip.create-temporary',
        action.id,
      ])
      await inTenant1(() => ds.transaction(seedOa))
      expect(
        await ds.query('SELECT id FROM iam_menu WHERE perms = ? AND deleted_at IS NULL', [
          action.perms,
        ]),
      ).toEqual([])
    } finally {
      // 即使防护变异意外补建了动作，也清理新增行并恢复分组与原动作。
      await ds.query('DELETE FROM iam_menu WHERE perms = ? AND id <> ?', [action.perms, action.id])
      await ds.query('UPDATE iam_menu SET perms = ? WHERE id = ?', [action.perms, action.id])
      await ds.query('UPDATE iam_menu SET deleted_at = ? WHERE id = ?', [
        group.deleted_at,
        group.id,
      ])
    }
  })

  it('preserves administrator changes and deleted permission rows when reseeded', async () => {
    await inTenant1(() => ds.transaction(seedOa))
    const snapshot = () =>
      ds.query(
        "SELECT id, parent_id, name, perms, deleted_at FROM iam_menu WHERE route_name = 'oa' OR perms LIKE 'oa.%' ORDER BY id",
      )
    const dictSnapshot = () =>
      ds.query(
        'SELECT id, dict_code, value, label, label_i18n, enabled, deleted_at FROM cfg_dict_entry WHERE dict_code IN (?, ?, ?) ORDER BY id',
        ['oa.request_state', 'oa.expense_kind', 'oa.seal_kind'],
      )
    const before = await snapshot()
    const dictBefore = await dictSnapshot()
    expect(before.length).toBeGreaterThan(1)
    expect(dictBefore.length).toBeGreaterThan(0)
    await inTenant1(() => ds.transaction(seedOa))
    expect(await snapshot()).toEqual(before)
    expect(await dictSnapshot()).toEqual(dictBefore)
    const [changed] = await ds.query<{ id: number; name: string }[]>(
      'SELECT id, name FROM iam_menu WHERE perms = ? AND deleted_at IS NULL',
      ['oa.trip.create'],
    )
    const [deleted] = await ds.query<{ id: number; deleted_at: Date | null }[]>(
      'SELECT id, deleted_at FROM iam_menu WHERE perms = ? AND deleted_at IS NULL',
      ['oa.seal.modify'],
    )
    const [dictChanged] = await ds.query<{ id: number; label: string }[]>(
      'SELECT id, label FROM cfg_dict_entry WHERE dict_code = ? AND value = ? AND deleted_at IS NULL',
      ['oa.expense_kind', 'transport'],
    )
    const [dictDeleted] = await ds.query<{ id: number; deleted_at: Date | null }[]>(
      'SELECT id, deleted_at FROM cfg_dict_entry WHERE dict_code = ? AND value = ? AND deleted_at IS NULL',
      ['oa.seal_kind', 'other'],
    )
    expect(changed).toBeDefined()
    expect(deleted).toBeDefined()
    expect(dictChanged).toBeDefined()
    expect(dictDeleted).toBeDefined()
    try {
      await ds.query('UPDATE iam_menu SET name = ? WHERE id = ?', [
        'Customized office action',
        changed.id,
      ])
      await ds.query('UPDATE iam_menu SET deleted_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [
        deleted.id,
      ])
      await ds.query('UPDATE cfg_dict_entry SET label = ? WHERE id = ?', [
        'Customized category',
        dictChanged.id,
      ])
      await ds.query('UPDATE cfg_dict_entry SET deleted_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [
        dictDeleted.id,
      ])
      const modified = await snapshot()
      const dictModified = await dictSnapshot()
      await inTenant1(() => ds.transaction(seedOa))
      expect(await snapshot()).toEqual(modified)
      expect(await dictSnapshot()).toEqual(dictModified)
    } finally {
      await ds.query('UPDATE cfg_dict_entry SET label = ? WHERE id = ?', [
        dictChanged.label,
        dictChanged.id,
      ])
      await ds.query('UPDATE cfg_dict_entry SET deleted_at = ? WHERE id = ?', [
        dictDeleted.deleted_at,
        dictDeleted.id,
      ])
      await ds.query('UPDATE iam_menu SET name = ? WHERE id = ?', [changed.name, changed.id])
      await ds.query('UPDATE iam_menu SET deleted_at = ? WHERE id = ?', [
        deleted.deleted_at,
        deleted.id,
      ])
    }
  })
})
