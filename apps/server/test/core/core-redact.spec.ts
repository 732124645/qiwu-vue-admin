// core/redact.ts `maskSecrets` (see docs/design-notes.md#security): secrets and personal numbers in free text
// a user or a model wrote are masked; ordinary sentences that merely name a secret, words and numbers stay, and
// a very long input is handled quickly.
import { MASK, maskSecrets } from '../../src/core/redact.js'

describe('maskSecrets', () => {
  const masked: [name: string, text: string, secret: string][] = [
    [
      'a PEM block',
      'key:\n-----BEGIN ' +
        'PRIVATE KEY-----\nMIIEvQIBADANBg\nkqhkiG9w0B\n-----END ' +
        'PRIVATE KEY-----\ndone',
      'MIIEvQIBADANBg',
    ],
    [
      'a JWT',
      'header eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc_DEF-123 sent',
      'eyJhbGciOiJIUzI1NiJ9',
    ],
    ['an AWS key id', 'aws AKIA' + 'IOSFODNN7EXAMPLE here', 'AKIA' + 'IOSFODNN7EXAMPLE'],
    [
      'an sk- key',
      'use sk-' + 'proj-abc123def456ghi789xyz please',
      'sk-' + 'proj-abc123def456ghi789xyz',
    ],
    [
      'a GitHub token',
      'token ghp_' + '1234567890abcdefghij1234 ok',
      'ghp_' + '1234567890abcdefghij1234',
    ],
    ['an ID card number ending in X', '身份证 11010519491231002X 已登记', '11010519491231002X'],
    ['an ID card number ending in a digit', 'ID 110105194912310021.', '110105194912310021'],
    ['a card number passing Luhn', '卡号 4111111111111111 尾号', '4111111111111111'],
    ['a card number with spaces', 'card 6011 0009 9013 9424 thanks', '6011 0009 9013 9424'],
    ['a mobile number', '电话 13800138000，晚上打', '13800138000'],
    ['a mobile number with +86', 'call +86 139-1234-5678? no: +8613912345678', '13912345678'],
    ['a password glued to its name', '密码hunter22，记一下', 'hunter22'],
    ['a pwd glued to its value', 'my pwd123456 is old', '123456'],
    ['a quoted value whole', 'password: "correct horse battery" end', 'correct horse battery'],
    ['a password after is', 'the password is s3cret!', 's3cret!'],
    ['a Chinese password after 是', '我的口令是 abc12345。', 'abc12345'],
    ['a long secret-looking run', 'id a1b2c3d4e5f6a7b8c9d0e1f2g3', 'a1b2c3d4e5f6a7b8c9d0e1f2g3'],
    ['a name=value pair', 'set token=abcd1234 now', 'abcd1234'],
  ]
  it.each(masked)('masks %s', (_name, text, secret) => {
    const out = maskSecrets(text)
    expect(out).not.toContain(secret)
    expect(out).toContain(MASK)
  })

  it('leaves ordinary words, dates, short numbers and a card-like number failing Luhn', () => {
    const text =
      'pinned on 2026-10-22, order 1234567812345678, room 1203, passwords reset, PIN code'
    expect(maskSecrets(text)).toBe(text)
  })

  it.each([
    '用户反馈忘记密码后无法登录系统需要尽快处理',
    '我负责令牌桶限流模块',
    '密码策略为 90 天',
    'the token is valid for 7 days',
    'The secret is to keep answers short',
    'SKU sk-2026-blue-large',
  ])('leaves a sentence that merely names a secret: %s', (text) => {
    expect(maskSecrets(text)).toBe(text)
  })

  it('reads at most 10 000 characters and takes little time on a long input', () => {
    const long = `${'a1-'.repeat(20_000)} ${'密码'.repeat(20_000)}`
    const started = performance.now()
    const out = maskSecrets(long)
    expect(performance.now() - started).toBeLessThan(200)
    expect(out.length).toBeLessThanOrEqual(10_000)
  })

  it('keeps the text around a masked value', () => {
    expect(maskSecrets('我的密码是 abc12345，常用工号 A1')).toBe('我的密码是 ***，常用工号 A1')
    expect(maskSecrets('password: x1 and api key = sk-zzzzzzzz')).toBe(
      'password: *** and api key = ***',
    )
  })
})

describe('maskSecrets on a Chinese secret name followed by blanks', () => {
  it('takes linear time when no value follows the name', () => {
    const text = `密码${' '.repeat(9990)}`
    const started = performance.now()
    expect(maskSecrets(text)).toBe(text)
    expect(performance.now() - started).toBeLessThan(20)
  })

  it('still masks a value after blanks and a separator', () => {
    expect(maskSecrets('密码   是   abc12345')).toBe('密码   是   ***')
  })
})
