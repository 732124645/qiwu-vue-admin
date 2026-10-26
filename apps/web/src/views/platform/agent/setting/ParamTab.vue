<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  agentCreditAmount,
  AGENT_INSTRUCTIONS_PARAM,
  AGENT_LIMIT_PARAMS,
  AGENT_PAUSED_PARAM,
  AGENT_SKILL_BODY_MAX,
  AGENT_TRUST_MODE_PARAM,
} from '@qiwu/shared'
import { useAgentParams } from './use-params'

/**
 * “说明与限额”标签（系统参数，只有 root 能改，其他人只读）：平台说明（拼在每个系统提示最前面）、
 * 每轮与每日限额、是否提供“信任本会话”、紧急暂停（暂停前确认：新的轮次与工具调用立即被拒）。
 */
defineOptions({ name: 'AgentParamTab' })
const { t } = useI18n()
const { isRoot, params, loading, saving, save } = useAgentParams()
const LIMITS = Object.entries(AGENT_LIMIT_PARAMS) as [keyof typeof AGENT_LIMIT_PARAMS, string][]
const instructions = ref('')
/** 限额输入框的值（参数键 → 数字），跟随载入的参数 */
const limits = reactive<Record<string, number | undefined>>({})
const credits = reactive<Record<string, string>>({})
const isCredits = (name: string) => name.endsWith('Credits')
watch(params, (p) => {
  instructions.value = p[AGENT_INSTRUCTIONS_PARAM]?.paramValue ?? ''
  for (const [name, key] of LIMITS) {
    if (isCredits(name)) {
      credits[key] = p[key]?.paramValue ?? ''
      continue
    }
    const v = Number(p[key]?.paramValue)
    limits[key] = Number.isFinite(v) ? v : undefined
  }
})
const on = (key: string) => params.value[key]?.paramValue === 'true'

/** 保存全部限额（只发改过的）。空的输入框不保存。 */
function saveLimits() {
  if (
    Object.values(credits).some(
      (value) => value !== '' && !agentCreditAmount.safeParse(value).success,
    )
  ) {
    ElMessage.error(t('agent.admin.param.creditInvalid'))
    return
  }
  const values = Object.fromEntries(
    LIMITS.flatMap(([name, key]) => {
      const value = isCredits(name) ? credits[key] : limits[key]
      return value == null || value === '' ? [] : [[key, String(value)]]
    }),
  )
  return save(values, 'limits')
}

/** 紧急暂停：打开前确认（立即拒绝新的轮次与工具调用），恢复不需确认。 */
async function setPaused(paused: boolean) {
  if (paused) {
    try {
      await ElMessageBox.confirm(t('agent.admin.param.pauseConfirm'), t('crud.confirm.title'), {
        type: 'warning',
        cancelButtonText: t('common.action.cancel'),
      })
    } catch {
      return
    }
  }
  await save({ [AGENT_PAUSED_PARAM]: String(paused) })
}
</script>

<template>
  <div v-loading="loading" class="param-tab">
    <p v-if="!isRoot" class="param-tab__hint">{{ t('agent.admin.rootOnly') }}</p>
    <el-form label-position="top" @submit.prevent>
      <el-form-item :label="t('agent.admin.param.paused')">
        <el-switch
          class="param-tab__paused"
          :model-value="on(AGENT_PAUSED_PARAM)"
          :disabled="!isRoot || saving != null"
          :loading="saving === AGENT_PAUSED_PARAM"
          :aria-label="t('agent.admin.param.paused')"
          @change="setPaused($event as boolean)"
        />
        <span class="param-tab__note">{{ t('agent.admin.param.pausedHint') }}</span>
      </el-form-item>
      <el-form-item :label="t('agent.admin.param.trustMode')">
        <el-switch
          class="param-tab__trust"
          :model-value="on(AGENT_TRUST_MODE_PARAM)"
          :disabled="!isRoot || saving != null"
          :loading="saving === AGENT_TRUST_MODE_PARAM"
          :aria-label="t('agent.admin.param.trustMode')"
          @change="save({ [AGENT_TRUST_MODE_PARAM]: String($event) })"
        />
        <span class="param-tab__note">{{ t('agent.admin.param.trustModeHint') }}</span>
      </el-form-item>
    </el-form>

    <h3 class="param-tab__title">{{ t('agent.admin.param.instructions') }}</h3>
    <p class="param-tab__hint">{{ t('agent.admin.param.instructionsHint') }}</p>
    <el-input
      v-model="instructions"
      class="param-tab__instructions"
      type="textarea"
      :rows="8"
      :maxlength="AGENT_SKILL_BODY_MAX"
      :readonly="!isRoot"
      :aria-label="t('agent.admin.param.instructions')"
    />
    <el-button
      v-if="isRoot"
      class="param-tab__save param-tab__save-instructions"
      :loading="saving === AGENT_INSTRUCTIONS_PARAM"
      :disabled="saving != null"
      @click="save({ [AGENT_INSTRUCTIONS_PARAM]: instructions })"
    >
      {{ t('crud.action.save') }}
    </el-button>

    <h3 class="param-tab__title">{{ t('agent.admin.param.limits') }}</h3>
    <p class="param-tab__hint">{{ t('agent.admin.param.creditsHint') }}</p>
    <el-form label-position="top" class="param-tab__limits" @submit.prevent>
      <el-form-item
        v-for="[name, key] in LIMITS"
        :key="key"
        :label="t(`agent.admin.limit.${name}`)"
      >
        <el-input
          v-if="isCredits(name)"
          v-model="credits[key]"
          inputmode="decimal"
          maxlength="19"
          :disabled="!isRoot || saving != null"
          :aria-label="t(`agent.admin.limit.${name}`)"
        />
        <el-input-number
          v-else
          v-model="limits[key]"
          :min="1"
          :step="1"
          :precision="0"
          :disabled="!isRoot || saving != null"
          controls-position="right"
          :aria-label="t(`agent.admin.limit.${name}`)"
        />
      </el-form-item>
    </el-form>
    <el-button
      v-if="isRoot"
      class="param-tab__save param-tab__save-limits"
      :loading="saving === 'limits'"
      :disabled="saving != null"
      @click="saveLimits"
    >
      {{ t('crud.action.save') }}
    </el-button>
  </div>
</template>

<style scoped>
.param-tab {
  max-width: 760px;
}
.param-tab__limits {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
  column-gap: 24px;
}
.param-tab__title {
  margin: 24px 0 4px;
  font-size: 15px;
  color: var(--qw-text);
}
.param-tab__hint {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 18px;
  color: var(--qw-text-3);
}
.param-tab__note {
  margin-left: 12px;
  font-size: 12px;
  color: var(--qw-text-3);
}
.param-tab__save {
  margin-top: 12px;
}
</style>
