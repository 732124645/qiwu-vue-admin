<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, type FormInstance } from 'element-plus'
import { wfReassignBody, wfTerminateBody } from '@qiwu/shared'
import { wfAdminApi } from '@/api/workflow/admin'
import UserSelect from '@/core/components/UserSelect.vue'
import { toastRest } from '@/core/composables/use-crud'
import { revalidateOnLocale, zodRules } from '@/core/form/zod-rules'

/**
 * 终止 instance `id` or 改派 task `id` (管理员; see docs/design-notes.md#workflow), a dialog content component of the admin pages:
 * the new assignee (reassign) and an optional comment. Resolves `true` once done; a refusal (409 no longer
 * open, 422 bad target, 404 out of the caller's scope) is shown and the dialog stays.
 */
defineOptions({ name: 'WfAdminAction' })
const { action, id } = defineProps<{ action: 'terminate' | 'reassign'; id: number }>()
const emit = defineEmits<{ done: [ok: true]; cancel: [] }>()
const i18n = useI18n()
const { t } = i18n

const reassigning = action === 'reassign'
const model = reactive({ to: null as number | null, comment: '' })
const rules = zodRules(reassigning ? wfReassignBody : wfTerminateBody, i18n, model)
const formRef = ref<FormInstance>()
revalidateOnLocale(formRef)
const submitting = ref(false)

async function submit() {
  if (submitting.value || !(await formRef.value?.validate().catch(() => false))) return
  submitting.value = true
  const comment = model.comment.trim() || null
  try {
    if (reassigning) await wfAdminApi.reassign(id, { to: model.to!, comment })
    else await wfAdminApi.terminate(id, { comment })
    ElMessage.success(t(reassigning ? 'wf.admin.reassign.done' : 'wf.admin.terminate.done'))
    emit('done', true)
  } catch (e) {
    toastRest(e) // the request layer toasted 403/409/422/429/5xx
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-alert
    v-if="!reassigning"
    :title="t('wf.admin.terminate.hint')"
    type="warning"
    show-icon
    :closable="false"
    class="wf-admin-action__hint"
  />
  <el-form
    ref="formRef"
    :model="model"
    :rules="rules"
    label-position="left"
    @submit.prevent="submit"
  >
    <el-form-item v-if="reassigning" :label="t('field.wf.admin.to')" prop="to">
      <UserSelect v-model="model.to" />
    </el-form-item>
    <el-form-item :label="t('field.wf.admin.comment')" prop="comment">
      <el-input
        v-model="model.comment"
        type="textarea"
        :rows="3"
        maxlength="1000"
        show-word-limit
      />
    </el-form-item>
  </el-form>
  <div class="qw-dialog-footer">
    <el-button @click="emit('cancel')">{{ t('common.action.cancel') }}</el-button>
    <el-button :type="reassigning ? 'primary' : 'danger'" :loading="submitting" @click="submit">
      {{ t(reassigning ? 'wf.admin.reassign.submit' : 'wf.admin.terminate.submit') }}
    </el-button>
  </div>
</template>

<style scoped>
.wf-admin-action__hint {
  margin-bottom: 20px;
}
</style>
