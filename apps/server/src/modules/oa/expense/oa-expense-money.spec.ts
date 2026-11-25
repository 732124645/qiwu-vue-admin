import { BizError } from '../../../core/http/biz-error.js'
import { sumExpenseAmounts } from './expense-money.js'

describe('expense money', () => {
  it('adds exact cents and keeps the maximum database amount', () => {
    expect(sumExpenseAmounts(['0.10', '0.20'])).toBe('0.30')
    expect(sumExpenseAmounts(['1', '2.5'])).toBe('3.50')
    expect(sumExpenseAmounts(['9999999999.99'])).toBe('9999999999.99')
    expect(sumExpenseAmounts(Array.from({ length: 500 }, () => '0.01'))).toBe('5.00')
  })

  it('refuses invalid, zero, oversized and overflowing amounts', () => {
    for (const value of ['0', '-1', '1.001', '1e2', 'NaN', '01', '10000000000'])
      expect(() => sumExpenseAmounts([value])).toThrow(BizError)
    expect(() => sumExpenseAmounts([])).toThrow(BizError)
    expect(() => sumExpenseAmounts(['9999999999.99', '0.01'])).toThrow(BizError)
    expect(() => sumExpenseAmounts(Array.from({ length: 501 }, () => '0.01'))).toThrow(BizError)
  })
})
