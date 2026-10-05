// Our own `{name}` replacement over the shared validation/field/seed messages.
import { afterEach, expect, it } from 'vitest'
import { loginBody } from '@qiwu/shared'
import { Locale as WotLocale } from '@wot-ui/ui/locale'
import { detectLocale, fieldErrors, issueText, locale, setLocale, t, tx } from '@/core/i18n'

afterEach(() => setLocale('zh-CN'))

it('fills named placeholders, keeps unknown ones and answers a missing key with the key', () => {
  expect(t('validation.too_big.string', { field: 'X', maximum: 64 })).toBe('X最多 64 个字符')
  expect(t('validation.required', { other: 1 })).toBe('{field}不能为空')
  expect(t('validation.required')).toBe('{field}不能为空')
  expect(t('no.such.key', { a: 1 })).toBe('no.such.key')
  // a namespace is not a text
  expect(t('validation')).toBe('validation')
})

it('tx: seeded keys translate, admin-created text stays as typed', () => {
  expect(tx('seed.role.root')).toBe('超级管理员')
  expect(tx('Sales {team}')).toBe('Sales {team}')
})

it('translates a shared schema issue with its field label and numbers', () => {
  const issue = (body: object) => loginBody.safeParse(body).error!.issues[0]!
  expect(issueText(loginBody, issue({ username: '', password: 'x' }))).toBe('用户名不能为空')
  setLocale('en-US')
  expect(issueText(loginBody, issue({ username: 'u'.repeat(65), password: 'x' }))).toBe(
    'Username must be at most 64 characters',
  )
})

it('fieldErrors: the first message of each field, in the current language', () => {
  const { issues } = loginBody.safeParse({ username: '', password: 'p'.repeat(129) }).error!
  expect(fieldErrors(loginBody, issues)).toEqual({
    username: '用户名不能为空',
    password: '密码最多 128 个字符',
  })
  setLocale('en-US')
  expect(fieldErrors(loginBody, issues).username).toBe('Username is required')
  expect(fieldErrors(loginBody, [])).toEqual({})
})

it('switches uni and wot-ui too, and remembers the choice', () => {
  setLocale('en-US')
  expect(locale()).toBe('en-US')
  expect(uni.setLocale).toHaveBeenLastCalledWith('en')
  expect((WotLocale.messages() as { calendar: { title: string } }).calendar.title).toBe('Select Date')
  expect(t('common.error.network')).toBe('Network error, please try again later')
  expect(detectLocale()).toBe('en-US')
})

it('every mobile text exists in both languages, the redesigned screens’ texts included', () => {
  const files = import.meta.glob<Record<string, unknown>>('../locales/*/*.json', {
    eager: true,
    import: 'default',
  })
  const keys = (lang: string) =>
    Object.entries(files)
      .filter(([path]) => path.includes(`/${lang}/`))
      .flatMap(([path, content]) => {
        const flat = (node: unknown, prefix: string): string[] =>
          typeof node === 'object' && node
            ? Object.entries(node).flatMap(([k, v]) => flat(v, `${prefix}.${k}`))
            : [prefix]
        return flat(content, path.split('/').pop()!.replace('.json', ''))
      })
      .sort()
  const zh = keys('zh-CN')
  expect(keys('en-US')).toEqual(zh)
  for (const key of [
    'common.version',
    'common.tabBadge.approval',
    'common.tabBadge.message',
    'login.motto',
    'login.slogan',
    'login.privacy',
    'login.terms',
    'login.showPassword',
    'leave.form',
    'home.stats.running',
    'home.recent',
    'home.viewAll',
    'approval.summary',
    'approval.summaryNone',
    'approval.startedBy',
    'approval.startedByAt',
    'approval.yourTurn',
    'approval.pending',
    'approval.process',
    'approval.fullForm',
    'approval.emptyTodo',
    'approval.emptyTodoHint',
    'approval.viewDone',
    'message.summary',
    'message.summaryNone',
    'message.unread',
    'mine.appearance',
    'mine.appearanceSystem',
    'mine.appearanceLight',
    'mine.appearanceDark',
    'mine.appearanceNow',
  ])
    expect(zh).toContain(key)
  expect(t('approval.startedByAt', { name: '李娜', time: '2026-10-02 10:24' })).toBe(
    '李娜 发起于 2026-10-02 10:24',
  )
  setLocale('en-US')
  // the motto is Chinese verse: English shows none; the counter label fits its cell
  expect([t('login.motto'), t('home.stats.unread')]).toEqual(['', 'Unread'])
})
