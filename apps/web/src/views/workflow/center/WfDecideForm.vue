<script lang="ts">
/** a decision on a task of mine */
export type WfDecision = 'approve' | 'reject' | 'sendBack' | 'transfer' | 'delegate'
/**
 * the dialog's action: a decision, or add-sign / cc / comment on my pending task, remove-sign
 * of my add-sign tasks, withdraw of my approval, cancel of my instance, resubmit of my sent-back `begin` task
 */
export type WfTaskAction =
  WfDecision | 'addSign' | 'removeSign' | 'cc' | 'comment' | 'withdraw' | 'cancel' | 'resubmit'
</script>

<script setup lang="ts">
import { computed, reactive, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FormInstance } from 'element-plus'
import {
  type ObjectSchema,
  type WfBackTargetVo,
  type WfInstanceDetailVo,
  WF_SIGN_KINDS,
  type WfSignKind,
  wfAddSignBody,
  wfCcBody,
  wfCommentBody,
  wfHandOverBody,
  wfRemarkBody,
  wfRemoveSignBody,
  wfSendBackBody,
} from '@qiwu/shared'
import { wfCenterApi } from '@/api/workflow/center'
import UserSelect from '@/core/components/UserSelect.vue'
import { toastRest } from '@/core/composables/use-crud'
import { revalidateOnLocale, zodRules } from '@/core/form/zod-rules'
import { refName, tx } from '@/core/i18n'
import WfUserIds from '../designer/WfUserIds.vue'

/**
 * One action of the caller's (动作语义, /4; see docs/design-notes.md#workflow), a dialog content component:
 * `await openDialog<true>(WfDecideForm, { id, action, commentRequired, signs, formValues }, { title })`. `id` = the task
 * (withdraw: my approved one; remove-sign: the parent of `signs`; cancel: the instance; resubmit: my `begin`
 * task of a dynamic form, as it stands). Send back picks one of the task's back targets; transfer and delegate
 * pick a user; add-sign (before / after) and cc pick users, all from every enabled user (UserPicker source
 * `wf`); remove-sign picks among `signs`. Each takes a comment (cc: a reason), required for a comment and to
 * approve, reject or add-sign after (an approval too) on a `commentRequired` step. The rules are the
 * shared body schemas. Resolves `true` once done.
 */
defineOptions({ name: 'WfDecideForm' })
const {
  id,
  action,
  commentRequired = false,
  signs = [],
  formValues,
} = defineProps<{
  id: number
  action: WfTaskAction
  commentRequired?: boolean
  signs?: WfInstanceDetailVo['signs']
  /** approve / resubmit: a dynamic form's `edit` fields as the caller changed them (the server keeps those only) */
  formValues?: Record<string, unknown>
}>()
const emit = defineEmits<{ done: [ok: true]; cancel: [] }>()
const i18n = useI18n()
const { t } = i18n

const model = reactive({
  comment: '',
  reason: '',
  to: '',
  userId: null as number | null,
  kind: 'before' as WfSignKind,
  userIds: [] as number[],
  taskIds: [] as number[],
})
const handOver = action === 'transfer' || action === 'delegate'
/** cc's note is its `reason` */
const note = action === 'cc' ? 'reason' : 'comment'
const SCHEMAS: Partial<Record<WfTaskAction, ObjectSchema>> = {
  sendBack: wfSendBackBody,
  transfer: wfHandOverBody,
  delegate: wfHandOverBody,
  addSign: wfAddSignBody,
  removeSign: wfRemoveSignBody,
  cc: wfCcBody,
  comment: wfRemarkBody, // comment required
}
const base = zodRules(SCHEMAS[action] ?? wfCommentBody, i18n)
const remark = zodRules(wfRemarkBody, i18n)
/** approving takes the step's required comment: approve, reject, and add-sign after (the caller approves) */
const approving = computed(
  () =>
    action === 'approve' || action === 'reject' || (action === 'addSign' && model.kind === 'after'),
)
const rules = computed(() => (commentRequired && approving.value ? { ...base, ...remark } : base))
const formRef = ref<FormInstance>()
revalidateOnLocale(formRef)
// a comment error of add-sign after goes once it is before again
watch(
  () => model.kind,
  () => formRef.value?.clearValidate('comment'),
)

const hint = computed(() =>
  action === 'addSign'
    ? t(`wf.center.decide.signHint.${model.kind}`)
    : action === 'delegate' || action === 'withdraw' || action === 'cancel' || action === 'resubmit'
      ? t(`wf.center.decide.${action}Hint`)
      : '',
)

