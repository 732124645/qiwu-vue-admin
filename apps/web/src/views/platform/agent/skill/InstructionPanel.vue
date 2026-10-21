<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import {
  AGENT_SKILL_BODY_MAX,
  AGENT_TONES,
  agentPerms,
  type AgentInstructionSave,
} from '@qiwu/shared'
import { agentInstructionApi } from '@/api/platform/agent-admin'
import { toastRest } from '@/core/composables/use-crud'
import { usePerm } from '@/core/permission'

/**
 * 说明：个人说明与回答语气（每个用户自己的，拼在平台、租户说明之后），以及本租户说明
 * （所有人可见，改要 `agent.instruction.modify`，没有权限时只读）。
 */
defineOptions({ name: 'AgentInstructionPanel' })
const { t } = useI18n()
const perm = usePerm()
const canTenant = computed(() => perm.has(agentPerms.instruction.modify))
const mine = reactive<Required<AgentInstructionSave>>({ body: '', tone: 'default' })
const tenant = ref('')
const loading = ref(false)
/** 正在保存的一块：其保存按钮加载并禁用 */
const saving = ref<'mine' | 'tenant'>()

/** 载入两份说明；一份失败不影响另一份。 */
async function load() {
  loading.value = true
  const [m, tn] = await Promise.allSettled([
    agentInstructionApi.getMine(),
    agentInstructionApi.getTenant(),
  ])
  if (m.status === 'fulfilled')
    Object.assign(mine, { body: m.value.body, tone: m.value.tone ?? 'default' })
  else toastRest(m.reason)
  if (tn.status === 'fulfilled') tenant.value = tn.value.body
  else toastRest(tn.reason)
  loading.value = false
}
void load()

/** 保存个人说明或租户说明；成功提示，失败由请求层提示。 */
async function save(which: 'mine' | 'tenant') {
  if (saving.value) return
  saving.value = which
  try {
    if (which === 'mine') await agentInstructionApi.saveMine({ ...mine })
    else await agentInstructionApi.saveTenant(tenant.value)
    ElMessage.success(t('crud.msg.updated'))
  } catch (e) {
    toastRest(e)
  } finally {
    saving.value = undefined
  }
}
</script>

<template>
  <div v-loading="loading" class="instruction-panel">
    <section class="instruction-panel__block">
      <h3 class="instruction-panel__title">{{ t('agent.admin.instruction.mine') }}</h3>
      <p class="instruction-panel__hint">{{ t('agent.admin.instruction.mineHint') }}</p>
      <el-form label-position="left" @submit.prevent>
        <el-form-item :label="t('field.agent.instruction.tone')">
          <el-select v-model="mine.tone" class="instruction-panel__tone">
            <el-option
              v-for="tone in AGENT_TONES"
              :key="tone"
              :value="tone"
              :label="t(`agent.admin.tone.${tone}`)"
            />
          </el-select>
        </el-form-item>
        <el-form-item :label="t('field.agent.instruction.body')">
          <el-input
            v-model="mine.body"
            class="instruction-panel__mine"
            type="textarea"
            :rows="8"
            :maxlength="AGENT_SKILL_BODY_MAX"
          />
        </el-form-item>
      </el-form>
      <el-button
        type="primary"
        :loading="saving === 'mine'"
        :disabled="saving != null"
        @click="save('mine')"
      >
        {{ t('crud.action.save') }}
      </el-button>
    </section>
    <section class="instruction-panel__block">
      <h3 class="instruction-panel__title">{{ t('agent.admin.instruction.tenant') }}</h3>
      <p class="instruction-panel__hint">{{ t('agent.admin.instruction.tenantHint') }}</p>
      <el-input
        v-model="tenant"
        class="instruction-panel__tenant"
        type="textarea"
        :rows="8"
        :maxlength="AGENT_SKILL_BODY_MAX"
        :readonly="!canTenant"
        :aria-label="t('agent.admin.instruction.tenant')"
      />
      <el-button
        v-if="canTenant"
        class="instruction-panel__save"
        :loading="saving === 'tenant'"
        :disabled="saving != null"
        @click="save('tenant')"
      >
        {{ t('crud.action.save') }}
      </el-button>
    </section>
  </div>
</template>

<style scoped>
.instruction-panel {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  gap: 24px;
}
.instruction-panel__title {
  margin: 0 0 4px;
  font-size: 15px;
  color: var(--qw-text);
}
.instruction-panel__hint {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 18px;
  color: var(--qw-text-3);
}
.instruction-panel__tone {
  width: 200px;
}
.instruction-panel__save {
  margin-top: 12px;
}
</style>
