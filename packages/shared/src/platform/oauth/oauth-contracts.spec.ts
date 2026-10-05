import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { authorizeBody, authorizeQuery } from './provider.schema.js'

const challenge = createHash('sha256')
  .update(randomBytes(32).toString('base64url'))
  .digest('base64url')
const query = {
  response_type: 'code',
  client_id: 'crm-web',
  redirect_uri: 'https://crm.example.com/cb?x=1',
  scope: 'user.read',
  state: 'xyz',
  code_challenge: challenge,
  code_challenge_method: 'S256',
}

describe('authorize contract', () => {
  it('takes an S256 PKCE request; scope and state are optional', () => {
    expect(authorizeQuery.parse(query)).toEqual(query)
    const { scope: _s, state: _t, ...bare } = query
    expect(authorizeQuery.safeParse(bare).success).toBe(true)
  })

  it.each([
    ['plain PKCE', { code_challenge_method: 'plain' }],
    ['no method (RFC 7636: plain)', { code_challenge_method: undefined }],
    ['no challenge', { code_challenge: undefined }],
    ['a 42-character challenge', { code_challenge: challenge.slice(1) }],
    ['a challenge outside base64url', { code_challenge: `${challenge.slice(1)}=` }],
    ['a repeated parameter', { scope: ['user.read', 'user.read'] }],
    ['a client id with a space', { client_id: 'crm web' }],
  ])('refuses %s', (_, change) => {
    expect(authorizeQuery.safeParse({ ...query, ...change }).success).toBe(false)
  })

  it('the POST body is only the answer', () => {
    expect(authorizeBody.parse({ approve: false, client_id: 'x' })).toEqual({ approve: false })
    expect(authorizeBody.safeParse({ approve: 'true' }).success).toBe(false)
  })
})
