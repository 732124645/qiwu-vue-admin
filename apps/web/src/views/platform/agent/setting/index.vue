<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import SkillList from '../skill/SkillList.vue'
import McpTab from './McpTab.vue'
import ParamTab from './ParamTab.vue'
import ProviderTab from './ProviderTab.vue'
import SearchTab from './SearchTab.vue'
import ToolTab from './ToolTab.vue'

/**
 * 平台页“智能体设置”：模型、联网搜索、外部 MCP、工具策略、平台技能、说明与限额六个标签，
 * 各标签首次打开时才载入。改动要 `agent.setting.modify`；系统参数（联网模式、说明、限额、暂停）只有 root 能改。
 */
defineOptions({ name: 'AgentSetting' })
const { t } = useI18n()
const tab = ref('providers')
const TABS = [
  ['providers', ProviderTab],
  ['search', SearchTab],
  ['mcp', McpTab],
  ['tools', ToolTab],
  ['skills', SkillList],
  ['params', ParamTab],
] as const
</script>

<template>
  <div class="qw-page">
    <el-card class="qw-table-panel">
      <el-tabs v-model="tab">
        <el-tab-pane
          v-for="[name, component] in TABS"
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
