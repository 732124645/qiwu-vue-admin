<script setup lang="ts">
import { computed } from 'vue'
import type { TagProps } from 'element-plus'
import { useDictStore } from '@/core/stores/dict'

/**
 * A dict value as its localized label (`label_i18n[locale]` → `label` → the value): a status pill (dot +
 * text on the tint of the entry's `tagType`, styles/element.css), plain text when it has none; the entry's `cssClass` applies either way.
 * `<DictTag code="core.enabled" :value="row.enabled" />` — the dict loads on first use.
 */
const { code, value } = defineProps<{ code: string; value: unknown }>()

const TAG_TYPES: readonly string[] = ['primary', 'success', 'info', 'warning', 'danger']

const dict = useDictStore()
const entry = computed(() => dict.entries(code).find((e) => e.value === String(value)))
const type = computed(() => {
  const tagType = entry.value?.tagType
  return tagType && TAG_TYPES.includes(tagType) ? (tagType as TagProps['type']) : undefined
})
</script>

<template>
  <el-tag
    v-if="type"
    :type="type"
    class="qw-dict-tag"
    :class="entry?.cssClass"
    disable-transitions
    >{{ dict.label(code, value) }}</el-tag
  >
  <span v-else :class="entry?.cssClass">{{ dict.label(code, value) }}</span>
</template>
