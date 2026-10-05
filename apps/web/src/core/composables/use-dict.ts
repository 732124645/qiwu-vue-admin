import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import { localized } from '@/core/i18n'
import { useDictStore } from '@/core/stores/dict'

/**
 * One dict for scripts (the dict loads on first use): `options` = `{ value, label }` of the enabled entries
 * with localized labels (for el-select / el-radio-group), `label(value)` = the localized label of a value.
 * `code` may be a getter (a picker whose dict changes); an empty code has no entries and loads nothing.
 */
export function useDict(code: MaybeRefOrGetter<string>) {
  const dict = useDictStore()
  const options = computed(() => {
    const c = toValue(code)
    return c
      ? dict.entries(c).map((e) => ({ value: e.value, label: localized(e.labelI18n, e.label) }))
      : []
  })
  const label = (value: unknown) => {
    const c = toValue(code)
    return c ? dict.label(c, value) : String(value ?? '')
  }
  return { options, label }
}
