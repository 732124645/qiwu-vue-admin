import { Err, oaPositiveAmount, SUB_ROWS_MAX } from '@qiwu/shared'
import { BizError } from '../../../core/http/biz-error.js'

const MAX_CENTS = 999_999_999_999n

/** 逐笔转为整数分再汇总，避免浮点舍入；任何非法值或总额超出数据库精度都拒绝。 */
export function sumExpenseAmounts(amounts: readonly string[]): string {
  if (!amounts.length || amounts.length > SUB_ROWS_MAX) throw new BizError(Err.VALIDATION_FAILED)
  let cents = 0n
  for (const amount of amounts) {
    const parsed = oaPositiveAmount.safeParse(amount)
    if (!parsed.success) throw new BizError(Err.VALIDATION_FAILED)
    const [whole, fraction] = parsed.data.split('.')
    cents += BigInt(whole!) * 100n + BigInt(fraction!)
    if (cents > MAX_CENTS) throw new BizError(Err.VALIDATION_FAILED)
  }
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`
}
