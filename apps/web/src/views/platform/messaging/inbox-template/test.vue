<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useI18n } from 'vue-i18n'
import type { InboxTemplateVo } from '@qiwu/shared'
import { inboxTemplateApi } from '@/api/platform/messaging/inbox-template'
import { toastRest } from '@/core/composables/use-crud'

defineOptions({ name: 'MessagingInboxTemplateTest' })
const { row } = defineProps<{ row: InboxTemplateVo }>()
const emit = defineEmits<{ done: [id: number]; cancel: [] }>()
const { t } = useI18n()
const params = ref<Record<string, string>>(
  Object.fromEntries((row.paramNames ?? []).map((name) => [name, ''])),
)
const sending = ref(false)

async function send() {
  if (sending.value) return
  sending.value = true
  try {
    const result = await inboxTemplateApi.testSend(row.id, params.value)
    if (!result.ok) {
      ElMessage.error(t('messaging.inboxTemplate.testFailed'))
      return
    }
    ElMessage.success(t('messaging.inboxTemplate.testSent'))
    emit('done', result.recordId)
  } catch (e) {
    toastRest(e)
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <el-form label-position="left" @submit.prevent="send">
    <el-form-item v-for="name in row.paramNames ?? []" :key="name" :label="name">
      <el-input v-model="params[name]" :name="name" maxlength="500" />
    </el-form-item>
    <div class="qw-dialog-footer">
      <el-button @click="emit('cancel')">{{ t('common.action.cancel') }}</el-button>
      <el-button type="primary" native-type="submit" :loading="sending" :disabled="sending">
        {{ t('messaging.inboxTemplate.testSend') }}
      </el-button>
    </div>
  </el-form>
</template>
