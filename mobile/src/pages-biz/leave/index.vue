<template>
  <view class="qw-detail qw-stack">
    <view v-if="ready" class="qw-form qw-leave-form">
      <text v-if="task" class="qw-form__hint qw-leave-form__sentBack">{{
        t('leave.sentBack')
      }}</text>
      <view class="qw-field qw-leave-form__leaveKind">
        <QwDictSelect
          v-model="form.leaveKind"
          code="biz.leave_kind"
          :label="t('field.biz.leave.leaveKind')"
          required
        />
        <text v-if="errors.leaveKind" class="qw-field__error">{{ errors.leaveKind }}</text>
      </view>
      <view v-for="f in TIMES" :key="f" :class="`qw-field qw-leave-form__${f}`">
        <wd-cell
          :title="t(`field.biz.leave.${f}`)"
          :value="shown(form[f])"
          :placeholder="t('picker.select')"
          required
          is-link
          @click="picking = f"
        />
        <text v-if="errors[f]" class="qw-field__error">{{ errors[f] }}</text>
      </view>
      <view class="qw-field qw-leave-form__days">
        <wd-cell :title="t('field.biz.leave.days')" required center>
          <wd-input-number
            v-model="form.days"
            :min="0.5"
            :max="9999.9"
            :step="0.5"
            :precision="1"
            allow-null
          />
        </wd-cell>
        <text v-if="errors.days" class="qw-field__error">{{ errors.days }}</text>
      </view>
      <view class="qw-field qw-leave-form__reason">
        <text class="qw-field__label is-required">{{ t('field.biz.leave.reason') }}</text>
        <wd-textarea
          v-model="form.reason"
          :maxlength="500"
          show-word-limit
          :error="!!errors.reason"
        />
        <text v-if="errors.reason" class="qw-field__error">{{ errors.reason }}</text>
      </view>
      <text v-if="error" class="qw-form__error" role="alert">{{ error }}</text>
      <wd-button
        custom-class="qw-btn qw-btn--primary qw-leave-form__submit"
        type="primary"
        block
        :loading="submitting"
        :disabled="submitting"
        @click="submit"
      >
        {{ t(task ? 'approval.decide.resubmit' : 'leave.submit') }}
      </wd-button>
    </view>
    <QwEmpty v-else-if="error" :title="error" />
    <!-- the start's and the end's -->
    <wd-datetime-picker
      :model-value="pickerValue"
      :visible="!!picking"
      :title="picking ? t(`field.biz.leave.${picking}`) : ''"
      root-portal
      @confirm="pick"
      @update:visible="closed"
    />
  </view>
</template>

<script setup lang="ts">
import { computed, reactive, ref, shallowRef, watch } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { leaveCreate, type LeaveVo, type ValidationIssue } from '@qiwu/shared'
import { decide } from '@/core/approvals'
import QwDictSelect from '@/core/components/QwDictSelect.vue'
import QwEmpty from '@/core/components/QwEmpty.vue'
import { formatTime } from '@/core/format'
import { fieldErrors, t } from '@/core/i18n'
import { ApiError, api, errorText } from '@/core/request'

/**
 * A leave request (发起; subpackage pages-biz), model leave's mobile create page (core/views.ts), as the
 * web's leave form: kind (dict), start and end (sent as instants), days, reason; the rules are the shared
 * `leaveCreate`. New: the submit saves it and starts its approval in one request (POST /biz/leaves), then its
 * detail opens. `?id=<request>&task=<begin task>` (sent back to its owner, from the detail): the request to
 * change, then resubmitted (PUT /biz/leaves/:id, POST /wf/tasks/:task/resubmit) and back to the detail. The
 * button shows loading and is disabled while pending.
 */
const TIMES = ['startAt', 'endAt'] as const
type Time = (typeof TIMES)[number]

const id = ref(0)
const task = ref(0)
const ready = ref(false)
const error = ref('')
const submitting = ref(false)
/** the times as epoch ms (the picker's), 0 = none; days '' = none (the input's) */
const form = reactive({
  leaveKind: null as string | null,
  startAt: 0,
  endAt: 0,
  days: '' as number | '',
  reason: '',
})
const issues = shallowRef<ValidationIssue[]>([])
const errors = computed(() => fieldErrors(leaveCreate, issues.value))

const picking = ref<Time | ''>('')
/** an empty end starts at the start */
const pickerValue = computed(() =>
  picking.value ? form[picking.value] || form.startAt || Date.now() : Date.now(),
)
const pick = ({ value }: { value: number }) => {
  if (picking.value) form[picking.value] = value
}
const closed = (open: boolean) => open || (picking.value = '')
const shown = (ms: number) => (ms ? formatTime(new Date(ms).toISOString()) : '')

const input = () => ({
  leaveKind: form.leaveKind ?? '',
  startAt: form.startAt ? new Date(form.startAt).toISOString() : '',
  endAt: form.endAt ? new Date(form.endAt).toISOString() : '',
  days: form.days === '' ? undefined : form.days,
  reason: form.reason,
})
// once shown, the messages follow the input
watch(form, () => {
  if (issues.value.length) issues.value = leaveCreate.safeParse(input()).error?.issues ?? []
})

onLoad(async (query) => {
  id.value = Number(query?.id) || 0
  task.value = Number(query?.task) || 0
  uni.setNavigationBarTitle({ title: t(id.value ? 'leave.edit' : 'home.shortcut.leave') })
  if (!id.value) return void (ready.value = true)
  try {
    const row = await api.get<LeaveVo>(`/biz/leaves/${id.value}`)
    Object.assign(form, {
      leaveKind: row.leaveKind,
      startAt: Date.parse(row.startAt),
      endAt: Date.parse(row.endAt),
      days: row.days,
      reason: row.reason,
    })
    ready.value = true
  } catch (e) {
    error.value = errorText(e)
  }
})

async function submit() {
  if (submitting.value) return
  const parsed = leaveCreate.safeParse(input())
  issues.value = parsed.error?.issues ?? []
  if (!parsed.success) return
  submitting.value = true
  error.value = ''
  try {
    if (!id.value) {
      const saved = await api.post<LeaveVo>('/biz/leaves', parsed.data)
      uni.showToast({ title: t('leave.submitted'), icon: 'none' })
      uni.redirectTo({ url: `/pages-wf/detail/index?id=${saved.instanceId}` })
      return
    }
    await api.put<null>(`/biz/leaves/${id.value}`, parsed.data)
    await decide(task.value, 'resubmit', {})
    uni.showToast({ title: t('leave.resubmitted'), icon: 'none' })
    uni.navigateBack()
  } catch (e) {
    // a 400 (the rules), a 404 (no longer mine) belongs here; the request layer toasts the rest (409: no
    // longer sent back to me)
    if (e instanceof ApiError && (e.status === 400 || e.status === 404)) error.value = e.message
  } finally {
    submitting.value = false
  }
}
</script>

<style>
.qw-leave-form .wd-input-number {
  flex: none;
}
</style>