const targets = shallowRef<WfBackTargetVo[]>([])
const loading = ref(action === 'sendBack')
if (action === 'sendBack')
  wfCenterApi
    .backTargets(id)
    .then((list) => (targets.value = list))
    .catch((e: unknown) => {
      toastRest(e)
      emit('cancel')
    })
    .finally(() => (loading.value = false))

/** posts the action (404: no longer mine; 409: handled meanwhile; 422: e.g. the user already holds the step) */
function post() {
  const api = wfCenterApi
  const comment = model.comment.trim() || undefined
  switch (action) {
    case 'sendBack':
      return api.sendBack(id, { to: model.to, comment })
    case 'transfer':
    case 'delegate':
      return api[action](id, { userId: model.userId!, comment })
    case 'addSign':
      return api.addSign(id, { kind: model.kind, userIds: model.userIds, comment })
    case 'removeSign':
      return api.removeSign(id, { taskIds: model.taskIds, comment })
    case 'cc':
      return api.cc(id, { userIds: model.userIds, reason: model.reason.trim() || undefined })
    case 'comment':
      return api.comment(id, { comment: model.comment.trim() })
    case 'approve':
    case 'resubmit':
      return api[action](id, { comment, formValues })
    default: // reject, withdraw, cancel
      return api[action](id, { comment })
  }
}

const submitting = ref(false)
async function submit() {
  if (submitting.value || !(await formRef.value?.validate().catch(() => false))) return
  submitting.value = true
  try {
    await post()
    emit('done', true)
  } catch (e) {
    toastRest(e)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-form
    ref="formRef"
    v-loading="loading"
    :model="model"
    :rules="rules"
    label-position="top"
    @submit.prevent
  >
    <p v-if="hint" class="wf-decide__hint">{{ hint }}</p>
    <el-form-item v-if="action === 'sendBack'" :label="t('field.wf.task.to')" prop="to">
      <el-radio-group v-model="model.to" class="wf-decide__targets">
        <el-radio v-for="s in targets" :key="s.id" :value="s.id">
          {{ s.type === 'begin' ? t('wf.center.list.initiator') : tx(s.name) }}
        </el-radio>
      </el-radio-group>
    </el-form-item>
    <el-form-item v-else-if="handOver" :label="t('field.wf.task.userId')" prop="userId">
      <UserSelect v-model="model.userId" source="wf" />
    </el-form-item>
    <el-form-item v-else-if="action === 'addSign'" :label="t('field.wf.task.kind')" prop="kind">
      <el-radio-group v-model="model.kind">
        <el-radio v-for="k in WF_SIGN_KINDS" :key="k" :value="k">
          {{ t(`wf.center.decide.sign.${k}`) }}
        </el-radio>
      </el-radio-group>
    </el-form-item>
    <el-form-item
      v-else-if="action === 'removeSign'"
      :label="t('field.wf.task.taskIds')"
      prop="taskIds"
    >
      <el-checkbox-group v-model="model.taskIds">
        <el-checkbox v-for="s in signs" :key="s.id" :value="s.id">
          {{ refName(s.user.id, s.user.name) }}
        </el-checkbox>
      </el-checkbox-group>
    </el-form-item>
    <el-form-item
      v-if="action === 'addSign' || action === 'cc'"
      :label="t('field.wf.task.userIds')"
      prop="userIds"
    >
      <WfUserIds v-model="model.userIds" source="wf" />
    </el-form-item>
    <el-form-item :label="t(`field.wf.task.${note}`)" :prop="note">
      <el-input
        v-model="model[note]"
        type="textarea"
        :rows="3"
        maxlength="1000"
        show-word-limit
        :placeholder="
          t(action === 'cc' ? 'wf.center.decide.reasonHint' : 'wf.center.decide.commentHint')
        "
      />
    </el-form-item>
  </el-form>
  <div class="qw-dialog-footer">
    <el-button @click="emit('cancel')">{{ t('common.action.cancel') }}</el-button>
    <el-button type="primary" :loading="submitting" :disabled="loading" @click="submit">
      {{ t(`wf.center.decide.${action}`) }}
    </el-button>
  </div>
</template>

<style scoped>
.wf-decide__hint {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 20px;
  color: var(--qw-text-2);
}
.wf-decide__targets {
  flex-direction: column;
  align-items: flex-start;
}
</style>
