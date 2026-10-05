import { describe, expect, it } from 'vitest'
import { formatShort, formatTime } from '@/core/format'

describe('formatTime', () => {
  it('shows an ISO timestamp in local time, zero-padded', () => {
    expect(formatTime(new Date(2026, 0, 2, 3, 4, 59).toISOString())).toBe('2026-01-02 03:04')
    expect(formatTime(new Date(2026, 11, 31, 23, 5).toISOString())).toBe('2026-12-31 23:05')
  })
})

describe('formatShort', () => {
  const now = new Date(2026, 9, 2, 15, 30)
  const at = (...a: [number, number, number, number, number]) => new Date(...a).toISOString()

  it('today: the time only', () => {
    expect(formatShort(at(2026, 9, 2, 0, 0), now)).toBe('00:00')
    expect(formatShort(at(2026, 9, 2, 9, 5), now)).toBe('09:05')
  })

  it('this year: month, day and time; earlier years: the date', () => {
    expect(formatShort(at(2026, 9, 1, 18, 40), now)).toBe('10-01 18:40')
    // the same day of another month is not today
    expect(formatShort(at(2026, 8, 2, 8, 0), now)).toBe('09-02 08:00')
    expect(formatShort(at(2026, 0, 1, 0, 0), now)).toBe('01-01 00:00')
    expect(formatShort(at(2025, 9, 2, 15, 30), now)).toBe('2025-10-02')
  })

  it('defaults to the current time', () => {
    expect(formatShort(new Date().toISOString())).toMatch(/^\d{2}:\d{2}$/)
  })
})
