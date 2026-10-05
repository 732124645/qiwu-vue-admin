<script setup lang="ts">
import { useDict } from '@/core/composables/use-dict'

/**
 * el-select over a dict's entries (values are the entries' string codes, labels localized):
 * `<DictSelect v-model="query.enabled" code="core.enabled" />`; other attrs (multiple, placeholder…) pass on.
 * A new `code` reloads the entries; none (a form designer's fresh `qw-dict-select`) leaves the list empty.
 */
const { code = '' } = defineProps<{ code?: string }>()
const model = defineModel<string | string[] | null>()
const { options } = useDict(() => code)
</script>

<template>
  <el-select v-model="model" clearable>
    <el-option v-for="o in options" :key="o.value" :label="o.label" :value="o.value" />
  </el-select>
</template>
