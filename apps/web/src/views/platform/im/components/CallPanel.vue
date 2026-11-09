<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useImCallsStore } from '@/core/im/calls-store'
import CallVideo from './CallVideo.vue'

const { t } = useI18n(),
  calls = useImCallsStore()
const actionBusy = ref(false)
const busy = computed(() => calls.view.busy || actionBusy.value)
/** 释放和播放授权也显示单飞状态；连接过程中仍可主动取消。 */
async function act(action: 'leave' | 'retry' | 'audio') {
  if (actionBusy.value) return
  actionBusy.value = true
  try {
    if (action === 'retry') await calls.controller.retryDisconnect()
    else if (action === 'audio') await calls.media.startAudio()
    else if (calls.view.current?.canEnd) await calls.controller.end()
    else await calls.controller.leave()
  } catch {
    /* 媒体端口通过受控事件给出错误。 */
  } finally {
    actionBusy.value = false
  }
}
onBeforeUnmount(() => {
  void calls.controller.leave()
})
const current = computed(() => calls.view.current)
const incoming = computed(() =>
  calls.view.calls.filter((c) => c.canAccept || c.canJoin || c.canEnd),
)
const visible = computed(
  () => !!current.value || incoming.value.length > 0 || calls.view.media.state === 'disconnecting',
)
const connected = computed(() => calls.view.media.state === 'connected')
const error = computed(() => {
  const code = calls.view.error?.code
  if (!code) return ''
  return t(
    code === 'BUSY' || code === 'B5031'
      ? 'im.calls.busy'
      : code === 'B5033'
        ? 'im.calls.otherDevice'
        : 'im.calls.failed',
  )
})
</script>
<template>
  <el-dialog
    :model-value="visible"
    :title="t('im.calls.title')"
    width="720px"
    :close-on-click-modal="false"
    :close-on-press-escape="!actionBusy"
    :show-close="!actionBusy"
    @close="act('leave')"
  >
    <el-alert v-if="error" :title="error" type="warning" :closable="false" />
    <template v-if="current">
      <p>{{ t(`im.calls.mode.${current.mode}`) }} · {{ t(`im.calls.state.${current.state}`) }}</p>
      <p role="status">{{ t(`im.calls.media.${calls.view.media.state}`) }}</p>
      <div v-if="calls.view.media.participants.length" class="im-calls__videos">
        <section
          v-for="person in calls.view.media.participants"
          :key="calls.view.media.connectionId + person.identity"
        >
          <CallVideo
            v-if="person.camera"
            :connection-id="calls.view.media.connectionId"
            :participant-id="person.identity"
          />
          <p>
            {{
              person.name ||
              current.members.find((m) => m.identity === person.identity)?.displayName
            }}
            {{ person.microphone ? '' : t('im.calls.muted') }}
          </p>
        </section>
      </div>
      <p v-else>{{ current.members.map((m) => m.displayName).join(t('im.listSeparator')) }}</p>
      <div class="im-calls__controls">
        <el-button
          :disabled="!connected || calls.controlBusy"
          :loading="calls.controlBusy"
          @click="calls.control('microphone', !calls.view.media.microphone)"
          >{{ t(calls.view.media.microphone ? 'im.calls.mute' : 'im.calls.unmute') }}</el-button
        >
        <el-button
          v-if="current.mode === 'video'"
          :disabled="!connected || calls.controlBusy"
          :loading="calls.controlBusy"
          @click="calls.control('camera', !calls.view.media.camera)"
          >{{ t(calls.view.media.camera ? 'im.calls.cameraOff' : 'im.calls.cameraOn') }}</el-button
        >
        <el-button
          v-if="current.mode === 'video'"
          :disabled="!connected || !calls.view.media.camera || calls.controlBusy"
          :loading="calls.controlBusy"
          @click="calls.control('switch')"
          >{{ t('im.calls.switchCamera') }}</el-button
        >
        <el-button
          v-if="calls.media.audioBlocked"
          :loading="actionBusy"
          :disabled="actionBusy"
          @click="act('audio')"
          >{{ t('im.calls.enableAudio') }}</el-button
        >
        <el-button
          type="danger"
          :loading="actionBusy"
          :disabled="actionBusy"
          @click="act('leave')"
          >{{ t(current.canEnd ? 'im.calls.end' : 'im.calls.leave') }}</el-button
        >
      </div>
    </template>
    <div
      v-for="call in incoming.filter((c) => c.id !== current?.id)"
      :key="call.id"
      class="im-calls__incoming"
    >
      <p>
        {{
          t('im.calls.incoming', {
            name: call.members.find((m) => m.userId === call.callerId)?.displayName ?? '',
            mode: t(`im.calls.mode.${call.mode}`),
          })
        }}
      </p>
      <el-button
        v-if="call.canAccept"
        type="primary"
        :disabled="busy || calls.view.media.state !== 'idle'"
        :loading="busy"
        @click="calls.controller.accept(call)"
        >{{ t('im.calls.accept') }}</el-button
      >
      <el-button
        v-else-if="call.canJoin"
        type="primary"
        :disabled="busy || calls.view.media.state !== 'idle'"
        :loading="busy"
        @click="calls.controller.join(call)"
        >{{ t('im.calls.join') }}</el-button
      >
      <el-button
        v-if="call.canDecline"
        :disabled="busy"
        :loading="busy"
        @click="calls.controller.decline(call)"
        >{{ t('im.calls.decline') }}</el-button
      >
      <el-button
        v-if="call.canEnd"
        type="danger"
        :disabled="busy"
        :loading="busy"
        @click="calls.controller.end(call)"
        >{{ t('im.calls.end') }}</el-button
      >
    </div>
    <el-button
      v-if="calls.view.media.state === 'disconnecting'"
      :loading="actionBusy"
      :disabled="actionBusy"
      @click="act('retry')"
      >{{ t('im.calls.retryCleanup') }}</el-button
    >
  </el-dialog>
</template>
<style scoped>
.im-calls__videos {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.im-calls__videos p {
  margin: 6px 0;
  color: var(--qw-text-2);
}
.im-calls__controls {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
}
.im-calls__incoming {
  padding: 12px 0;
  border-bottom: 1px solid var(--qw-border);
}
</style>
