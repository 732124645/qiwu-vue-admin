<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AgentItemVo } from '@qiwu/shared'
import { Icon } from '@/core/icons'
import { MarkdownText } from './markdown'

/** 子任务归在同一组里，主对话只显示真实状态和摘要；展开详情仍留在主任务。 */
defineOptions({ name: 'AgentSubtaskCard' })
const { item, readonly = false } = defineProps<{
  item: Extract<AgentItemVo, { kind: 'subagent' }>
  readonly?: boolean
}>()
const emit = defineEmits<{ inspect: [id: number] }>()
const { t } = useI18n()
const expanded = ref(true)
const active = computed(
  () =>
    item.payload.tasks.filter((task) => ['queued', 'running', 'waiting'].includes(task.status))
      .length,
)
const finished = computed(() => item.payload.tasks.length - active.value)
const TAG = {
  queued: 'info',
  running: 'primary',
  waiting: 'warning',
  completed: 'success',
  failed: 'danger',
  cancelled: 'info',
} as const
const ICON = {
  queued: 'lucide:clock',
  running: 'lucide:loader-circle',
  waiting: 'lucide:pause',
  completed: 'lucide:circle-check',
  failed: 'lucide:circle-alert',
  cancelled: 'lucide:circle-slash',
} as const
</script>

<template>
  <section class="agent-card agent-subtasks" :aria-label="t('agent.output.subagent.title')">
    <button
      type="button"
      class="agent-subtasks__toggle"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <Icon :icon="expanded ? 'lucide:chevron-down' : 'lucide:chevron-right'" />
      <strong>{{ t('agent.output.subagent.title') }}</strong>
      <span>{{ t('agent.chat.subtask.counts', { active, finished }) }}</span>
    </button>
    <ul v-if="expanded" class="agent-subtasks__list">
      <li v-for="task in item.payload.tasks" :key="task.threadId">
        <button
          type="button"
          class="agent-subtasks__task"
          :disabled="readonly"
          :title="task.title"
          @click="emit('inspect', task.threadId)"
        >
          <Icon :icon="ICON[task.status]" :class="{ 'is-running': task.status === 'running' }" />
          <span class="agent-subtasks__name">{{ task.title }}</span>
          <el-tag size="small" :type="TAG[task.status]">{{
            t(`agent.output.subagent.status.${task.status}`)
          }}</el-tag>
          <Icon v-if="!readonly" icon="lucide:chevron-right" />
        </button>
        <details v-if="task.summary" class="agent-subtasks__summary">
          <summary>{{ t('agent.output.subagent.summary') }}</summary>
          <MarkdownText :text="task.summary" />
        </details>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.agent-subtasks {
  min-width: 0;
}
.agent-subtasks__toggle,
.agent-subtasks__task {
  display: flex;
  width: 100%;
  gap: 8px;
  align-items: center;
  padding: 8px 0;
  font: inherit;
  color: var(--qw-text);
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 0;
}
.agent-subtasks__toggle strong {
  flex: 1;
}
.agent-subtasks__toggle span {
  color: var(--qw-text-3);
  font-size: 12px;
}
.agent-subtasks__list {
  display: grid;
  gap: 4px;
  padding: 0;
  margin: 0;
  list-style: none;
}
.agent-subtasks__task {
  padding: 10px 8px;
  border-radius: var(--qw-radius-sm);
  background: var(--qw-surface-2);
}
.agent-subtasks__task:enabled:hover {
  background: var(--qw-brand-weak);
}
.agent-subtasks__task:disabled {
  cursor: default;
  opacity: 1;
}
.agent-subtasks__task > :not(.agent-subtasks__name),
.agent-subtasks__toggle > svg {
  flex: none;
}
.agent-subtasks__name {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.agent-subtasks__summary {
  padding: 4px 8px;
  overflow-wrap: anywhere;
}
.agent-subtasks__summary summary {
  color: var(--qw-text-3);
  cursor: pointer;
  font-size: 12px;
}
.agent-subtasks__task:focus-visible,
.agent-subtasks__toggle:focus-visible {
  outline: 2px solid var(--qw-brand);
  outline-offset: 2px;
}
</style>
