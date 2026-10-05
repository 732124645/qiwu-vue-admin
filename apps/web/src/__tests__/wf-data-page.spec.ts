// 审批数据: the field filters sent (only the ones that type-check against the columns),
// an op switching between one value and a list, and form values shown by type; the hint when the
// server withheld fields a step hides.
import { describe, expect, it } from 'vitest'
import type { WfDataColumn } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import {
  blankFilter,
  cellText,
  filtersParam,
  withheldHint,
  withOp,
} from '@/views/workflow/admin/data-page'

const columns: WfDataColumn[] = [
  { field: 'days', type: 'number', label: 'Days' },
  { field: 'reason', type: 'string', label: 'Reason' },
  { field: 'approver', type: 'user', label: 'Approver' },
]

describe('approval data page', () => {
  it('sends the ready field filters as JSON; blank, mistyped or unknown ones stay out', () => {
    expect(filtersParam([], columns)).toBeUndefined()
    expect(filtersParam([blankFilter('days', 'number')], columns)).toBeUndefined()
    const ready = { field: 'days', op: 'gt' as const, value: 3 }
    expect(
      filtersParam(
        [
          ready,
          { field: 'days', op: 'eq', value: '3' },
          { field: 'reason', op: 'gt', value: 'a' },
          { field: 'gone', op: 'eq', value: 1 },
          { field: 'approver', op: 'in', value: [] },
        ],
        columns,
      ),
    ).toBe(JSON.stringify([ready]))
  })

  it("a new filter takes its type's first op; an op keeps the value unless one value ↔ list", () => {
    expect(blankFilter('approver', 'user')).toEqual({ field: 'approver', op: 'eq', value: '' })
    const f = { field: 'days', op: 'eq' as const, value: 2 }
    expect(withOp(f, 'gt')).toEqual({ ...f, op: 'gt' })
    expect(withOp(f, 'in')).toEqual({ ...f, op: 'in', value: [] })
    expect(withOp({ ...f, op: 'in', value: [1] }, 'ne')).toEqual({ ...f, op: 'ne', value: '' })
  })

  it('shows user / dept refs by name, a datetime in local time, objects as JSON', () => {
    expect(cellText({ id: 7, name: 'Ann' }, 'user')).toBe('Ann')
    expect(cellText({ id: 7, name: null }, 'user')).toBe(
      i18n.global.t('common.ref.deleted', { id: 7 }),
    )
    expect(cellText({ id: 3, name: 'seed.dept.support' }, 'dept')).toBe(
      i18n.global.t('seed.dept.support'),
    )
    expect(cellText(5, 'user')).toBe('5')
    expect(cellText([{ amount: 1 }], 'string')).toBe('[{"amount":1}]')
    expect(cellText('2026-10-01', 'date')).toBe('2026-10-01')
    expect(cellText('2026-10-01T08:00:00Z', 'date')).toMatch(/^2026-(09-30|10-0[12]) \d{2}:00$/)
    expect(cellText(undefined, 'number')).toBe('')
    expect(cellText(0, 'number')).toBe('0')
  })

  it('hints at the withheld fields in the reader language, none when nothing is withheld', () => {
    expect(withheldHint(0)).toBe('')
    expect(withheldHint()).toBe('')
    setLocale('zh-CN')
    expect(withheldHint(2)).toBe('有 2 个字段在流程中被隐藏，仅流程管理员可见')
    setLocale('en-US')
    expect(withheldHint(1)).toBe(
      '1 field hidden in the process is visible to its process admins only',
    )
    expect(withheldHint(3)).toBe(
      '3 fields hidden in the process are visible to its process admins only',
    )
  })
})
