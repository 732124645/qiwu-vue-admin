<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { AGENT_SKILL_BODY_MAX, agentSkillSave } from '@qiwu/shared'
import { agentPlatformSkillApi, agentSkillApi } from '@/api/platform/agent-admin'
import { useCrudForm } from '@/core/composables/use-crud'

/**
 * 技能的新增 / 编辑表单（`openDialog(SkillForm, { id, platform, canTenant })`）：名称、何时使用、正文
 * （右侧实时预览原文，正文只是说明文字，不做 HTML 渲染）、启用。`platform` 时保存到平台技能接口，
 * 不选范围；否则新增时可选个人或本租户（后者要 `agent.skill.create`，由 `canTenant` 决定是否提供）。
 * 允许的工具列表本页不改：新增为不限，编辑时原样保留。
 */
defineOptions({ name: 'AgentSkillForm' })
const {
  id,
  platform = false,
  canTenant = false,
} = defineProps<{
  id?: number
  platform?: boolean
  canTenant?: boolean
}>()
const emit = defineEmits<{ done: [saved: { id: number }]; cancel: [] }>()
const { t } = useI18n()
const { model, formRef, rules, loading, submitting, submit } = useCrudForm({
  api: platform ? agentPlatformSkillApi : agentSkillApi,
  schema: agentSkillSave,
  emptyModel: () => ({
    scope: 'user' as const,
    name: '',
    description: '',
    body: '',
    tools: null,
    enabled: true,
  }),
  id,
  emit,
})
</script>

<template>
  <el-form ref="formRef" v-loading="loading" :model="model" :rules="rules" label-position="top">
    <el-form-item v-if="!platform && id == null" :label="t('field.agent.skill.scope')" prop="scope">
      <el-radio-group v-model="model.scope">
        <el-radio value="user">{{ t('agent.admin.scope.user') }}</el-radio>
        <el-radio value="tenant" :disabled="!canTenant">
          {{ t('agent.admin.scope.tenant') }}
        </el-radio>
      </el-radio-group>
    </el-form-item>
    <el-form-item :label="t('field.agent.skill.name')" prop="name">
      <el-input
        v-model="model.name"
        maxlength="64"
        :placeholder="t('agent.admin.skill.nameHint')"
      />
    </el-form-item>
    <el-form-item :label="t('field.agent.skill.description')" prop="description">
      <el-input
        v-model="model.description"
        type="textarea"
        :rows="2"
        maxlength="512"
        show-word-limit
      />
    </el-form-item>
    <el-form-item :label="t('field.agent.skill.body')" prop="body">
      <div class="skill-form__body">
        <el-input
          v-model="model.body"
          type="textarea"
          :rows="14"
          :maxlength="AGENT_SKILL_BODY_MAX"
          :aria-label="t('field.agent.skill.body')"
        />
        <div class="skill-form__preview" :aria-label="t('agent.admin.skill.preview')">
          <div class="skill-form__preview-head">{{ t('agent.admin.skill.preview') }}</div>
          <div class="skill-form__preview-text">{{ model.body }}</div>
        </div>
      </div>
    </el-form-item>
    <el-form-item :label="t('field.agent.skill.enabled')" prop="enabled">
      <el-switch v-model="model.enabled" />
    </el-form-item>
  </el-form>
  <div class="qw-dialog-footer">
    <el-button @click="emit('cancel')">{{ t('common.action.cancel') }}</el-button>
    <el-button type="primary" :loading="submitting" @click="submit">
      {{ t('crud.action.save') }}
    </el-button>
  </div>
</template>

<style scoped>
.skill-form__body {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  width: 100%;
}
.skill-form__preview {
  min-width: 0;
  padding: 8px 12px;
  overflow: auto;
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius-sm);
  background: var(--qw-surface-2);
  max-height: 320px;
}
.skill-form__preview-head {
  margin-bottom: 4px;
  font-size: 12px;
  color: var(--qw-text-3);
}
.skill-form__preview-text {
  font-size: 13px;
  line-height: 1.6;
  color: var(--qw-text);
  white-space: pre-wrap;
  word-break: break-word;
}
@media (max-width: 640px) {
  .skill-form__body {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
