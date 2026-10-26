<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, ref, watch } from 'vue'
import { useDebounceFn } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import { RT, type AgentThreadDetailVo } from '@qiwu/shared'
import { agentApi } from '@/api/platform/agent'
import IconButton from '@/core/components/IconButton.vue'
import { onRealtime, realtimeStatus } from '@/core/realtime/socket'
import ChatItem from './ChatItem.vue'
import { chatRows } from './thread-state'

/** 子任务只读检查器：主会话不换页，不提供子任务的审批或发送入口。 */
defineOptions({ name: 'AgentSubtaskDetail' })
const { parentId, threadId } = defineProps<{ parentId: number; threadId: number }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const detail = shallowRef<AgentThreadDetailVo | null>(null)
const loading = ref(false)
const failed = ref(false)
const rows = computed(() => (detail.value ? chatRows(detail.value.items, detail.value.turn) : []))
let request: AbortController | null = null
let epoch = 0
let alive = true
/** 除服务端本人/租户隔离外，再核对父子关联，迟到应答不能进入另一任务的检查器。 */
async function load() {
  if (!alive) return
  const mine = ++epoch
  request?.abort()
  const controller = new AbortController()
  request = controller
  loading.value = true
  failed.value = false
  try {
    const data = await agentApi.items(threadId, undefined, controller.signal)
    if (!alive || mine !== epoch) return
    if (data.thread.id !== threadId || data.thread.parentThreadId !== parentId) {
      detail.value = null
      failed.value = true
      return
    }
    detail.value = data
  } catch {
    if (alive && mine === epoch && !controller.signal.aborted) failed.value = true
  } finally {
    if (alive && mine === epoch) loading.value = false
  }
}
const refresh = useDebounceFn(load, 200, { maxWait: 1000 })
onRealtime(RT.agentEvent, (event) => {
  if (event.threadId === threadId) void refresh()
})
watch(realtimeStatus, (now, previous) => {
  if (now === 'up' && previous !== 'up') void refresh()
})
watch(
  () => [parentId, threadId],
  () => {
    detail.value = null
    void load()
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  alive = false
  epoch++
  request?.abort()
})
</script>

<template>
  <aside class="agent-child" :aria-label="t('agent.chat.subtask.details')">
    <header class="agent-child__head">
      <IconButton
        icon="lucide:arrow-left"
        :label="t('agent.chat.subtask.back')"
        @click="emit('close')"
      />
      <h3>{{ detail?.thread.title || t('agent.chat.subtask.details') }}</h3>
      <el-tag
        v-if="detail?.turn"
        size="small"
        :type="detail.turn.status === 'failed' ? 'danger' : 'info'"
        >{{ t(`agent.chat.turn.${detail.turn.status}`) }}</el-tag
      >
      <IconButton icon="lucide:x" :label="t('agent.chat.panel.close')" @click="emit('close')" />
    </header>
    <p class="agent-child__hint">{{ t('agent.chat.subtask.readonly') }}</p>
    <div v-loading="loading && !detail" class="agent-child__stream" :aria-busy="loading">
      <el-alert
        v-if="failed"
        :title="t('agent.chat.subtask.failed')"
        type="warning"
        :closable="false"
      />
      <el-button v-if="failed" size="small" :disabled="loading" :loading="loading" @click="load">{{
        t('common.action.retry')
      }}</el-button>
      <ChatItem v-for="row in rows" :key="row.key" :row="row" readonly :can-inspect="false" />
      <p v-if="!loading && !failed && !rows.length" class="agent-card__meta">
        {{ t('agent.chat.subtask.empty') }}
      </p>
    </div>
  </aside>
</template>

<style scoped>
.agent-child {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  flex: 1;
  gap: 8px;
  min-height: 0;
  min-width: 0;
  padding: 12px;
  background: var(--qw-surface);
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius);
}
.agent-child__head {
  display: flex;
  gap: 8px;
  align-items: center;
  flex: none;
}
.agent-child__head h3 {
  flex: 1;
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--qw-text);
  font-size: 14px;
}
.agent-child__head .el-tag {
  flex: none;
}
.agent-child__hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--qw-text-3);
}
.agent-child__stream {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  overflow: auto;
}
</style>
