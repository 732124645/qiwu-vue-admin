// A dynamic process form (see docs/design-notes.md#workflow) as the start page and the instance detail render it. The
// schema goes through sanitizeFormSchema once more; on the detail a `hide` rule is gone, a read one disabled
// without its checks, and only the `edit` fields go with an approval.
import { describe, expect, it } from 'vitest'
import { editableValues, processForm } from '@/views/workflow/center/process-form'

const SCHEMA = {
  rule: [
    { type: 'input', field: 'reason', title: 'Reason', value: 'x', $required: true },
    { type: 'input', field: 'secret', title: 'Secret' },
    {
      type: 'inputNumber',
      field: 'amount',
      title: 'Amount',
      value: 1,
      validate: [{ required: true }],
      props: { min: 0 },
    },
  ],
  option: { form: { labelPosition: 'top' }, submitBtn: true },
}

describe('processForm', () => {
  it('start: every rule as published, without form-create buttons', () => {
    const f = processForm(SCHEMA)!
    expect(f.rule).toEqual(SCHEMA.rule)
    expect(f.option).toEqual({ form: { labelPosition: 'top' }, submitBtn: false, resetBtn: false })
  })

  it('detail: hide dropped, read disabled without checks, edit kept; no default values', () => {
    const f = processForm(SCHEMA, { secret: 'hide', amount: 'edit' })!
    expect(f.rule.map((r) => r.field)).toEqual(['reason', 'amount'])
    expect(f.rule[0]).toMatchObject({ props: { disabled: true }, $required: false })
    expect(f.rule[0]!.value).toBeUndefined()
    expect(f.rule[1]).toMatchObject({ validate: [{ required: true }], props: { min: 0 } })
    expect(f.rule[1]!.props).not.toHaveProperty('disabled')
    expect(f.rule[1]!.value).toBeUndefined()
    // no access listed: every field read-only
    expect(processForm(SCHEMA, {})!.rule.every((r) => r.props?.disabled)).toBe(true)
  })

  it('a schema the sanitizer refuses renders nothing', () => {
    expect(processForm({ rule: [{ type: 'input', field: 'a', on: { change: 'x' } }] })).toBeNull()
    expect(processForm({ rule: [{ type: 'html', field: 'a' }] })).toBeNull()
  })

  it('editableValues: the edit fields only', () => {
    const access = { a: 'edit', b: 'read', c: 'hide' } as const
    expect(editableValues({ a: 1, b: 2, c: 3, d: 4 }, access)).toEqual({ a: 1 })
  })
})
