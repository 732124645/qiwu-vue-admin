<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useI18n } from 'vue-i18n'
import { mailTemplateTestBody, type MailTemplateVo } from '@qiwu/shared'
import { mailTemplateApi } from '@/api/platform/messaging/mail-template'
import { toastRest } from '@/core/composables/use-crud'

const { row } = defineProps<{ row: MailTemplateVo }>()
const emit = defineEmits<{ done: [result: { recordId: number }]; cancel: [] }>()
const { t } = useI18n()
const to = ref('')
const params = reactive<Record<string, string>>({})
const names = computed(() =>
  [
    ...new Set([...`${row.subject} ${row.body}`.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!)),
  ].slice(0, 20),
)
const submitting = ref(false)

async function submit() {
  const body = mailTemplateTestBody.safeParse({
    to: to.value,
    params: Object.fromEntries(names.value.map((name) => [name, params[name] ?? ''])),
  })
  if (!body.success) {
    ElMessage.error(t('messaging.mailTemplate.invalidRecipient'))
    return
  }
  submitting.value = true
  try {
    const result = await mailTemplateApi.test(row.id, body.data)
    ElMessage[result.ok ? 'success' : 'error'](
      t(result.ok ? 'messaging.mailTemplate.testOk' : 'messaging.mailTemplate.testFailed', {
        id: result.recordId,
      }),
    )
    emit('done', { recordId: result.recordId })
  } catch (e) {
    toastRest(e)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-form label-position="left" @submit.prevent="submit">
    <el-form-item :label="t('messaging.mailTemplate.recipient')">
      <el-input v-model="to" type="email" maxlength="128" />
    </el-form-item>
    <el-form-item v-for="name in names" :key="name" :label="name">
      <el-input v-model="params[name]" maxlength="500" />
    </el-form-item>
  </el-form>
  <div class="qw-dialog-footer">
    <el-button @click="emit('cancel')">{{ t('common.action.cancel') }}</el-button>
    <el-button type="primary" :loading="submitting" :disabled="submitting" @click="submit">
      {{ t('messaging.mailTemplate.testSend') }}
    </el-button>
  </div>
</template>
