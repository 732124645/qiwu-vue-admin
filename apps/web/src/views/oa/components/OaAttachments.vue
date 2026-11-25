<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FsObjectVo } from '@qiwu/shared'
import { storageApi } from '@/api/platform/storage/object'
import FileUpload from '@/core/components/FileUpload.vue'

const { readonly = false, disabled = false } = defineProps<{
  readonly?: boolean
  disabled?: boolean
}>()
const ids = defineModel<number[]>({ default: () => [] })
const emit = defineEmits<{ busy: [value: boolean] }>()
const { t } = useI18n()
const files = shallowRef<FsObjectVo[]>([])
const loading = ref(false)
const failed = ref(false)
const upload = ref<InstanceType<typeof FileUpload>>()
let generation = 0
const busy = computed(() => loading.value || failed.value || !!upload.value?.pending.length)
watch(busy, (value) => emit('busy', value), { immediate: true })

/** 仅经受业务权限保护的元信息接口恢复文件名，不请求全局文件详情或猜测下载名称。 */
async function load() {
  const current = ++generation
  loading.value = true
  failed.value = false
  try {
    const existing = new Map(files.value.map((file) => [file.id, file]))
    const result = await Promise.all(
      ids.value.map((id) => existing.get(id) ?? storageApi.metadata(id)),
    )
    if (current === generation) files.value = result
  } catch {
    if (current === generation) failed.value = true
  } finally {
    if (current === generation) loading.value = false
  }
}
watch(
  () => [...ids.value],
  () => void load(),
  { immediate: true },
)
/** 列表更新来自已完成上传；正在上传或元信息读取失败时父表单不可提交。 */
function update(value: FsObjectVo[]) {
  files.value = value
  ids.value = value.map((file) => file.id)
}
</script>
<template>
  <div v-loading="loading" class="oa-attachments">
    <el-alert
      v-if="failed"
      :title="t('oa.attachmentsUnavailable')"
      type="error"
      :closable="false"
    />
    <el-button v-if="failed" :disabled="loading" @click="load">{{
      t('common.action.retry')
    }}</el-button>
    <FileUpload
      v-if="!readonly || files.length"
      ref="upload"
      :model-value="files"
      biz-tag="oa.attachment"
      :disabled="readonly || disabled || failed"
      @update:model-value="update"
    />
  </div>
</template>
