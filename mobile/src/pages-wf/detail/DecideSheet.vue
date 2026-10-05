<template>
  <wd-popup v-model="visible" position="bottom" round safe-area-inset-bottom root-portal>
    <view class="qw-decide">
      <text class="qw-decide__title">{{ title }}</text>
      <text v-if="hint" class="qw-form__hint qw-decide__hint">{{ hint }}</text>
      <view v-if="action === 'sendBack'" class="qw-field qw-decide__to">
        <text class="qw-field__label is-required">{{ t('field.wf.task.to') }}</text>
        <wd-loading v-if="loading" />
        <wd-radio-group v-else v-model="form.to">
          <wd-radio v-for="s in targets" :key="s.id" :value="s.id">
            {{ s.type === 'begin' ? t('approval.initiator') : tx(s.name) }}
          </wd-radio>
        </wd-radio-group>
        <text v-if="errors.to" class="qw-field__error">{{ errors.to }}</text>
      </view>
      <view v-else-if="action === 'addSign'" class="qw-field qw-decide__kind">
        <text class="qw-field__label is-required">{{ t('field.wf.task.kind') }}</text>
        <wd-radio-group v-model="form.kind" direction="horizontal">
          <wd-radio v-for="k in WF_SIGN_KINDS" :key="k" :value="k">
            {{ t(`approval.decide.sign.${k}`) }}
          </wd-radio>
        </wd-radio-group>
      </view>
      <view v-else-if="action === 'removeSign'" class="qw-field qw-decide__signs">
        <text class="qw-field__label is-required">{{ t('field.wf.task.taskIds') }}</text>
        <wd-checkbox-group v-model="form.taskIds">
          <wd-checkbox v-for="s in signs" :key="s.id" :name="s.id">
            {{ s.user.name ?? s.user.id }}
          </wd-checkbox>
        </wd-checkbox-group>
        <text v-if="errors.taskIds" class="qw-field__error">{{ errors.taskIds }}</text>
      </view>
      <view v-if="picks" class="qw-decide__user">
        <QwUserPicker
          v-model="form.user"
          :multiple="picks === 'userIds'"
          :label="t(`field.wf.task.${picks}`)"
          required
        />
        <text v-if="errors[picks]" class="qw-field__error">{{ errors[picks] }}</text>
      </view>
      <view class="qw-field qw-decide__comment">
        <text class="qw-field__label" :class="{ 'is-required': required }">
          {{ t(`field.wf.task.${note}`) }}
        </text>
        <wd-textarea
          v-model="form.comment"
          :maxlength="1000"
          show-word-limit
          :placeholder="
            t(note === 'reason' ? 'approval.decide.reasonHint' : 'approval.decide.commentHint')
          "
          :error="!!errors[note]"
        />
        <text v-if="errors[note]" class="qw-field__error">{{ errors[note] }}</text>
      </view>
      <text v-if="error" class="qw-form__error" role="alert">{{ error }}</text>
      <wd-button
        custom-class="qw-btn qw-btn--primary qw-decide__submit"
        type="primary"
        block
        :loading="submitting"
        :disabled="submitting || loading"
        @click="submit"
      >
        {{ label }}
      </wd-button>
    </view>
  </wd-popup>
</template>

<script setup lang="ts">
import { computed, reactive, ref, shallowRef, watch } from 'vue'
import { WF_SIGN_KINDS, type ValidationIssue, type WfBackTargetVo } from '@qiwu/shared'
import {
  decide,
  decideBody,
  decideSchema,
  loadBackTargets,
  mustComment,
  noteField,
  type DecideForm,
  type WfDecision,
  type WfOn,
  type WfSign,
} from '@/core/approvals'
import QwUserPicker from '@/core/components/QwUserPicker.vue'
import { fieldErrors, t, tx } from '@/core/i18n'
import { ApiError, errorText } from '@/core/request'

