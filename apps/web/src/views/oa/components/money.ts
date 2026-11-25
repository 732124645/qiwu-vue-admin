/** 预览也使用整数分；非法输入返回空值，最终金额由服务端重新计算。 */
export function expenseTotal(values: readonly string[]): string | null {
  let cents = 0n
  for (const value of values) {
    if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(value)) return null
    const [whole = '0', fraction = ''] = value.split('.')
    cents += BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))
  }
  if (cents > 999999999999n) return null
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`
}
