<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import {
  AGENT_SEARCH_KINDS,
  agentSearchProviderSave,
  type AgentSearchProviderSave,
} from '@qiwu/shared'
import { agentSearchApi, dropEmpty } from '@/api/platform/agent-admin'
import { useCrudForm } from '@/core/composables/use-crud'

/**
 * 联网搜索提供方的新增 / 编辑表单（`openDialog(SearchForm, { id })`）：类型（博查 / Tavily）、名称、
 * 只写的密钥（留空保留原密钥）、启用、默认。
 */
defineOptions({ name: 'AgentSearchForm' })
const { id } = defineProps<{ id?: number }>()
const emit = defineEmits<{ done: [saved: { id: number }]; cancel: [] }>()
const { t } = useI18n()
const { model, row, formRef, rules, loading, submitting, submit } = useCrudForm({
  api: {
    get: agentSearchApi.get,
    // 密钥只写：空串不发送，服务端保留已保存的密钥
    create: (dto: AgentSearchProviderSave) => agentSearchApi.create(dropEmpty(dto, 'apiKey')),
    update: (sid: number, dto: AgentSearchProviderSave) =>
      agentSearchApi.update(sid, dropEmpty(dto, 'apiKey')),
  },
  schema: agentSearchProviderSave,
  emptyModel: () => ({
    kind: 'bocha' as const,
    name: '',
    apiKey: '',
    enabled: true,
    isDefault: false,
  }),
  id,
  emit,
})
</script>

<template>
  <el-form ref="formRef" v-loading="loading" :model="model" :rules="rules" label-position="left">
    <el-form-item :label="t('field.agent.search.kind')" prop="kind">
      <el-radio-group v-model="model.kind">
        <el-radio v-for="k in AGENT_SEARCH_KINDS" :key="k" :value="k">
          {{ t(`agent.admin.search.kind.${k}`) }}
        </el-radio>
      </el-radio-group>
    </el-form-item>
    <el-form-item :label="t('field.agent.search.name')" prop="name">
      <el-input v-model="model.name" maxlength="64" />
    </el-form-item>
    <el-form-item :label="t('field.agent.search.apiKey')" prop="apiKey">
      <el-input
        v-model="model.apiKey"
        type="password"
        show-password
        autocomplete="new-password"
        maxlength="512"
        :placeholder="row?.hasKey ? t('crud.placeholder.secretKeep') : ''"
      />
      <el-tag v-if="row?.hasKey" class="search-form__stored" size="small" type="success">
        {{ t('agent.admin.keyStored') }}
      </el-tag>
    </el-form-item>
    <el-form-item :label="t('field.agent.search.enabled')" prop="enabled">
      <el-switch v-model="model.enabled" />
    </el-form-item>
    <el-form-item :label="t('field.agent.search.isDefault')" prop="isDefault">
      <el-switch v-model="model.isDefault" />
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
.search-form__stored {
  margin-left: 8px;
}
</style>
