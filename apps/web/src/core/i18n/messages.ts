import { mergeLocaleFile, type Messages } from '@qiwu/shared'

const sharedFiles = import.meta.glob<Messages>(
  '../../../../../packages/shared/src/i18n/*/**/*.json',
  { eager: true, import: 'default' },
)
const webFiles = import.meta.glob<Messages>('/src/locales/*/**/*.json', {
  eager: true,
  import: 'default',
})

/** 汇总共享校验与字段文案，供独立表单及应用翻译使用。 */
export const sharedMessages: Record<string, Messages> = {}
for (const [path, content] of Object.entries(sharedFiles)) {
  const lang = path.match(/\/i18n\/([^/]+)\//)?.[1] ?? ''
  mergeLocaleFile((sharedMessages[lang] ??= {}), path, content)
}

/** 每轮重新合并整棵语言树，避免热更新后保留已删除的字段。 */
export const messages = structuredClone(sharedMessages)
for (const [path, content] of Object.entries(webFiles)) {
  const lang = path.match(/\/locales\/([^/]+)\//)?.[1] ?? ''
  mergeLocaleFile((messages[lang] ??= {}), path, content)
}
