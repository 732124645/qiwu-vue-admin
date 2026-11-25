// core/redact.ts (see docs/design-notes.md#security): complete payload privacy and URL query masking.
import { MASK, redactedJson, redactedUrl, textRedactor } from '../../src/core/redact.js'

describe('explicit complete payload privacy', () => {
  const roots: [string, unknown][] = [
    ['object', { privateUnknownKey: { unknownAlias: 'x' } }],
    ['array', [{ arbitraryKey: 'private value' }]],
    ['string', 'x'],
    ['number', 1],
    ['boolean', false],
    ['null', null],
    ['bigint', 10n],
  ]
  it.each(roots)('masks the complete structured root including primitives: %s', (_name, value) => {
    expect(redactedJson(value, 4096, ['*'])).toBe(JSON.stringify(MASK))
  })

  it('does not traverse private values or execute their serializers', () => {
    const toJSON = vi.fn<() => never>(() => {
      throw new Error('private serializer')
    })
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(redactedJson({ toJSON }, 4096, ['*'])).toBe(JSON.stringify(MASK))
    expect(redactedJson(cycle, 4096, ['*'])).toBe(JSON.stringify(MASK))
    expect(toJSON).not.toHaveBeenCalled()
    expect(redactedJson(undefined, 4096, ['*'])).toBeNull()
    expect(redactedJson('private', 3, ['*'])).toBe('"**')
  })

  it('removes complete URL queries including their unknown names and keeps the path', () => {
    expect(redactedUrl('/private/42?private-name=x&other-name=y&flag', ['*'])).toBe(
      '/private/42?***',
    )
    expect(redactedUrl('/private/42?', ['*'])).toBe('/private/42?***')
    expect(redactedUrl('/private/42', ['*'])).toBe('/private/42')
  })

  it('masks complete fault text without relying on field names or minimum value length', () => {
    expect(textRedactor({ query: { unknownKey: 'x' } }, ['*'])('unknownKey x')).toBe(MASK)
    expect(textRedactor(undefined, ['*'])('private unexpected diagnostic')).toBe(MASK)
  })

  it('keeps ordinary field-based and default redaction behavior', () => {
    expect(
      redactedJson({ arbitrary: 'x', password: 'y', nested: { privateField: 'z' } }, 4096, [
        'privateField',
      ]),
    ).toBe('{"arbitrary":"x","password":"***","nested":{"privateField":"***"}}')
    expect(redactedJson('x', 4096)).toBe('"x"')
    expect(redactedJson(null, 4096)).toBe('null')
    expect(redactedUrl('/normal?arbitrary=x&privateField=y', ['privateField'])).toBe(
      '/normal?arbitrary=x&privateField=***',
    )
    expect(
      textRedactor({ arbitrary: 'x', privateField: 'private-value' }, ['privateField'])(
        'arbitrary x private-value',
      ),
    ).toBe('arbitrary x ***')
    expect(textRedactor(undefined)('ordinary diagnostic')).toBe('ordinary diagnostic')
  })
})
