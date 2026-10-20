import { describe, expect, it } from 'vitest'
import { authorizeQuery } from '../oauth/provider.schema.js'
import { accessTokenCreate, accessTokenQuery, MCP_TOOL_NAME } from './mcp.schema.js'

describe('access token contract', () => {
  const base = { name: 'cli', currentPassword: 'secret' }

  it('takes a name and the current password; writes stay off unless asked for', () => {
    expect(accessTokenCreate.parse(base)).toEqual({ ...base, allowWrite: false })
    expect(
      accessTokenCreate.parse({
        ...base,
        expiresInDays: 90,
        tools: ['iam.me.get'],
        allowWrite: true,
      }),
    ).toMatchObject({ expiresInDays: 90, tools: ['iam.me.get'], allowWrite: true })
  })

  it.each([
    ['no password', { name: 'cli' }],
    ['a blank name', { ...base, name: ' ' }],
    ['more than 90 days', { ...base, expiresInDays: 91 }],
    ['zero days', { ...base, expiresInDays: 0 }],
    ['an empty tool list', { ...base, tools: [] }],
    ['a tool name outside the pattern', { ...base, tools: ['IAM.me'] }],
  ])('refuses %s', (_, body) => {
    expect(accessTokenCreate.safeParse(body).success).toBe(false)
  })

  it('the tenant list filters by state', () => {
    expect(accessTokenQuery.parse({ state: 'revoked' })).toMatchObject({
      state: 'revoked',
      page: 1,
    })
    expect(accessTokenQuery.safeParse({ state: 'gone' }).success).toBe(false)
  })

  it('tool names read like permission codes', () => {
    for (const ok of ['iam.me.get', 'demo.book.create', 'crm.customer.reset-password'])
      expect(MCP_TOOL_NAME.test(ok)).toBe(true)
    for (const bad of ['iam.me', 'iam:me:get', 'Iam.me.get', 'iam.me.get.more'])
      expect(MCP_TOOL_NAME.test(bad)).toBe(false)
  })

  it('an authorization request may name a resource', () => {
    const q = {
      response_type: 'code',
      client_id: 'agent',
      redirect_uri: 'https://agent.example/cb',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
      resource: 'https://qiwu.example.com/api/mcp',
    }
    expect(authorizeQuery.parse(q)).toEqual(q)
  })
})
