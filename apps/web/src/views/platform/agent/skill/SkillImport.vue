<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, type FormInstance } from 'element-plus'
import { AGENT_SKILL_BODY_MAX, agentSkillImport, type AgentSkillImport } from '@qiwu/shared'
import { agentPlatformSkillApi, agentSkillApi } from '@/api/platform/agent-admin'
import { toastRest } from '@/core/composables/use-crud'
import { zodRules } from '@/core/form/zod-rules'

/**
 * 导入 SKILL.md：选文件（读入文本框）或直接粘贴，都交给服务端解析——租户与个人技能用
 * `POST /agent/skills/import`，平台技能用 `POST /agent/platform-skills/import`。
 */
defineOptions({ name: 'AgentSkillImport' })
const { platform = false, canTenant = false } = defineProps<{
  platform?: boolean
  canTenant?: boolean
}>()
const emit = defineEmits<{ done: [saved: { id: number }]; cancel: [] }>()
const { t } = useI18n()
const model = reactive<AgentSkillImport>({ scope: 'user', text: '' })
const formRef = ref<FormInstance>()
const rules = zodRules(agentSkillImport, useI18n(), model)
const submitting = ref(false)

/** 读入所选文件的文本；同一个文件可以再次选择。 */
async function pick(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) model.text = await file.text()
  input.value = ''
}

/** 校验后导入；成功提示并关闭，失败由请求层提示。 */
async function submit() {
  if (submitting.value) return
  if (!(await formRef.value?.validate().catch(() => false))) return
  let saved: { id: number }
  submitting.value = true
  try {
    saved = platform
      ? await agentPlatformSkillApi.importText({ text: model.text })
      : await agentSkillApi.importText({ ...model })
    ElMessage.success(t('agent.admin.skill.imported'))
    emit('done', { id: saved.id })
  } catch (e) {
    toastRest(e)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-form ref="formRef" :model="model" :rules="rules" label-position="left">
    <el-form-item v-if="!platform" :label="t('field.agent.skill.scope')" prop="scope">
      <el-radio-group v-model="model.scope">
        <el-radio value="user">{{ t('agent.admin.scope.user') }}</el-radio>
        <el-radio value="tenant" :disabled="!canTenant">
          {{ t('agent.admin.scope.tenant') }}
        </el-radio>
      </el-radio-group>
    </el-form-item>
    <el-form-item :label="t('agent.admin.skill.file')">
      <input
        type="file"
        accept=".md,text/markdown,text/plain"
        class="skill-import__file"
        :aria-label="t('agent.admin.skill.file')"
        @change="pick"
      />
    </el-form-item>
    <el-form-item :label="t('field.agent.skill.text')" prop="text">
      <el-input
        v-model="model.text"
        type="textarea"
        :rows="12"
        :maxlength="AGENT_SKILL_BODY_MAX + 2000"
        :placeholder="t('agent.admin.skill.pasteHint')"
      />
    </el-form-item>
  </el-form>
  <div class="qw-dialog-footer">
    <el-button @click="emit('cancel')">{{ t('common.action.cancel') }}</el-button>
    <el-button type="primary" :loading="submitting" @click="submit">
      {{ t('crud.action.import') }}
    </el-button>
  </div>
</template>

<style scoped>
.skill-import__file {
  font-size: 13px;
  color: var(--qw-text-2);
}
</style>
