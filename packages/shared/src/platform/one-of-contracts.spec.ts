import { describe, expect, it } from 'vitest'
import { cacheClearQuery } from './monitor/monitor.schema.js'
import { sessionKickBody } from './iam/session.schema.js'

const sid = '0b7f6a0e-3c1d-4f5e-9a2b-8c7d6e5f4a3b'

describe('exactly-one contracts', () => {
  it('session kick takes sids or a userId, never both or neither', () => {
    expect(sessionKickBody.safeParse({ sids: [sid] }).success).toBe(true)
    expect(sessionKickBody.safeParse({ userId: 3 }).success).toBe(true)
    expect(sessionKickBody.safeParse({ sids: [sid], userId: 3 }).success).toBe(false)
    expect(sessionKickBody.safeParse({}).success).toBe(false)
    expect(sessionKickBody.safeParse({ sids: ['not-a-sid'] }).success).toBe(false)
  })

  it('cache clear takes a namespace or a key; other query params (lang) are ignored', () => {
    expect(cacheClearQuery.safeParse({ ns: 'dict', lang: 'en-US' }).success).toBe(true)
    expect(cacheClearQuery.safeParse({ key: 'dict:iam.gender' }).success).toBe(true)
    expect(cacheClearQuery.safeParse({ ns: 'dict', key: 'dict:x' }).success).toBe(false)
    expect(cacheClearQuery.safeParse({}).success).toBe(false)
  })
})
