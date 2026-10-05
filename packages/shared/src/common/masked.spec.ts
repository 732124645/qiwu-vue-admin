import { describe, expect, it } from 'vitest'
import { masked } from './masked.js'

describe('masked', () => {
  it('mobile: first 3 and last 4 digits, separators kept; short numbers show less', () => {
    expect(masked.mobile('13812345678')).toBe('138****5678')
    expect(masked.mobile('+86 138-1234-5678')).toBe('+86 1**-****-5678')
    expect(masked.mobile('12345678')).toBe('12****78')
    expect(masked.mobile('12345')).toBe('1***5')
  })

  it('email: first character of the local part + a fixed *** (length hidden), domain kept', () => {
    expect(masked.email('alice@example.com')).toBe('a***@example.com')
    expect(masked.email('a@x.co')).toBe('***@x.co')
    expect(masked.email('张三@例子.中国')).toBe('张***@例子.中国')
    expect(masked.email('first.last+tag@sub.example.org')).toBe('f***@sub.example.org')
  })

  it('idCard and bankCard: first and last 4', () => {
    expect(masked.idCard('110101199001011234')).toBe('1101**********1234')
    expect(masked.idCard('11010119900101123X')).toBe('1101**********123X')
    expect(masked.bankCard('6222021234567890123')).toBe('6222***********0123')
    expect(masked.bankCard('6222 0212 3456 7890')).toBe('6222 **** **** 7890')
  })

  it('null, undefined and empty pass through (nullable VO columns)', () => {
    for (const fn of Object.values(masked)) {
      expect(fn(null)).toBeNull()
      expect(fn(undefined)).toBeUndefined()
      expect(fn('')).toBe('')
    }
  })

  it('never reveals the value: at least a third of the characters is hidden', () => {
    for (const [fn, v] of [
      [masked.mobile, '13812345678'],
      [masked.idCard, '110101199001011234'],
      [masked.bankCard, '6222021234567890123'],
      [masked.mobile, '123'],
    ] as const) {
      const out = fn(v)
      expect(out).not.toBe(v)
      expect([...out].filter((c) => c === '*').length).toBeGreaterThanOrEqual(
        Math.ceil(v.length / 3),
      )
    }
  })
})
