import { watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FormInstance, FormItemRule } from 'element-plus'
import {
  fieldDomainOf,
  fieldLabelKeys,
  mergeLocaleFile,
  type Messages,
  type ObjectSchema,
  validationMessage,
} from '@qiwu/shared'

/**
 * The shared messages (packages/shared/src/i18n/<lang>: `validation.*`, `field.*` incl. the module
 * fragments in `modules/`, `seed.*`), deep-merged per locale, to merge into vue-i18n.
 */
export const sharedMessages: Record<string, Messages> = {}
const sharedFiles = import.meta.glob<Messages>(
  '../../../../../packages/shared/src/i18n/*/**/*.json',
  {
    eager: true,
    import: 'default',
  },
)
for (const [path, content] of Object.entries(sharedFiles)) {
  const lang = path.match(/\/i18n\/([^/]+)\//)?.[1] ?? ''
  mergeLocaleFile((sharedMessages[lang] ??= {}), path, content)
}

/** The vue-i18n functions the rules need (`useI18n()` or `i18n.global`). */
export interface FormI18n {
  t: (key: string, params: Record<string, unknown>) => string
  te: (key: string) => boolean
}

/**
 * el-form rules from a shared zod object schema (see docs/adr/003-validation.md): each prop is checked by its own field schema and
 * the message is translated at validation time, so it follows locale switches and matches the server's 400.
 * Pass the form `model` to check the whole schema instead: object-level refinements (e.g. "new password ≠
 * old") then report on their own path too. A field that accepts neither nothing nor '' is `required`, so
 * el-form-item shows the asterisk (§5); the check itself stays the zod one.
 */
export function zodRules(
  schema: ObjectSchema,
  { t, te }: FormI18n,
  model?: Record<string, unknown>,
): Record<string, FormItemRule[]> {
  const domain = fieldDomainOf(schema)
  return Object.fromEntries(
    Object.entries(schema.shape).map(([prop, field]) => [
      prop,
      [
        {
          required: !field.safeParse(undefined).success && !field.safeParse('').success,
          trigger: 'blur',
          validator: (_rule, value, callback) => {
            const issue = model
              ? schema
                  .safeParse({ ...model, [prop]: value })
                  .error?.issues.find((i) => i.path[0] === prop)
              : field.safeParse(value).error?.issues[0]
            if (!issue) return callback()
            const { key, params } = validationMessage(issue)
            const path = model ? issue.path : [prop, ...issue.path]
            const label = fieldLabelKeys(domain, path).find((k) => te(k))
            callback(new Error(t(key, { ...params, field: label ? t(label, {}) : prop })))
          },
        },
      ],
    ]),
  )
}

/**
 * A shown validation message was translated when the field was checked: when the locale changes, check the
 * fields that show one again so it follows the new language. Call from the setup of a form's component.
 */
export function revalidateOnLocale(form: Ref<FormInstance | undefined>) {
  watch(useI18n().locale, () => {
    const shown = form.value?.fields.flatMap((f) =>
      f.validateState === 'error' && f.prop ? [f.prop] : [],
    )
    if (shown?.length) form.value?.validateField(shown).catch(() => undefined)
  })
}
