<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  AGENT_REASONING,
  AGENT_SKILL_BODY_MAX,
  type AgentOptionsVo,
  type AgentProfileSave,
  agentProfileSave,
} from '@qiwu/shared'
import { agentProfileApi } from '@/api/platform/agent-memory'
import { useCrudForm } from '@/core/composables/use-crud'

/**
 * 配置方案的新增 / 编辑表单（`openDialog(ProfileForm, { id, canTenant, options })`）：范围（新增时；全租户
 * 共用要 `agent.skill.modify`，由 `canTenant` 决定）、名称、模型（空为平台默认）、推理强度、审批模式（只列
 * 平台此刻提供的）、允许的工具（每行一个，空为不限）、额外说明、是否默认。
 */
defineOptions({ name: 'AgentProfileForm' })
const {
  id,
  canTenant = false,
  options = null,
} = defineProps<{ id?: number; canTenant?: boolean; options?: AgentOptionsVo | null }>()
const emit = defineEmits<{ done: [saved: AgentProfileSave & { id: number }]; cancel: [] }>()
const { t } = useI18n()
const { model, formRef, rules, loading, submitting, submit } = useCrudForm({
  api: agentProfileApi,
  schema: agentProfileSave,
  emptyModel: (): AgentProfileSave => ({
    scope: 'user',
    name: '',
    providerId: null,
    model: null,
    reasoning: null,
    approvalMode: 'ask',
    tools: null,
    instructions: null,
    isDefault: false,
  }),
  id,
  emit,
})

/** 提供方与模型合成一个选项值 `<提供方>:<模型>`；空串为平台默认。 */
const modelKey = computed({
  get: () => (model.providerId != null && model.model ? `${model.providerId}:${model.model}` : ''),
  set: (v: string) => {
    const at = v.indexOf(':')
    model.providerId = at > 0 ? Number(v.slice(0, at)) : null
    model.model = at > 0 ? v.slice(at + 1) : null
    if (!reasoningModel.value) model.reasoning = null
  },
})
const reasoningModel = computed(
  () =>
    options?.providers
      .find((p) => p.id === model.providerId)
      ?.models.find((m) => m.id === model.model)?.reasoning ?? false,
)
/** 工具清单在文本框里每行一个；全空为不限（null）。 */
const toolsText = computed({
  get: () => (model.tools ?? []).join('\n'),
  set: (v: string) => {
    const names = v
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    model.tools = names.length ? names : null
  },
})
const instructions = computed({
  get: () => model.instructions ?? '',
  set: (v: string) => (model.instructions = v.trim() ? v : null),
})
</script>

<template>
  <el-form ref="formRef" v-loading="loading" :model="model" :rules="rules" label-position="left">
    <el-form-item v-if="id == null" :label="t('field.agent.profile.scope')" prop="scope">
      <el-radio-group v-model="model.scope">
        <el-radio value="user">{{ t('agent.admin.scope.user') }}</el-radio>
        <el-radio value="tenant" :disabled="!canTenant">
          {{ t('agent.admin.scope.tenant') }}
        </el-radio>
      </el-radio-group>
    </el-form-item>
    <el-form-item :label="t('field.agent.profile.name')" prop="name">
      <el-input v-model="model.name" maxlength="64" />
    </el-form-item>
    <el-form-item :label="t('field.agent.profile.model')" prop="model">
      <el-select v-model="modelKey" :aria-label="t('field.agent.profile.model')">
        <el-option value="" :label="t('agent.profile.modelDefault')" />
        <el-option-group v-for="p in options?.providers ?? []" :key="p.id" :label="p.name">
          <el-option
            v-for="m in p.models"
            :key="m.id"
            :value="`${p.id}:${m.id}`"
            :label="m.label"
          />
        </el-option-group>
      </el-select>
    </el-form-item>
    <el-form-item
      v-if="reasoningModel"
      :label="t('field.agent.profile.reasoning')"
      prop="reasoning"
    >
      <el-select
        v-model="model.reasoning"
        clearable
        :aria-label="t('field.agent.profile.reasoning')"
      >
        <el-option
          v-for="r in AGENT_REASONING"
          :key="r"
          :value="r"
          :label="t(`agent.chat.reasoning.${r}`)"
        />
      </el-select>
    </el-form-item>
    <el-form-item :label="t('field.agent.profile.approvalMode')" prop="approvalMode">
      <el-select v-model="model.approvalMode" :aria-label="t('field.agent.profile.approvalMode')">
        <el-option
          v-for="m in options?.approvalModes ?? ['ask']"
          :key="m"
          :value="m"
          :label="t(`agent.chat.mode.${m}`)"
        />
      </el-select>
    </el-form-item>
    <el-form-item :label="t('field.agent.profile.tools')" prop="tools">
      <el-input
        v-model="toolsText"
        type="textarea"
        :rows="3"
        :placeholder="t('agent.profile.toolsAll')"
      />
      <p class="agent-profile-form__hint">{{ t('agent.profile.toolsHint') }}</p>
    </el-form-item>
    <el-form-item :label="t('field.agent.profile.instructions')" prop="instructions">
      <el-input
        v-model="instructions"
        type="textarea"
        :rows="5"
        :maxlength="AGENT_SKILL_BODY_MAX"
        show-word-limit
      />
    </el-form-item>
    <el-form-item :label="t('field.agent.profile.isDefault')" prop="isDefault">
      <el-switch v-model="model.isDefault" :aria-label="t('field.agent.profile.isDefault')" />
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
.agent-profile-form__hint {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--qw-text-3);
}
</style>
