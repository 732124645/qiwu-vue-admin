<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AgentItemVo, AgentTurnVo } from '@qiwu/shared'
import IconButton from '@/core/components/IconButton.vue'
import { toolTitle } from '../tool-presentation'
import { MarkdownText } from './markdown'
import OutputCard from './OutputCard.vue'
import SubtaskCard from './SubtaskCard.vue'
import { chatRows } from './thread-state'

type PreviewItem = Extract<AgentItemVo, { kind: 'assistant' | 'chart' | 'image' | 'report' }>
/** 仅阅读当前已加载的会话数据；审批、取数权限与文件访问仍由原对话和产物组件处理。 */
defineOptions({ name: 'AgentContextPanel' })
const {
  items,
  turn = null,
  selectedId = null,
  readonly = false,
  inMain = false,
} = defineProps<{
  items: AgentItemVo[]
  turn?: AgentTurnVo | null
  selectedId?: number | null
  readonly?: boolean
  /** 正在主区域（对话区位置）显示，而不是右侧栏 */
  inMain?: boolean
}>()
const emit = defineEmits<{
  close: []
  select: [id: number]
  inspectChild: [id: number]
  toggleMain: []
}>()
const { t } = useI18n()
const tab = ref('tasks')
const plan = computed(
  () => items.filter((item) => item.kind === 'plan').sort((a, b) => b.seq - a.seq)[0],
)
const tools = computed(() => chatRows(items, turn).filter((row) => row.kind === 'tool'))
const subtasks = computed(() => items.filter((item) => item.kind === 'subagent'))
const outputs = computed(() =>
  items.filter((item) => item.kind === 'chart' || item.kind === 'image' || item.kind === 'report'),
)
const selected = computed(() =>
  items.find(
    (item): item is PreviewItem =>
      item.id === selectedId && ['assistant', 'chart', 'image', 'report'].includes(item.kind),
  ),
)
watch(
  () => selectedId,
  (id) => {
    if (id != null) tab.value = 'outputs'
  },
  { immediate: true },
)

/** 先拒绝控制字符和带凭据的地址，再解析协议；不请求图标或网页元数据。 */
const sources = computed(() => {
  const found = new Map<string, { url: string; title: string; host: string }>()
  for (const item of items) {
    if (item.kind !== 'assistant' && item.kind !== 'report') continue
    for (const source of item.payload.citations ?? []) {
      if (
        typeof source.url !== 'string' ||
        Array.from(source.url).some((character) => {
          const code = character.charCodeAt(0)
          return code < 32 || (code >= 127 && code <= 159)
        })
      )
        continue
      try {
        const url = new URL(source.url)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue
        if (!found.has(url.href))
          found.set(url.href, {
            url: url.href,
            title: source.title || url.hostname,
            host: url.hostname,
          })
      } catch {
        /* 非绝对网页地址不作为可打开来源。 */
      }
    }
  }
  return [...found.values()]
})

/** 工具状态只作摘要，不复制审批或执行按钮。 */
function toolState(row: (typeof tools.value)[number]) {
  if (row.result) return row.result.payload.ok ? 'done' : 'failed'
  if (row.stopped) return 'stopped'
  const waiting = items.some(
    (item) =>
      item.kind === 'approval' &&
      item.payload.callId === row.call.payload.callId &&
      !item.payload.decision &&
      ['pending', 'running'].includes(item.status ?? ''),
  )
  return waiting ? 'waiting' : 'running'
}
function outputTitle(item: PreviewItem) {
  if (item.kind === 'assistant') return t('agent.chat.panel.answer', { n: item.seq })
  if (item.kind === 'image') return item.payload.prompt || t('agent.output.image.title')
  return item.payload.title || t('agent.output.chart.title')
}
</script>

