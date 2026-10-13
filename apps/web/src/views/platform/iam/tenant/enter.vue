<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FormInstance } from 'element-plus'
import { tenantEnterBody } from '@qiwu/shared'
import { tenantApi } from '@/api/platform/iam/tenant'
import { toastRest } from '@/core/composables/use-crud'
import { revalidateOnLocale, zodRules } from '@/core/form/zod-rules'

/**
 * Entering a tenant (POST /:id/enter), dialog content opened from the tenant list with
 * `openDialog(TenantEnter, { id })`: the reason is required and kept in the audit log. `done` once the
 * session works inside the tenant; the list then reloads the whole page.
 */
defineOptions({ name: 'IamTenantEnter' })
const { id } = defineProps<{ id: number }>()
const emit = defineEmits<{ done: [entered: true]; cancel: [] }>()
const i18n = useI18n()
const { t } = i18n
const model = reactive({ reason: '' })
const formRef = ref<FormInstance>()
const rules = zodRules(tenantEnterBody, i18n)
revalidateOnLocale(formRef)
const submitting = ref(false)

async function submit() {
  if (submitting.value) return
  if (!(await formRef.value?.validate().catch(() => false))) return
  submitting.value = true
  try {
    await tenantApi.enter(id, { reason: model.reason })
    emit('done', true)
  } catch (e) {
    toastRest(e)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-alert type="warning" :title="t('iam.tenant.enter.hint')" :closable="false" show-icon />
  <el-form
    ref="formRef"
    :model="model"
    :rules="rules"
    label-position="left"
    class="tenant-enter"
    @submit.prevent="submit"
  >
    <el-form-item :label="t('field.iam.tenant.reason')" prop="reason">
      <el-input
        v-model="model.reason"
        type="textarea"
        :rows="3"
        maxlength="200"
        show-word-limit
        :placeholder="t('iam.tenant.enter.reasonPlaceholder')"
      />
    </el-form-item>
  </el-form>
  <div class="qw-dialog-footer">
    <el-button @click="emit('cancel')">{{ t('common.action.cancel') }}</el-button>
    <el-button type="primary" :loading="submitting" @click="submit">
      {{ t('iam.tenant.enter.submit') }}
    </el-button>
  </div>
</template>

<style scoped>
.tenant-enter {
  margin-top: 16px;
}
</style>
