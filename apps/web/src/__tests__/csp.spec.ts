// SPA CSP (csp.ts; see docs/design-notes.md#security): connect-src is the app's own origin unless the deployer lists extra
// origins in CSP_CONNECT_SRC (the S3 endpoint for direct uploads / private downloads); every entry must
// be a bare https origin (http only for localhost), anything else stops the build.
import { describe, expect, it } from 'vitest'
import { connectOrigins, SPA_CSP, spaCsp } from '../../csp.ts'

const directives = (csp: string) => csp.split('; ')

describe('SPA CSP', () => {
  it("default: connect-src 'self' only, the rest unchanged", () => {
    expect(spaCsp()).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; media-src 'self' blob:; frame-src 'self' https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    )
    expect(connectOrigins()).toEqual([])
    expect(connectOrigins(' , ')).toEqual([])
    // no CSP_CONNECT_SRC in the test env
    expect(SPA_CSP).toBe(spaCsp())
  })

  it('listed origins join connect-src after self (space or comma separated)', () => {
    const origins = connectOrigins(
      'https://s3.example.com, https://qw-files.oss-cn-hangzhou.aliyuncs.com:8443/  http://localhost:9000 http://127.0.0.1:8333',
    )
    expect(origins).toEqual([
      'https://s3.example.com',
      'https://qw-files.oss-cn-hangzhou.aliyuncs.com:8443',
      'http://localhost:9000',
      'http://127.0.0.1:8333',
    ])
    expect(directives(spaCsp(origins))).toContain(
      "connect-src 'self' https://s3.example.com https://qw-files.oss-cn-hangzhou.aliyuncs.com:8443 http://localhost:9000 http://127.0.0.1:8333",
    )
    expect(directives(spaCsp(origins))).toHaveLength(10)
  })

  it('permits only configured secure signaling origins and local development sockets without relaxing scripts', () => {
    const origins = connectOrigins('wss://media.example.com ws://127.0.0.1:7880')
    expect(origins).toEqual(['wss://media.example.com', 'ws://127.0.0.1:7880'])
    expect(directives(spaCsp(origins))).toContain("script-src 'self'")
    expect(directives(spaCsp(origins))).toContain("media-src 'self' blob:")
    expect(spaCsp(origins)).not.toContain("script-src 'self' 'unsafe")
  })

  it.each([
    'http://s3.example.com',
    'https://s3.example.com/qw-files',
    'https://s3.example.com?x=1',
    'https://*.example.com',
    'https:',
    '*',
    "'unsafe-inline'",
    'data:',
    'ws://media.example.com',
    'wss://media.example.com/rtc',
    'wss://user:secret@media.example.com',
    'ftp://s3.example.com',
    'https://user@s3.example.com',
    'https://S3.example.com',
    "https://a.example.com;script-src 'unsafe-eval'",
    's3.example.com',
  ])('refuses %s', (entry) => {
    expect(() => connectOrigins(`https://ok.example.com ${entry}`)).toThrow(/CSP_CONNECT_SRC/)
  })
})
