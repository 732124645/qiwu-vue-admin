import { describe, expect, it } from 'vitest'
import { RT } from '../common/realtime.js'
import { fieldDomainOf } from '../validation/zod-i18n.js'
import { demoRealtimePerms, demoRealtimeSendBody } from './realtime.schema.js'

const issues = (value: unknown) =>
  (demoRealtimeSendBody.safeParse(value).error?.issues ?? []).map(
    (i) => `${i.path.join('.')}:${i.message}`,
  )

describe('RT contracts (realtime push demo)', () => {
  it('names the event, the permissions and the field-label domain', () => {
    expect(RT.demoMessage).toBe('demo:message')
    expect(demoRealtimePerms).toEqual({
      send: 'demo.realtime.send',
      broadcast: 'demo.realtime.broadcast',
    })
    expect(fieldDomainOf(demoRealtimeSendBody)).toBe('demo.realtime')
  })

  it('needs the list of its own target and no other', () => {
    expect(issues({ target: 'user', userIds: [2], text: 'hi' })).toEqual([])
    expect(issues({ target: 'role', roleIds: [3], userIds: [], text: 'hi' })).toEqual([])
    expect(issues({ target: 'all', text: 'hi' })).toEqual([])
    expect(issues({ target: 'user', text: 'hi' })).toEqual(['userIds:validation.required'])
    expect(issues({ target: 'role', roleIds: [], text: 'hi' })).toEqual([
      'roleIds:validation.required',
    ])
    expect(issues({ target: 'user', userIds: [2], roleIds: [3], text: 'hi' })).toEqual([
      'roleIds:validation.invalid',
    ])
    expect(issues({ target: 'all', userIds: [2], text: 'hi' })).toEqual([
      'userIds:validation.invalid',
    ])
    expect(issues({ target: 'dept', text: 'hi' })).toEqual(['target:validation.invalid_value'])
  })

  it('takes positive integer ids, at most 200', () => {
    for (const userIds of [[0], [-1], [1.5], ['2']])
      expect(issues({ target: 'user', userIds, text: 'hi' })).not.toEqual([])
    const many = Array.from({ length: 201 }, (_, i) => i + 1)
    expect(issues({ target: 'user', userIds: many.slice(0, 200), text: 'hi' })).toEqual([])
    expect(issues({ target: 'user', userIds: many, text: 'hi' })).toEqual([
      'userIds:validation.too_big.array',
    ])
  })

  it('keeps the text as sent, 1–500 characters, not only whitespace', () => {
    const text = '  <b>hi</b>\n & 你好  '
    expect(demoRealtimeSendBody.parse({ target: 'all', text }).text).toBe(text)
    expect(issues({ target: 'all', text: 'x'.repeat(500) })).toEqual([])
    expect(issues({ target: 'all', text: 'x'.repeat(501) })).toEqual([
      'text:validation.too_big.string',
    ])
    expect(issues({ target: 'all', text: '' })).toEqual(['text:validation.required'])
    expect(issues({ target: 'all', text: ' \n\t ' })).toEqual(['text:validation.required'])
    expect(issues({ target: 'all' })).toEqual(['text:validation.required'])
  })
})
