<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { FormItemRule } from 'element-plus'
import { agentProviderSave, type AgentProviderSave } from '@qiwu/shared'
import { agentProviderApi, dropEmpty } from '@/api/platform/agent-admin'
import QwEditTable from '@/core/components/QwEditTable.vue'
import { useCrudForm } from '@/core/composables/use-crud'
import { zodRules } from '@/core/form/zod-rules'

/**
 * 模型提供方的新增 / 编辑表单（`openDialog(ProviderForm, { id })`）：名称、兼容 OpenAI 的接口地址、
 * 只写的密钥（已保存时显示“已保存”，留空则保留原密钥，从不读回）、模型清单（每行模型 id、显示名、
 * 推理强度、看图、快速档、上下文窗口）、启用、默认。
 */
defineOptions({ name: 'AgentProviderForm' })
type Model = AgentProviderSave['models'][number]
const { id } = defineProps<{ id?: number }>()
const emit = defineEmits<{ done: [saved: { id: number }]; cancel: [] }>()
const { t } = useI18n()
const newModel = (): Model => ({
  id: '',
  label: '',
  reasoning: false,
  vision: false,
  fast: false,
  contextWindow: 64_000,
})
const { model, row, formRef, rules, loading, submitting, submit } = useCrudForm({
  api: {
    get: agentProviderApi.get,
    // 密钥只写：空串不发送，服务端保留已保存的密钥
    create: (dto: AgentProviderSave) => agentProviderApi.create(dropEmpty(dto, 'apiKey')),
    update: (pid: number, dto: AgentProviderSave) =>
      agentProviderApi.update(pid, dropEmpty(dto, 'apiKey')),
  },
  schema: agentProviderSave,
  emptyModel: () => ({
    name: '',
    baseUrl: '',
    apiKey: '',
    models: [newModel()],
    enabled: true,
    isDefault: false,
    sort: 0,
  }),
  id,
  emit,
})
// 每个模型行的单元格按行 schema 的对应字段校验；整张清单只查“至少一个模型”，
// 不再用整表规则（那会把各行的错误在清单下方重复一遍）
delete rules.models
const modelsRule: FormItemRule = {
  validator: (_r, value: Model[], cb) =>
    value.length ? cb() : cb(new Error(t('agent.admin.model.required'))),
}
const modelRules = zodRules(agentProviderSave.shape.models.element, useI18n())
const modelColumns = [
  { prop: 'id', label: 'agent.admin.model.id', minWidth: 160, required: true },
  { prop: 'label', label: 'agent.admin.model.label', minWidth: 120 },
  { prop: 'reasoning', label: 'agent.admin.model.reasoning', width: 80 },
  { prop: 'vision', label: 'agent.admin.model.vision', width: 80 },
  { prop: 'fast', label: 'agent.admin.model.fast', width: 80 },
  { prop: 'contextWindow', label: 'agent.admin.model.contextWindow', width: 170 },
]
</script>

<template>
  <el-form ref="formRef" v-loading="loading" :model="model" :rules="rules" label-position="left">
    <el-form-item :label="t('field.agent.provider.name')" prop="name">
      <el-input v-model="model.name" maxlength="64" />
    </el-form-item>
    <el-form-item :label="t('field.agent.provider.baseUrl')" prop="baseUrl">
      <el-input v-model="model.baseUrl" maxlength="512" placeholder="https://api.example.com/v1" />
    </el-form-item>
    <el-form-item :label="t('field.agent.provider.apiKey')" prop="apiKey">
      <el-input
        v-model="model.apiKey"
        type="password"
        show-password
        autocomplete="new-password"
        maxlength="512"
        :placeholder="row?.hasKey ? t('crud.placeholder.secretKeep') : ''"
      />
      <el-tag v-if="row?.hasKey" class="provider-form__stored" size="small" type="success">
        {{ t('agent.admin.keyStored') }}
      </el-tag>
    </el-form-item>
    <QwEditTable
      v-model="model.models"
      label="field.agent.provider.models"
      :columns="modelColumns"
      :create="newModel"
    >
      <template #cell-id="{ row: m, index }">
        <el-form-item :prop="`models.${index}.id`" :rules="modelRules.id">
          <el-input v-model="m.id" maxlength="128" :aria-label="t('agent.admin.model.id')" />
        </el-form-item>
      </template>
      <template #cell-label="{ row: m, index }">
        <el-form-item :prop="`models.${index}.label`" :rules="modelRules.label">
          <el-input v-model="m.label" maxlength="128" :aria-label="t('agent.admin.model.label')" />
        </el-form-item>
      </template>
      <template #cell-reasoning="{ row: m }">
        <el-checkbox v-model="m.reasoning" :aria-label="t('agent.admin.model.reasoning')" />
      </template>
      <template #cell-vision="{ row: m }">
        <el-checkbox v-model="m.vision" :aria-label="t('agent.admin.model.vision')" />
      </template>
      <template #cell-fast="{ row: m }">
        <el-checkbox v-model="m.fast" :aria-label="t('agent.admin.model.fast')" />
      </template>
      <template #cell-contextWindow="{ row: m, index }">
        <el-form-item :prop="`models.${index}.contextWindow`" :rules="modelRules.contextWindow">
          <el-input-number
            v-model="m.contextWindow"
            :min="1024"
            :max="10_000_000"
            :step="1024"
            controls-position="right"
            :aria-label="t('agent.admin.model.contextWindow')"
          />
        </el-form-item>
      </template>
    </QwEditTable>
    <!-- the list itself (at least one model) reports here -->
    <el-form-item class="provider-form__models" prop="models" :rules="modelsRule" />
    <el-form-item :label="t('field.agent.provider.enabled')" prop="enabled">
      <el-switch v-model="model.enabled" />
    </el-form-item>
    <el-form-item :label="t('field.agent.provider.isDefault')" prop="isDefault">
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
.provider-form__stored {
  margin-left: 8px;
}
</style>
