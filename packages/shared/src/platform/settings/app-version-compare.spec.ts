import { describe, expect, it } from 'vitest'
import { APP_VERSION, compareVersions } from './app-version.schema.js'

describe('compareVersions', () => {
  it('compares numeric segments, missing ones are 0', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('2', '1.99.99')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '1.0.1')).toBeLessThan(0)
    expect(compareVersions('1.0.0.1', '1.0')).toBeGreaterThan(0)
  })

  it('invalid versions return NaN, never equal', () => {
    for (const [a, b] of [
      ['3.2.0', 'v1.2.0'],
      ['1.1.5', '1.1.0-beta'],
      ['v1', 'v1'],
    ] as const) {
      const result = compareVersions(a, b)
      expect(Number.isNaN(result)).toBe(true)
      expect(result === 0).toBe(false)
    }
  })

  it('APP_VERSION: 1 to 4 numeric segments', () => {
    for (const v of ['1', '1.2', '1.2.0', '1.2.0.7']) expect(v).toMatch(APP_VERSION)
    for (const v of ['', '1.', '1.x', 'v1.2', '1.2.3.4.5', '1..2', '12345'])
      expect(v).not.toMatch(APP_VERSION)
  })
})
