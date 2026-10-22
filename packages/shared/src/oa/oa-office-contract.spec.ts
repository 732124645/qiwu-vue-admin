import { describe, expect, it } from 'vitest'
import { oaAmount, oaPositiveAmount, oaAttachmentIds } from './common.schema.js'
import { expenseCreate, expenseItemInput, expenseUpdate } from './expense.schema.js'
import { sealCreate, sealUpdate } from './seal.schema.js'
import { tripCreate, tripUpdate } from './trip.schema.js'

const trip = {
  destination: 'Office north',
  startAt: '2026-10-22T09:00:00Z',
  endAt: '2026-10-23T09:00:00Z',
  reason: 'Visit supplier',
}
const expense = {
  reason: 'Travel costs',
  items: [{ expenseDate: '2026-10-22', expenseKind: 'travel', amount: '0.10', description: 'Bus' }],
}
const seal = {
  sealKind: 'company',
  documentName: 'Contract',
  purpose: 'Service agreement',
  copies: 2,
  expectedDate: '2026-10-22',
}

describe('office application contracts', () => {
  it('keeps decimal amounts exact within database precision', () => {
    expect(oaAmount.parse('9999999999.99')).toBe('9999999999.99')
    expect(oaAmount.parse('0.1')).toBe('0.10')
    expect(oaAmount.parse('12')).toBe('12.00')
    expect(oaAmount.parse('0')).toBe('0.00')
    for (const value of [0.1, '10000000000', '-1', '1.001', '1e2', 'NaN', '01', '1.'])
      expect(oaAmount.safeParse(value).success).toBe(false)
    expect(oaPositiveAmount.safeParse('0.00').success).toBe(false)
    expect(oaPositiveAmount.parse('0.01')).toBe('0.01')
  })

  it('rejects server-owned fields instead of trusting a submitted identity or approval state', () => {
    for (const [schema, body] of [
      [tripCreate, trip],
      [expenseCreate, expense],
      [sealCreate, seal],
    ] as const) {
      expect(schema.safeParse(body).success).toBe(true)
      for (const field of ['userId', 'tenantId', 'state', 'instanceId', 'totalAmount', 'currency'])
        expect(
          schema.safeParse({ ...body, [field]: field === 'state' ? 'approved' : 7 }).success,
        ).toBe(false)
    }
  })

  it('validates business constraints and reuses workflow initiator picks', () => {
    expect(tripCreate.parse({ ...trip, initiatorPicks: { reviewer: [3] } }).initiatorPicks).toEqual(
      { reviewer: [3] },
    )
    expect(tripCreate.safeParse({ ...trip, endAt: trip.startAt }).success).toBe(false)
    expect(expenseCreate.safeParse({ ...expense, items: [] }).success).toBe(false)
    expect(
      expenseCreate.safeParse({ ...expense, items: [{ ...expense.items[0], amount: '0' }] })
        .success,
    ).toBe(false)
    expect(sealCreate.safeParse({ ...seal, copies: 0 }).success).toBe(false)
    expect(sealCreate.safeParse({ ...seal, expectedDate: '2026-02-30' }).success).toBe(false)
    expect(oaAttachmentIds.safeParse([1, 1]).success).toBe(false)
    expect(oaAttachmentIds.safeParse(Array.from({ length: 11 }, (_, i) => i + 1)).success).toBe(
      false,
    )
  })

  it('rejects server-owned fields on every request update', () => {
    for (const [schema, body] of [
      [tripUpdate, { reason: 'Updated purpose' }],
      [expenseUpdate, { reason: 'Updated costs' }],
      [sealUpdate, { copies: 3 }],
    ] as const) {
      expect(schema.safeParse(body).success).toBe(true)
      for (const field of ['userId', 'tenantId', 'state', 'instanceId', 'totalAmount', 'currency'])
        expect(
          schema.safeParse({ ...body, [field]: field === 'state' ? 'approved' : 7 }).success,
        ).toBe(false)
    }
  })

  it('rejects ownership and state injected into nested expense items', () => {
    for (const field of ['claimId', 'tenantId', 'userId', 'state', 'totalAmount', 'sortNo']) {
      const item = { ...expense.items[0], [field]: field === 'state' ? 'approved' : 7 }
      expect(expenseItemInput.safeParse(item).success).toBe(false)
      expect(expenseCreate.safeParse({ ...expense, items: [item] }).success).toBe(false)
      expect(expenseUpdate.safeParse({ items: [item] }).success).toBe(false)
    }
  })

  it('accepts the last allowed item and copy counts and rejects the next one', () => {
    const items = Array.from({ length: 500 }, () => ({ ...expense.items[0] }))
    expect(expenseCreate.safeParse({ ...expense, items }).success).toBe(true)
    expect(expenseUpdate.safeParse({ items }).success).toBe(true)
    const tooMany = [...items, { ...expense.items[0] }]
    expect(expenseCreate.safeParse({ ...expense, items: tooMany }).success).toBe(false)
    expect(expenseUpdate.safeParse({ items: tooMany }).success).toBe(false)
    expect(sealCreate.safeParse({ ...seal, copies: 9999 }).success).toBe(true)
    expect(sealUpdate.safeParse({ copies: 9999 }).success).toBe(true)
    expect(sealCreate.safeParse({ ...seal, copies: 10000 }).success).toBe(false)
    expect(sealUpdate.safeParse({ copies: 10000 }).success).toBe(false)
  })

  it('does not clear omitted fields during an update', () => {
    expect(tripUpdate.parse({ reason: 'Updated purpose' })).toEqual({ reason: 'Updated purpose' })
    expect(expenseUpdate.parse({ reason: 'Updated costs' })).toEqual({ reason: 'Updated costs' })
    expect(sealUpdate.parse({ copies: 3 })).toEqual({ copies: 3 })
    expect(tripUpdate.safeParse({ ...trip, endAt: trip.startAt }).success).toBe(false)
  })
})
