<script setup lang="ts">
import { onMounted, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import type { WfStartInfoVo } from '@qiwu/shared'
import { wfCenterApi } from '@/api/workflow/center'
import { toastRest } from '@/core/composables/use-crud'
import { tx } from '@/core/i18n'
import WfUserIds from '@/views/workflow/designer/WfUserIds.vue'

const props = defineProps<{ modelKey: string; modelValue: Record<string, number[]> }>()
const emit = defineEmits<{
  'update:modelValue': [value: Record<string, number[]>]
  ready: [value: boolean]
}>()
const { t } = useI18n()
const picks = shallowRef<WfStartInfoVo['picks']>([])
const loading = ref(true)
const failed = ref(false)
const tried = ref(false)

/** 选人规则来自当前发布流程，加载失败时不能带着猜测的人员发起。 */
onMounted(async () => {
  try {
    picks.value = (await wfCenterApi.startInfo(props.modelKey)).picks
    emit('ready', true)
  } catch (e) {
    failed.value = true
    toastRest(e)
    emit('ready', false)
  } finally {
    loading.value = false
  }
})
const errorOf = (p: WfStartInfoVo['picks'][number]) =>
  tried.value && !props.modelValue[p.id]?.length
    ? t('validation.wf.picks_missing', { node: tx(p.name) })
    : ''
function validate() {
  tried.value = true
  return !loading.value && !failed.value && picks.value.every((p) => !errorOf(p))
}
defineExpose({ validate })
</script>

<template>
  <div v-loading="loading" class="oa-picks">
    <p v-if="failed" role="alert">{{ t('oa.unavailable') }}</p>
    <el-form-item v-for="p in picks" :key="p.id" :label="tx(p.name)" :error="errorOf(p)">
      <WfUserIds
        :model-value="modelValue[p.id] ?? []"
        source="wf"
        @update:model-value="emit('update:modelValue', { ...modelValue, [p.id]: $event })"
      />
    </el-form-item>
  </div>
</template>
