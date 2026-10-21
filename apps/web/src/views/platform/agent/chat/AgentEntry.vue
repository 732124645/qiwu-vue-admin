<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { localized } from '@/core/i18n'
import { Icon } from '@/core/icons'
import { useMenuStore } from '@/core/stores/menu'
import { currentAgentContext, pendingContext, pendingRoute } from './use-agent-context'

/**
 * 任意页面右侧边缘的“智能助手”入口（贴边的小标签，落在内容区的右侧留白里，不压住分页、底部按钮等内容）：
 * 带着当前页面（路径、标题、路由名与该页公布的选中记录）跳到对话页。只有菜单里有对话页（开关打开且有权限）
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
const router = useRouter()
const menu = useMenuStore()
const shown = computed(
  () =>
    route.name !== CHAT &&
    !BPMN_PAGES.has(String(route.meta.component ?? '')) &&
    menu.routes.some((r) => r.name === CHAT),
)

function open() {
  pendingContext.value = currentAgentContext(
    route.fullPath,
    localized(route.meta.titleI18n, route.meta.title ?? ''),
  )
  pendingRoute.value = typeof route.name === 'string' ? route.name : null
  void router.push({ name: CHAT })
}
</script>

<template>
  <button
    v-if="shown"
    type="button"
    class="agent-entry"
    :aria-label="t('agent.chat.entry')"
    :title="t('agent.chat.entry')"
    @click="open"
  >
    <Icon icon="lucide:sparkles" class="agent-entry__icon" />
  </button>
</template>

<style scoped>
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
