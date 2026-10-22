<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { type AgentMemorySave, agentMemorySave } from '@qiwu/shared'
import { agentMemoryApi } from '@/api/platform/agent-memory'
import { useCrudForm } from '@/core/composables/use-crud'

/** 一条记忆的新增 / 编辑表单（`openDialog(MemoryForm, { id })`）：只有内容；保存时服务端遮蔽密钥类内容。 */
defineOptions({ name: 'AgentMemoryForm' })
const { id } = defineProps<{ id?: number }>()
const emit = defineEmits<{ done: [saved: AgentMemorySave & { id: number }]; cancel: [] }>()
const { t } = useI18n()
const { model, formRef, rules, loading, submitting, submit } = useCrudForm({
  api: agentMemoryApi,
  schema: agentMemorySave,
  emptyModel: () => ({ content: '' }),
  id,
  emit,
})
</script>

<template>
  <el-form ref="formRef" v-loading="loading" :model="model" :rules="rules" label-position="top">
    <el-form-item :label="t('field.agent.memory.content')" prop="content">
      <el-input
        v-model="model.content"
        type="textarea"
        :rows="4"
        maxlength="1000"
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