/**
 * One action through a bottom sheet (as the web's WfDecideForm), opened with `open(on)`:
 * `on` = the action, its task (cancel: the instance) and step. Send back picks one of the task's back targets
 * (steps already passed, then the initiator); transfer and delegate pick a user, add-sign (before / after) and
 * cc users (QwUserPicker, source `wf`); remove-sign picks among `signs` (my add-signs still pending). Each
 * takes a comment (cc: its note), required for a comment, and to approve, reject or add-sign after on a
 * `commentRequired` step. The rules are the shared body schemas: nothing is posted until they pass.
 * The button shows loading and is disabled while the request is pending. Emits `done`.
 * `open(on, formValues)`: an approve or resubmit also sends the dynamic form's `edit` fields (the detail
 * checked them; the comment body's schema would strip them, so they go in after it).
 */
defineProps<{ signs: WfSign[] }>()
const emit = defineEmits<{ done: [] }>()

const visible = ref(false)
const on = shallowRef<WfOn>({ action: 'approve', id: 0, node: '', commentRequired: false })
const action = computed(() => on.value.action as WfDecision)
const blank = (): DecideForm => ({ comment: '', to: '', user: [], kind: 'before', taskIds: [] })
const form = reactive<DecideForm>(blank())
const issues = shallowRef<ValidationIssue[]>([])
const error = ref('')
const targets = shallowRef<WfBackTargetVo[]>([])
/** the back targets are loading */
const loading = ref(false)
const submitting = ref(false)
let seq = 0
let formValues: Record<string, unknown> | undefined

const label = computed(() => t(`approval.decide.${action.value}`))
const title = computed(() =>
  on.value.node ? `${label.value} · ${tx(on.value.node)}` : label.value,
)
const HINTS: Partial<Record<WfDecision, string>> = {
  delegate: 'approval.decide.delegateHint',
  withdraw: 'approval.decide.withdrawHint',
  cancel: 'approval.decide.cancelHint',
}
const hint = computed(() =>
  action.value === 'addSign'
    ? t(`approval.decide.signHint.${form.kind}`)
    : HINTS[action.value] && t(HINTS[action.value]!),
)
/** the user field: transfer and delegate pick one, add-sign and cc several */
const picks = computed(() =>
  action.value === 'transfer' || action.value === 'delegate'
    ? 'userId'
    : action.value === 'addSign' || action.value === 'cc'
      ? 'userIds'
      : '',
)
const note = computed(() => noteField(action.value))
const required = computed(
  () =>
    action.value === 'comment' || mustComment(action.value, form.kind, on.value.commentRequired),
)
const errors = computed(() => fieldErrors(decideSchema(action.value), issues.value))
const check = () => decideBody(action.value, form, on.value.commentRequired)
// once shown, the messages follow the input (add-sign after's comment message goes with before again)
watch(form, () => {
  if (issues.value.length) issues.value = check().issues
})

function open(next: WfOn, values?: Record<string, unknown>) {
  const mine = ++seq
  on.value = next
  formValues = values
  Object.assign(form, blank())
  issues.value = []
  error.value = ''
  targets.value = []
  loading.value = next.action === 'sendBack'
  visible.value = true
  if (next.action === 'sendBack')
    loadBackTargets(next.id)
      .then(
        (list) => mine === seq && (targets.value = list),
        (e: unknown) => mine === seq && (error.value = errorText(e)),
      )
      .finally(() => mine === seq && (loading.value = false))
}

async function submit() {
  if (submitting.value || loading.value) return
  const { body, issues: found } = check()
  issues.value = found
  if (!body) return
  submitting.value = true
  error.value = ''
  try {
    await decide(on.value.id, action.value, formValues ? { ...body, formValues } : body)
    visible.value = false
    emit('done')
  } catch (e) {
    // a 400, or a 404 (the task is no longer mine), belongs to the sheet; the request layer toasts the rest
    if (e instanceof ApiError && (e.status === 400 || e.status === 404)) error.value = e.message
  } finally {
    submitting.value = false
  }
}

defineExpose({ open })
</script>
