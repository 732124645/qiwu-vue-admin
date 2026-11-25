<template>
  <view class="qw-detail qw-stack">
    <template v-if="row">
      <wd-cell-group custom-class="qw-group qw-leave" border>
        <wd-cell :title="t('field.biz.leave.state')">
          <text :class="`qw-tag qw-tag--${state.type}`">{{ state.label }}</text>
        </wd-cell>
        <wd-cell :title="t('field.biz.leave.leaveKind')" :value="kind" />
        <wd-cell :title="t('field.biz.leave.days')" :value="row.days.toFixed(1)" />
        <wd-cell :title="t('field.biz.leave.startAt')" :value="formatTime(row.startAt)" />
        <wd-cell :title="t('field.biz.leave.endAt')" :value="formatTime(row.endAt)" />
        <wd-cell :title="t('field.biz.leave.reason')" :label="row.reason" />
        <wd-cell :title="t('field.common.createdAt')" :value="formatTime(row.createdAt)" />
      </wd-cell-group>
      <view class="qw-card qw-leave__attachments">
        <text class="qw-field__label">{{ t('oa.attachments') }}</text>
        <QwAttachments :files="files" />
        <text v-if="fileError" class="qw-form__error">{{ fileError }}</text>
      </view>
      <wd-cell-group v-if="!readonly && row.instanceId" custom-class="qw-group" border>
        <wd-cell
          custom-class="qw-leave__flow"
          :title="t('approval.detail')"
          is-link
          @click="openInstance"
        />
      </wd-cell-group>
    </template>
    <QwEmpty v-else-if="error" :title="error" />
  </view>
</template>

<script setup lang="ts">
import { computed, reactive, ref, shallowRef } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { leaveVo, type DictPayload, type FsObjectVo, type LeaveVo } from '@qiwu/shared'
import { stateTag } from '@/core/approvals'
import QwEmpty from '@/core/components/QwEmpty.vue'
import QwAttachments from '@/core/components/QwAttachments.vue'
import { loadAttachments } from '@/core/attachments'
import { formatTime } from '@/core/format'
import { t } from '@/core/i18n'
import { choiceText, dictChoices, loadDict } from '@/core/pickers'
import { api, currentSessionVersion, errorText } from '@/core/request'

/**
 * One leave request (subpackage pages-biz), the mobile view of model leave's `view_component`
 * (core/views.ts). `?id=` the request; `readonly=1` (opened from its instance's detail): the request
 * alone, else also the way to its approval detail. GET /biz/leaves/:id needs only a sign-in and follows the
 * instance access rule (its owner, the instance's assignees and cc users; else 404, shown with its message).
 */
const row = shallowRef<LeaveVo>()
const error = ref('')
const files = shallowRef<FsObjectVo[]>([])
const fileError = ref('')
const readonly = ref(false)

type Dict = 'biz.leave_kind' | 'biz.leave_state'
const dicts = reactive<Partial<Record<Dict, DictPayload>>>({})
for (const code of ['biz.leave_kind', 'biz.leave_state'] as const)
  loadDict(code).then(
    (d) => (dicts[code] = d),
    () => {}, // shown by the request layer; codes show instead
  )
const kind = computed(() => choiceText(dictChoices(dicts['biz.leave_kind']), row.value?.leaveKind))
const state = computed(() => stateTag(dicts['biz.leave_state'], row.value?.state ?? ''))

const openInstance = () =>
  uni.navigateTo({ url: `/pages-wf/detail/index?id=${row.value!.instanceId}` })

onLoad(async (query) => {
  uni.setNavigationBarTitle({ title: t('leave.view') })
  readonly.value = query?.readonly === '1'
  const version = currentSessionVersion()
  try {
    const loaded = leaveVo.parse(await api.get(`/biz/leaves/${Number(query?.id)}`))
    let attachments: FsObjectVo[] = []
    let failed = false
    try {
      attachments = await loadAttachments(loaded.attachmentIds, 'oa.attachment')
    } catch {
      failed = true
    }
    if (version !== currentSessionVersion()) return
    row.value = loaded
    files.value = attachments
    if (failed) fileError.value = t('approval.attachmentUnavailable')
  } catch (e) {
    if (version === currentSessionVersion()) error.value = errorText(e)
  }
})
</script>

<style>
.qw-leave__attachments {
  padding: var(--qw-space-4);
}
</style>
