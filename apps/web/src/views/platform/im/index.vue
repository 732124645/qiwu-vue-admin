<script setup lang="ts">
import { computed, onActivated, onDeactivated, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { stopImVoice } from '@/core/im/voice'
import { useImStore } from '@/core/im/im-store'
import DirectoryPanel from './components/DirectoryPanel.vue'
import MessagePane from './components/MessagePane.vue'
import RoomList from './components/RoomList.vue'

/**
 * 员工聊天页：左侧会话列表与通讯录，右侧消息面板。全部从本地缓存渲染；通讯录与我的表情在进入本页时才
 * 取（之后带 ETag 复验）。开关关、套餐不含或非员工时显示未启用；会话过期只锁定，不显示缓存。
 */
defineOptions({ name: 'ImChat' })
const { t } = useI18n()
const im = useImStore()
const tab = ref<'chats' | 'directory'>('chats')
const current = ref<number | null>(null)
const room = computed(() => im.rooms.find((r) => r.roomId === current.value) ?? null)

onMounted(() => im.enterChat())
let activated = false
onActivated(() => {
  if (activated) im.enterChat()
  activated = true
})
onDeactivated(() => {
  im.leaveChat()
  stopImVoice()
})
onBeforeUnmount(() => {
  im.leaveChat()
  stopImVoice()
})
// 页面先于探测完成打开：可用后再取通讯录与表情
watch(
  () => im.enabled,
  (on, was) => on && !was && im.enterChat(),
)

function select(roomId: number) {
  tab.value = 'chats'
  current.value = roomId
}
</script>

<template>
  <div class="qw-im-chat">
    <el-empty v-if="im.state === 'disabled'" :description="t('im.disabled')" />
    <el-empty v-else-if="im.state === 'locked'" :description="t('im.locked')" />
    <template v-else>
      <el-alert
        v-if="im.state === 'offline'"
        type="warning"
        :title="t('im.offline')"
        :closable="false"
        show-icon
        class="qw-im-chat__alert"
      />
      <div class="qw-im-chat__layout">
        <aside class="qw-im-chat__side">
          <el-tabs v-model="tab" stretch class="qw-im-chat__tabs">
            <el-tab-pane :label="t('im.tabs.chats')" name="chats">
              <RoomList :current="current" @select="select" />
            </el-tab-pane>
            <el-tab-pane :label="t('im.tabs.directory')" name="directory" lazy>
              <DirectoryPanel @open="select" />
            </el-tab-pane>
          </el-tabs>
        </aside>
        <MessagePane v-if="room" :key="room.roomId" :room="room" @left="current = null" />
        <div v-else class="qw-im-chat__placeholder">
          <el-empty :description="t('im.pane.placeholder')" />
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.qw-im-chat {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: calc(100vh - 140px);
  min-height: 480px;
}
.qw-im-chat__layout {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: var(--qw-surface);
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius-lg);
  box-shadow: var(--qw-shadow-1);
}
.qw-im-chat__side {
  display: flex;
  flex: none;
  flex-direction: column;
  width: 300px;
  min-height: 0;
  padding-top: 4px;
  border-right: 1px solid var(--qw-border);
}
.qw-im-chat__tabs {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}
.qw-im-chat__tabs :deep(.el-tabs__content) {
  flex: 1;
  overflow-y: auto;
}
.qw-im-chat__placeholder {
  display: grid;
  flex: 1;
  place-items: center;
}
</style>
