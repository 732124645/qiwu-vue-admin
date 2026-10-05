import { afterEach, describe, expect, it } from 'vitest'
import { LOCALES } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import translate, { TEMPLATES } from '@/views/workflow/bpmn/translate'

// bpmn-js's `translate` in the app's language. The keys are built at run time, so the i18n
// check cannot see them: every mapped template has its text in both languages here.
const [, fn] = translate.translate as [string, (t: string, r?: Record<string, string>) => string]

afterEach(() => setLocale('zh-CN'))

describe('wf bpmn translate', () => {
  it.each(LOCALES)('%s: every template bpmn-js shows has a wf.bpmn text', (locale) => {
    setLocale(locale)
    const keys = Object.values(TEMPLATES).map((key) => `wf.bpmn.${key}`)
    expect(keys.filter((key) => !i18n.global.te(key, locale))).toEqual([])
    expect(Object.keys(TEMPLATES).map((template) => fn(template))).toEqual(
      keys.map((key) => i18n.global.t(key)),
    )
  })

  it('follows the current language at call time', () => {
    const zh = fn('Delete')
    setLocale('en-US')
    expect(fn('Delete')).not.toBe(zh)
  })

  it('passes an unmapped template through, its placeholders filled', () => {
    expect(fn('Open {element}', { element: 'x' })).toBe('Open x')
    expect(fn('Open {element}')).toBe('Open {element}')
  })
})
