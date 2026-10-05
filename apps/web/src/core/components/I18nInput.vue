<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { type I18nText, type Locale, LOCALES } from '@qiwu/shared'

/**
 * A per-locale text (`*_i18n` JSON, mode B; see docs/design-notes.md#i18n): one input per language, each prefixed with the
 * language's name. `v-model` = `{ 'zh-CN'?, 'en-US'? }` or null (a row saved without any); the server
 * drops blank texts (`i18nTextInput`). `label` names the field for screen readers.
 * `<I18nInput v-model="model.nameI18n" :label="t('field.settings.dict.nameI18n')" :maxlength="100" />`
 */
defineOptions({ name: 'I18nInput' })
const model = defineModel<I18nText | null | undefined>()
const { label, maxlength } = defineProps<{ label: string; maxlength?: number }>()
const { t } = useI18n()

const LANGUAGE: Record<Locale, string> = {
  'zh-CN': 'common.language.zhCN',
  'en-US': 'common.language.enUS',
}
const set = (locale: Locale, text: string) => (model.value = { ...model.value, [locale]: text })
</script>

<template>
  <div class="i18n-input">
    <el-input
      v-for="l in LOCALES"
      :key="l"
      :model-value="model?.[l] ?? ''"
      :maxlength
      :lang="l"
      :aria-label="`${label} (${t(LANGUAGE[l])})`"
      @update:model-value="set(l, $event)"
    >
      <template #prepend>{{ t(LANGUAGE[l]) }}</template>
    </el-input>
  </div>
</template>

<style scoped>
.i18n-input {
  display: grid;
  gap: 8px;
  width: 100%;
}
/* both prefixes as wide as the longer one, so the inputs start together */
.i18n-input :deep(.el-input-group__prepend) {
  width: 88px;
  justify-content: flex-start;
}
</style>
