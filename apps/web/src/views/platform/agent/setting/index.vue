<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/core/stores/auth'
import SkillList from '../skill/SkillList.vue'
import DiagnosticsTab from './DiagnosticsTab.vue'
import McpTab from './McpTab.vue'
import ParamTab from './ParamTab.vue'
import ProviderTab from './ProviderTab.vue'
import SearchTab from './SearchTab.vue'
import SetupGuide from './SetupGuide.vue'
import ToolTab from './ToolTab.vue'

/**
 * 平台页“智能体设置”：顶部“开始使用”引导，下面按管理员配置的先后排列标签——模型服务、联网搜索、工具审批、
 * 外部工具（MCP）、平台技能、使用规则与额度，诊断放最后；各标签首次打开时才载入；诊断只有 root 看得到。改动要 `agent.setting.modify`；系统参数（联网模式、说明、限额、暂停）只有 root 能改。
 */
defineOptions({ name: 'AgentSetting' })
const { t } = useI18n()
const tab = ref('providers')
const TABS = [
  ['providers', ProviderTab],
  ['search', SearchTab],
  ['tools', ToolTab],
  ['mcp', McpTab],
  ['skills', SkillList],
  ['params', ParamTab],
  ['diagnostics', DiagnosticsTab],
] as const
/** 诊断汇总所有租户的轮次，接口只给 root：其他人不显示这个标签 */
const tabs = computed(() =>
  useAuthStore().platformRoot ? TABS : TABS.filter(([name]) => name !== 'diagnostics'),
)
</script>

<template>
  <div class="qw-page">
    <SetupGuide :tab="tab" @open="tab = $event" />
    <el-card class="qw-table-panel">
      <el-tabs v-model="tab" class="agent-setting-tabs">
        <el-tab-pane
          v-for="[name, component] in tabs"
          :key="name"
          :name="name"
          :label="t(`agent.admin.tab.${name}`)"
          lazy
        >
          <component :is="component" :platform="name === 'skills' || undefined" />
        </el-tab-pane>
      </el-tabs>
    </el-card>
  </div>
</template>

<!-- 各标签共用：非 root 只读时的提示 -->
<style>
.agent-setting__hint {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--qw-text-3);
}
</style>

<style scoped>
.agent-setting-tabs :deep(.el-tabs__header) {
  padding: 0 16px;
  margin: 0;
}
.agent-setting-tabs :deep(.param-tab),
.agent-setting-tabs :deep(.agent-diag) {
  padding: 16px;
}
.agent-setting-tabs :deep(.search-tab__web) {
  padding: 16px 16px 0;
}
.agent-setting-tabs :deep(.agent-setting__hint),
.agent-setting-tabs :deep(.skill-list__hint) {
  padding: 16px 16px 0;
  margin-bottom: 0;
}
</style>