<template>
  <aside id="agent-work-panel" class="agent-context" :aria-label="t('agent.chat.panel.open')">
    <header class="agent-context__head">
      <h3>{{ t('agent.chat.panel.open') }}</h3>
      <span class="agent-context__spacer" />
      <IconButton
        :icon="inMain ? 'lucide:panel-right' : 'lucide:maximize-2'"
        :label="t(inMain ? 'agent.chat.panel.toSide' : 'agent.chat.panel.toMain')"
        @click="emit('toggleMain')"
      />
      <IconButton
        icon="lucide:panel-right-close"
        :label="t('agent.chat.panel.close')"
        @click="emit('close')"
      />
    </header>
    <p class="agent-context__scope">{{ t('agent.chat.panel.scope') }}</p>
    <el-tabs v-model="tab" class="agent-context__tabs">
      <el-tab-pane name="tasks" :label="t('agent.chat.panel.tasks')">
        <SubtaskCard
          v-for="item in subtasks"
          :key="item.id"
          :item
          :readonly
          @inspect="emit('inspectChild', $event)"
        />
        <h4>{{ t('agent.chat.plan') }}</h4>
        <ol v-if="plan" class="agent-context__plan">
          <li v-for="(step, index) in plan.payload.steps" :key="index">
            <span>{{ step.text }}</span>
            <el-tag
              size="small"
              :type="
                step.status === 'done' ? 'success' : step.status === 'doing' ? 'primary' : 'info'
              "
              >{{ t(`agent.chat.planStatus.${step.status}`) }}</el-tag
            >
          </li>
        </ol>
        <p v-else class="agent-card__meta">{{ t('agent.chat.panel.noPlan') }}</p>
        <h4>{{ t('agent.chat.panel.tools') }}</h4>
        <ul v-if="tools.length" class="agent-context__tools">
          <li v-for="row in tools" :key="row.key">
            <span>{{ toolTitle(row.call.payload.tool, row.call.payload.title) }}</span>
            <el-tag
              size="small"
              :type="
                toolState(row) === 'failed'
                  ? 'danger'
                  : toolState(row) === 'waiting'
                    ? 'warning'
                    : 'info'
              "
              >{{
                t(
                  toolState(row) === 'waiting'
                    ? 'agent.chat.turn.waiting'
                    : `agent.chat.tool.${toolState(row)}`,
                )
              }}</el-tag
            >
          </li>
        </ul>
        <p v-else class="agent-card__meta">{{ t('agent.chat.panel.noTools') }}</p>
      </el-tab-pane>
      <el-tab-pane name="sources" :label="t('agent.chat.panel.sources')">
        <ul v-if="sources.length" class="agent-context__sources">
          <li v-for="source in sources" :key="source.url">
            <a :href="source.url" target="_blank" rel="noopener noreferrer">{{ source.title }}</a>
            <small>{{ source.host }}</small>
          </li>
        </ul>
        <p v-else class="agent-card__meta">{{ t('agent.chat.panel.noSources') }}</p>
      </el-tab-pane>
      <el-tab-pane name="outputs" :label="t('agent.chat.panel.outputs')">
        <ul v-if="outputs.length" class="agent-context__outputs">
          <li v-for="item in outputs" :key="item.id">
            <button
              type="button"
              :aria-pressed="selectedId === item.id"
              @click="emit('select', item.id)"
            >
              {{ outputTitle(item) }}
            </button>
          </li>
        </ul>
        <p v-else-if="!selected" class="agent-card__meta">{{ t('agent.chat.panel.noOutputs') }}</p>
        <section
          v-if="tab === 'outputs' && selected"
          class="agent-context__preview"
          :data-item-id="selected.id"
          :aria-label="t('agent.chat.panel.reading')"
        >
          <h4>{{ outputTitle(selected) }}</h4>
          <MarkdownText v-if="selected.kind === 'assistant'" :text="selected.payload.text" />
          <OutputCard v-else :key="selected.id" :item="selected" :readonly />
        </section>
        <p v-else-if="outputs.length" class="agent-card__meta">
          {{ t('agent.chat.panel.chooseOutput') }}
        </p>
      </el-tab-pane>
    </el-tabs>
  </aside>
</template>

<style scoped>
.agent-context {
  box-sizing: border-box;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  padding: 12px;
  overflow: hidden;
  background: var(--qw-surface);
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius);
  box-shadow: var(--qw-shadow-1);
}
.agent-context__head {
  display: flex;
  flex: none;
  gap: 8px;
  align-items: center;
}
.agent-context__spacer {
  flex: 1;
}
.agent-context__head h3 {
  margin: 0;
  font-size: 14px;
  color: var(--qw-text);
}
.agent-context__scope {
  flex: none;
  margin: 8px 0;
  color: var(--qw-text-3);
  font-size: 12px;
  line-height: 1.5;
}
.agent-context__tabs {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}
.agent-context__tabs :deep(.el-tabs__header) {
  flex: none;
  margin-bottom: 0;
}
.agent-context__tabs :deep(.el-tabs__content) {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
}
.agent-context h4 {
  margin: 12px 0 8px;
  color: var(--qw-text);
  font-size: 13px;
}
.agent-context__plan,
.agent-context__tools,
.agent-context__sources,
.agent-context__outputs {
  padding: 0;
  margin: 8px 0;
  list-style: none;
}
.agent-context__plan li,
.agent-context__tools li {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  justify-content: space-between;
  margin: 8px 0;
}
.agent-context__plan span,
.agent-context__tools span {
  min-width: 0;
  overflow-wrap: anywhere;
}
.agent-context__plan .el-tag,
.agent-context__tools .el-tag {
  flex: none;
}
.agent-context__sources li {
  margin: 12px 0;
  overflow-wrap: anywhere;
}
.agent-context__sources a {
  color: var(--qw-brand-text);
}
.agent-context__sources small {
  display: block;
  margin-top: 4px;
  color: var(--qw-text-3);
}
.agent-context__outputs button {
  width: 100%;
  padding: 8px;
  font: inherit;
  color: var(--qw-text);
  text-align: left;
  overflow-wrap: anywhere;
  cursor: pointer;
  background: var(--qw-surface);
  border: 0;
  border-radius: var(--qw-radius-sm);
}
.agent-context__outputs button:hover,
.agent-context__outputs button[aria-pressed='true'] {
  background: var(--qw-brand-weak);
}
.agent-context__preview {
  min-width: 0;
}
</style>
