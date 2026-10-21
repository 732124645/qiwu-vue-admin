<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { AGENT_MESSAGE_MAX, agentPromptSave } from '@qiwu/shared'
import { agentPromptApi } from '@/api/platform/agent-admin'
import { useCrudForm } from '@/core/composables/use-crud'

/**
 * 提示词模板的新增 / 编辑表单（`openDialog(PromptForm, { id, canTenant })`）：新增时可选个人或本租户
 * （租户模板要 `agent.skill.modify`，由 `canTenant` 决定是否提供），名称与内容。
 */
defineOptions({ name: 'AgentPromptForm' })
const { id, canTenant = false } = defineProps<{ id?: number; canTenant?: boolean }>()
const emit = defineEmits<{ done: [saved: { id: number }]; cancel: [] }>()
const { t } = useI18n()
const { model, formRef, rules, loading, submitting, submit } = useCrudForm({
  api: agentPromptApi,
  schema: agentPromptSave,
  emptyModel: () => ({ scope: 'user' as const, name: '', body: '' }),
  id,
  emit,
})
</script>

<template>
  <el-form ref="formRef" v-loading="loading" :model="model" :rules="rules" label-position="left">
    <el-form-item v-if="id == null" :label="t('field.agent.prompt.scope')" prop="scope">
      <el-radio-group v-model="model.scope">
        <el-radio value="user">{{ t('agent.admin.scope.user') }}</el-radio>
        <el-radio value="tenant" :disabled="!canTenant">
          {{ t('agent.admin.scope.tenant') }}
        </el-radio>
      </el-radio-group>
    </el-form-item>
    <el-form-item :label="t('field.agent.prompt.name')" prop="name">
      <el-input v-model="model.name" maxlength="64" />
    </el-form-item>
    <el-form-item :label="t('field.agent.prompt.body')" prop="body">
      <el-input
        v-model="model.body"
        type="textarea"
        :rows="8"
        :maxlength="AGENT_MESSAGE_MAX"
        show-word-limit
      />
    </el-form-item>
  </el-form>
  <div class="qw-dialog-footer">
    <el-button @click="emit('cancel')">{{ t('common.action.cancel') }}</el-button>
    <el-button type="primary" :loading="submitting" @click="submit">
      {{ t('crud.action.save') }}
    </el-button>
  </div>
</template>
