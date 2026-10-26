<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { agentPerms, type AgentContext } from '@qiwu/shared'
import { useAuthStore } from '@/core/stores/auth'
import { localized } from '@/core/i18n'
import { Icon } from '@/core/icons'
import { useMenuStore } from '@/core/stores/menu'
import { currentAgentContext } from './use-agent-context'
import IconButton from '@/core/components/IconButton.vue'
const AgentChat = defineAsyncComponent(() => import('./index.vue'))

/**
 * 任意页面右侧边缘的“智能助手”入口（贴边的小标签，落在内容区的右侧留白里，不压住分页、底部按钮等内容）：
 * 带着当前页面（路径、标题、路由名与该页公布的选中记录）打开侧边对话。只有菜单里有对话路由（开关打开且有权限）
 * 时才显示；对话页本身不显示；画 BPMN 图的页面也不显示——bpmn.io 的许可要求图上的水印始终可见、不被遮挡。
 */
defineOptions({ name: 'AgentEntry' })
const CHAT = 'agent-chat'
/** 渲染 bpmn-js 画布的页面（按菜单的组件路径）：流程设计器、实例详情的流程图、模型版本的流程图 */
const BPMN_PAGES = new Set([
  'workflow/admin/model-design',
  'workflow/admin/model',
  'workflow/center/detail',
])
const { t } = useI18n()
const route = useRoute()
const auth = useAuthStore()
const opened = ref(false)
const expanded = ref(false)
const entry = ref<HTMLButtonElement>()
const context = shallowRef<AgentContext | null>(null)
const sourceRoute = ref<string | null>(null)
const owner = computed(() => `${auth.me?.user.id ?? 0}:${auth.tenant?.id ?? 0}`)
const menu = useMenuStore()
const shown = computed(
  () =>
    !!auth.me &&
    auth.hasPerm(agentPerms.chat.use) &&
    route.name !== CHAT &&
    !BPMN_PAGES.has(String(route.meta.component ?? '')) &&
    menu.routes.some((r) => r.name === CHAT),
)

watch(
  () => route.fullPath,
  () => {
    opened.value = false
  },
)
watch(shown, (value) => {
  if (!value) {
    opened.value = false
    context.value = null
    sourceRoute.value = null
  }
})
watch(owner, () => {
  opened.value = false
  context.value = null
  sourceRoute.value = null
})

/** 打开时记录来源供新建会话使用；已存在的草稿或会话保留原上下文。 */
function open() {
  context.value = currentAgentContext(
    route.fullPath,
    localized(route.meta.titleI18n, route.meta.title ?? ''),
  )
  sourceRoute.value = typeof route.name === 'string' ? route.name : null
  opened.value = true
}
/** 子控件已消费的按键留在当前操作，不能同时触发宿主抽屉关闭。 */
function keepConsumedKey(event: KeyboardEvent) {
  if (event.defaultPrevented) event.stopPropagation()
}
async function closed() {
  await nextTick()
  if (shown.value) entry.value?.focus()
}
</script>

<template>
  <button
    v-if="shown"
    ref="entry"
    type="button"
    class="agent-entry"
    :aria-label="t('agent.chat.entry')"
    :title="t('agent.chat.entry')"
    :aria-expanded="opened"
    aria-controls="agent-chat-dock"
    @click="open"
  >
    <Icon icon="lucide:sparkles" class="agent-entry__icon" />
  </button>
  <el-drawer
    v-if="shown"
    v-model="opened"
    class="agent-chat-dock"
    :title="t('agent.chat.title')"
    :with-header="false"
    :modal="false"
    modal-penetrable
    append-to-body
    :aria-modal="false"
    :lock-scroll="false"
    :size="expanded ? '100vw' : 'min(980px, 100vw)'"
    @closed="closed"
  >
    <div id="agent-chat-dock" class="agent-dock" @keydown="keepConsumedKey">
      <header class="agent-dock__head">
        <strong>{{ t('agent.chat.title') }}</strong>
        <span>{{ t('agent.chat.dock.currentPage') }}</span>
        <IconButton
          :icon="expanded ? 'lucide:minimize-2' : 'lucide:maximize-2'"
          :label="t(expanded ? 'agent.chat.dock.restore' : 'agent.chat.dock.expand')"
          @click="expanded = !expanded"
        />
        <IconButton icon="lucide:x" :label="t('agent.chat.dock.close')" @click="opened = false" />
      </header>
      <AgentChat
        :key="owner"
        embedded
        :active="opened"
        :entry-context="context"
        :entry-route="sourceRoute"
      />
    </div>
  </el-drawer>
</template>

<style scoped>
.agent-dock {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.agent-dock__head {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  color: var(--qw-text);
}
.agent-dock__head span {
  flex: 1;
  min-width: 0;
  color: var(--qw-text-3);
  font-size: 12px;
}
.agent-dock :deep(.agent-chat) {
  height: 0;
}
/* on the right edge of the viewport, narrower than the main area right padding */
.agent-entry {
  position: fixed;
  top: 50%;
  right: 0;
  z-index: 20;
  display: grid;
  place-items: center;
  width: 22px;
  height: 56px;
  padding: 0;
  color: var(--qw-on-brand);
  cursor: pointer;
  background: var(--qw-brand);
  border: 0;
  border-radius: var(--qw-radius) 0 0 var(--qw-radius);
  box-shadow: var(--qw-shadow-2);
  opacity: 0.85;
  transform: translateY(-50%);
}
.agent-entry:hover,
.agent-entry:focus-visible {
  opacity: 1;
}
.agent-entry:focus-visible {
  outline: 2px solid var(--qw-brand-text);
  outline-offset: 2px;
}
.agent-entry__icon {
  width: 16px;
  height: 16px;
}
@media print {
  .agent-entry {
    display: none;
  }
}
</style>
