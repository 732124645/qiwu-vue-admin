<template>
  <view class="qw-detail qw-stack">
    <view v-if="document" class="qw-card qw-office-document"
      ><QwBusinessSummary :summary="document"
    /></view>
    <QwEmpty v-else-if="error" :title="error" />
    <wd-loading v-else />
  </view>
</template>
<script setup lang="ts">
import { ref, shallowRef, watch } from 'vue'
import { loadSummary, type FormSummary } from '@/core/approvals'
import QwBusinessSummary from '@/core/components/QwBusinessSummary.vue'
import QwEmpty from '@/core/components/QwEmpty.vue'
import { t } from '@/core/i18n'
const props = defineProps<{ kind: 'trip' | 'expense' | 'seal'; businessKey: string }>()
const document = shallowRef<FormSummary | null>()
const error = ref('')
let sequence = 0
/** 业务详情始终由服务端按流程参与者鉴权；只读页没有发起或修改入口。 */
watch(
  () => [props.kind, props.businessKey],
  async () => {
    const mine = ++sequence
    document.value = undefined
    error.value = ''
    if (!props.businessKey) return
    const loaded = await loadSummary({
      formKind: 'custom',
      viewComponent: `oa/${props.kind}/view`,
      businessKey: props.businessKey,
    })
    if (mine !== sequence) return
    document.value = loaded
    if (!loaded) error.value = t('approval.documentUnavailable')
  },
  { immediate: true },
)
</script>
<style>
.qw-office-document {
  padding: var(--qw-space-4);
}
</style>
