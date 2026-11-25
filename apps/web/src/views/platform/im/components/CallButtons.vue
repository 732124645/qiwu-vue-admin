<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ImCallMode, ImMember } from '@qiwu/shared'
import type { ImRoomRecord } from '@qiwu/shared/im-client'
import { imApi } from '@/api/platform/im'
import { useAuthStore } from '@/core/stores/auth'
import { useImStore } from '@/core/im/im-store'
import { useImCallsStore } from '@/core/im/calls-store'

const props = defineProps<{ room: ImRoomRecord }>()
const { t } = useI18n(),
  auth = useAuthStore(),
  im = useImStore(),
  calls = useImCallsStore()
const picker = ref(false),
  loading = ref(false),
  selected = ref<number[]>([]),
  members = ref<ImMember[]>([]),
  mode = ref<ImCallMode>('audio')
async function start(next: ImCallMode) {
  if (!calls.enabled || loading.value || calls.view.busy || props.room.detail?.closedAt) return
  mode.value = next
  if (props.room.detail?.kind !== 'group') return calls.controller.start(props.room.roomId, next)
  loading.value = true
  const roomId = props.room.roomId,
    userId = auth.me?.user.id,
    epoch = im.options?.epoch
  try {
    const items = await imApi.members(roomId)
    // 成员请求返回时可能已经切账号或停用通话，不恢复旧会话的选择框。
    if (
      !calls.enabled ||
      props.room.roomId !== roomId ||
      auth.me?.user.id !== userId ||
      im.options?.epoch !== epoch
    )
      return
    members.value = items.filter((m) => m.enabled && m.userId !== userId)
    selected.value = []
    picker.value = true
  } catch {
    /* 成员接口已显示服务端错误。 */
  } finally {
    loading.value = false
  }
}
async function confirm() {
  if (!selected.value.length || calls.view.busy) return
  picker.value = false
  await calls.controller.start(props.room.roomId, mode.value, selected.value)
}
</script>
<template>
  <span class="im-call-buttons">
    <el-tooltip v-if="!im.options?.callConfigured" :content="t('im.calls.unconfigured')"
      ><span>{{ t('im.calls.unconfigured') }}</span></el-tooltip
    >
    <span v-else-if="calls.unavailable" role="status">{{ t(calls.unavailable) }}</span>
    <el-button
      :disabled="!calls.enabled || !!room.detail?.closedAt || calls.view.busy || loading"
      :loading="loading || calls.view.busy"
      @click="start('audio')"
      >{{ t('im.calls.audio') }}</el-button
    >
    <el-button
      :disabled="!calls.enabled || !!room.detail?.closedAt || calls.view.busy || loading"
      :loading="loading || calls.view.busy"
      @click="start('video')"
      >{{ t('im.calls.video') }}</el-button
    >
    <el-dialog v-model="picker" :title="t('im.calls.pickMembers')" width="420px">
      <el-checkbox-group v-model="selected" :max="7"
        ><el-checkbox v-for="member in members" :key="member.userId" :value="member.userId">{{
          member.displayName
        }}</el-checkbox></el-checkbox-group
      >
      <template #footer
        ><el-button @click="picker = false">{{ t('im.action.cancel') }}</el-button
        ><el-button
          type="primary"
          :disabled="!selected.length || calls.view.busy"
          :loading="calls.view.busy"
          @click="confirm"
          >{{ t('im.calls.invite') }}</el-button
        ></template
      >
    </el-dialog>
  </span>
</template>
<style scoped>
.im-call-buttons {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  color: var(--qw-text-3);
  font-size: 12px;
}
</style>
