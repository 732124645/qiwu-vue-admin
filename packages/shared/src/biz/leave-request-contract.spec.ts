import { describe, expect, it } from 'vitest'
import { leaveCreate, leaveUpdate } from './leave.schema.js'

const input = {
  leaveKind: 'annual',
  startAt: '2026-10-22T01:00:00Z',
  endAt: '2026-10-22T10:00:00Z',
  days: 0.1,
  reason: 'Appointment',
}

describe('leave request contracts', () => {
  it('keeps old submit bodies compatible and accepts workflow initiator picks', () => {
    expect(leaveCreate.safeParse(input).success).toBe(true)
    expect(leaveCreate.parse({ ...input, initiatorPicks: { review: [7] } }).initiatorPicks).toEqual(
      {
        review: [7],
      },
    )
    expect(leaveCreate.safeParse({ ...input, initiatorPicks: { review: ['7'] } }).success).toBe(
      false,
    )
  })

  it('compares the represented instants rather than the displayed offsets', () => {
    expect(leaveCreate.safeParse({ ...input, endAt: '2026-10-22T09:00:00+08:00' }).success).toBe(
      false,
    )
    expect(leaveCreate.safeParse({ ...input, endAt: '2026-10-22T08:00:00+08:00' }).success).toBe(
      false,
    )
    expect(leaveCreate.safeParse({ ...input, endAt: '2026-10-22T09:01:00+08:00' }).success).toBe(
      true,
    )
  })

  it('preserves partial updates and strips identity and workflow fields', () => {
    expect(leaveUpdate.parse({ reason: 'Updated note' })).toEqual({ reason: 'Updated note' })
    expect(leaveUpdate.safeParse({ endAt: input.endAt }).success).toBe(true)
    expect(leaveUpdate.safeParse({ startAt: input.endAt, endAt: input.startAt }).success).toBe(
      false,
    )
    expect(
      leaveUpdate.parse({
        reason: 'Updated note',
        tenantId: 2,
        userId: 8,
        state: 'approved',
        instanceId: 5,
        initiatorPicks: { review: [9] },
      }),
    ).toEqual({ reason: 'Updated note' })
    const parsed = leaveCreate.parse({
      ...input,
      userId: 8,
      tenantId: 2,
      state: 'approved',
      instanceId: 5,
    })
    expect(parsed).not.toHaveProperty('userId')
    expect(parsed).not.toHaveProperty('tenantId')
    expect(parsed).not.toHaveProperty('state')
    expect(parsed).not.toHaveProperty('instanceId')
  })

  it('keeps the declared-day bounds without recalculating them from the interval', () => {
    expect(leaveCreate.parse(input).days).toBe(0.1)
    expect(leaveCreate.safeParse({ ...input, days: 9999.9 }).success).toBe(true)
    for (const days of [0, -0.1, 10000, 0.15])
      expect(leaveCreate.safeParse({ ...input, days }).success).toBe(false)
  })
})
