<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { agentPerms } from '@qiwu/shared'
import { usePerm } from '@/core/permission'
import InstructionPanel from './InstructionPanel.vue'
import PromptList from './PromptList.vue'
import RestrictionTab from './RestrictionTab.vue'
import SkillList from './SkillList.vue'

/**
 * 技能管理：标签页——技能（本人、本租户与平台技能，新增、导入导出、启停）、提示词模板、
 * 说明（个人说明与语气、租户说明），有 `agent.restriction.browse` 时还有“工具限制”（本租户收紧工具）。
 * 各页首次打开时才载入。
 */
defineOptions({ name: 'AgentSkill' })
const { t } = useI18n()
const perm = usePerm()
const tab = ref<'skills' | 'prompts' | 'instructions' | 'restrictions'>('skills')
</script>

<template>
  <div class="qw-page">
    <el-card class="qw-table-panel">
      <el-tabs v-model="tab" class="agent-skill-tabs">
        <el-tab-pane name="skills" :label="t('agent.admin.skill.entity')" lazy>
          <SkillList />
        </el-tab-pane>
        <el-tab-pane name="prompts" :label="t('agent.admin.tab.prompts')" lazy>
          <PromptList />
        </el-tab-pane>
        <el-tab-pane name="instructions" :label="t('agent.admin.tab.instructions')" lazy>
          <InstructionPanel />
        </el-tab-pane>
        <el-tab-pane
          v-if="perm.has(agentPerms.restriction.browse)"
          name="restrictions"
          :label="t('agent.admin.tab.restrictions')"
          lazy
        >
          <RestrictionTab />
        </el-tab-pane>
      </el-tabs>
    </el-card>
  </div>
</template>

<style scoped>
.agent-skill-tabs :deep(.el-tabs__header) {
  padding: 0 16px;
  margin: 0;
}
.agent-skill-tabs :deep(.instruction-panel) {
  padding: 16px;
}
</style>
