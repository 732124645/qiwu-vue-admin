import { describe, expect, it } from 'vitest'
import { mergeLocaleFile, type Messages } from './locale.js'

describe('mergeLocaleFile', () => {
  it('a namespace file lands under its name, a module fragment is deep-merged at the root', () => {
    const menu = { home: 'Home', iam: { title: 'IAM' } }
    const fragment = { iam: { position: { entity: 'position' } }, menu: { iam: { position: 'P' } } }
    const m: Messages = {}
    mergeLocaleFile(m, 'src/locales/en-US/menu.json', menu)
    mergeLocaleFile(m, 'C:\\i18n\\en-US\\modules\\iam.position.json', fragment)
    expect(m).toEqual({
      menu: { home: 'Home', iam: { title: 'IAM', position: 'P' } },
      iam: { position: { entity: 'position' } },
    })
    // the file contents are copied, not merged into
    expect(menu).toEqual({ home: 'Home', iam: { title: 'IAM' } })
  })
})
