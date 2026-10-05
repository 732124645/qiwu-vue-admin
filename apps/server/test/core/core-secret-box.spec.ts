// core/crypto SecretBox (see docs/design-notes.md#security): AES-256-GCM under HKDF(APP_SECRET, v1), `v1:<iv>:<tag>:<ct>`;
// random IV per box, tamper / foreign secret / other version refused; the shared seal/open that
// TokenService's grace entries use (AAD bound).
import { randomBytes } from 'node:crypto'
import type { AppConfigService } from '../../src/core/config/config.module.js'
import { deriveKey, open, SecretBox, seal } from '../../src/core/crypto/secret-box.js'

const cfg = (secret: string) => ({ get: () => secret }) as unknown as AppConfigService
const box = new SecretBox(cfg('test-secret-box-app-secret-0000000000001'))

describe('SecretBox', () => {
  it('round-trips (unicode, empty), prefixes v1 and never repeats a box for the same plaintext', () => {
    for (const pt of ['s3-secret/Key+123', '密钥 ✓', ''])
      expect(box.decrypt(box.encrypt(pt))).toBe(pt)
    const a = box.encrypt('same')
    const b = box.encrypt('same')
    expect(a).not.toBe(b)
    expect(a).toMatch(/^v1:[\w-]{16}:[\w-]{22}:[\w-]+$/)
    expect(a).not.toContain('same')
    expect(SecretBox.isBox(a)).toBe(true)
    expect(SecretBox.isBox('plain')).toBe(false)
    expect(SecretBox.isBox(null)).toBe(false)
  })

  it('the same APP_SECRET opens it after a restart; another one does not', () => {
    const stored = box.encrypt('kept')
    expect(new SecretBox(cfg('test-secret-box-app-secret-0000000000001')).decrypt(stored)).toBe(
      'kept',
    )
    expect(() =>
      new SecretBox(cfg('another-app-secret-00000000000000000002')).decrypt(stored),
    ).toThrow(/does not open/)
  })

  it('refuses any tampered part, another version prefix and non-boxes', () => {
    const [v, iv, tag, ct] = box.encrypt('tamper me').split(':') as [string, string, string, string]
    const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1)
    for (const bad of [
      [v, flip(iv), tag, ct],
      [v, iv, flip(tag), ct],
      [v, iv, tag, flip(ct)],
      [v, iv, tag, ct.slice(0, -2)],
      ['v2', iv, tag, ct],
      [v, iv, tag],
    ])
      expect(() => box.decrypt(bad.join(':'))).toThrow(/does not open/)
    expect(() => box.decrypt('plain-secret')).toThrow(/does not open/)
    expect(() => box.decrypt('')).toThrow(/does not open/)
  })
})

describe('seal / open (shared with TokenService)', () => {
  const key = deriveKey('input key material', 'salt', 'info')

  it('deriveKey is deterministic, 32 bytes, and changes with any input', () => {
    expect(key).toHaveLength(32)
    expect(deriveKey('input key material', 'salt', 'info').equals(key)).toBe(true)
    for (const other of [
      deriveKey('input key material!', 'salt', 'info'),
      deriveKey('input key material', 'salt2', 'info'),
      deriveKey('input key material', 'salt', 'info2'),
    ])
      expect(other.equals(key)).toBe(false)
  })

  it('opens only with the same key and AAD; malformed parts → null (never throws)', () => {
    const s = seal(key, '{"a":1}', 'sid-1')
    expect(open(key, s, 'sid-1')).toBe('{"a":1}')
    expect(open(key, s, 'sid-2')).toBeNull()
    expect(open(randomBytes(32), s, 'sid-1')).toBeNull()
    expect(open(key, { ...s, iv: 'short' }, 'sid-1')).toBeNull()
    expect(open(key, { ...s, tag: s.tag.slice(0, 10) }, 'sid-1')).toBeNull()
    expect(open(key, { ...s, ct: '!!' }, 'sid-1')).toBeNull()
  })
})
