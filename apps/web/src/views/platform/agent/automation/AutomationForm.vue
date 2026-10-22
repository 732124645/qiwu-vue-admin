<script setup lang="ts">
import { computed, onMounted, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  AGENT_AUTOMATION_CRON_PRESETS,
  AGENT_MESSAGE_MAX,
  type AgentAutomationEventVo,
  type AgentAutomationToolVo,
  agentAutomationSave,
} from '@qiwu/shared'
import { agentAutomationApi } from '@/api/platform/agent-automation'
import { useCrudForm } from '@/core/composables/use-crud'

/**
 * 自动化的新增 / 编辑表单（`openDialog(AutomationForm, { id, canShare })`）：名称、触发方式（定时：常用
 * 预设或 5 段 cron 加时区；业务事件：本人能浏览的操作；手动）、技能或提示词、配置方案、写入模式（只读、
 * 询问、预先同意：逐个勾选允许的写入工具，加入新工具要输入当前密码；配置了审查模型时
 * 还有自动审查）、通知方式、启用与共享。
 */
defineOptions({ name: 'AgentAutomationForm' })
const { id, canShare = false } = defineProps<{ id?: number; canShare?: boolean }>()
const emit = defineEmits<{ done: [saved: { id: number }]; cancel: [] }>()
const { t } = useI18n()
const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const { model, row, formRef, rules, loading, submitting, submit } = useCrudForm({
  api: agentAutomationApi,
  schema: agentAutomationSave,
  emptyModel: () => ({
    name: '',
    enabled: true,
    shared: false,
    trigger: 'schedule' as const,
    cron: AGENT_AUTOMATION_CRON_PRESETS[2].cron as string | null,
    timezone: browserZone as string | null,
    event: null as { domain: string; verb: string } | null,
    skill: null as string | null,
    prompt: '' as string | null,
    profileId: null as number | null,
    writeMode: 'read_only' as const,
    preApproved: [] as string[],
    currentPassword: undefined as string | undefined,
    notify: { inbox: true, mail: false },
  }),
  id,
  emit,
})

const events = shallowRef<AgentAutomationEventVo[]>([])
const tools = shallowRef<AgentAutomationToolVo[]>([])
const skills = shallowRef<{ name: string; description: string }[]>([])
const profiles = shallowRef<{ id: number; name: string }[]>([])
/** 平台配置了审查模型（选项接口的审批模式含 `auto_review`）时才提供“自动审查”。 */
const autoReview = shallowRef(false)
/** 选项各自载入，一个失败不影响其他（失败时那一项为空）。 */
onMounted(() => {
  void agentAutomationApi.events().then(
    (v) => (events.value = v),
    () => undefined,
  )
  void agentAutomationApi.tools().then(
    (v) => (tools.value = v),
    () => undefined,
  )
  void agentAutomationApi.options().then(
    (v) => {
      skills.value = v.skills
      autoReview.value = v.approvalModes?.includes('auto_review') ?? false
    },
    () => undefined,
  )
  void agentAutomationApi.profiles().then((v) => (profiles.value = v))
})

/** 当前 cron 对应的预设（没有对应的就是“自定义”）。 */
const preset = computed({
  get: () => AGENT_AUTOMATION_CRON_PRESETS.find((p) => p.cron === model.cron)?.id ?? 'custom',
  set: (v: string) => {
    const p = AGENT_AUTOMATION_CRON_PRESETS.find((x) => x.id === v)
    if (p) model.cron = p.cron
  },
})
/** 事件下拉的值：`领域 动作`。 */
const eventKey = computed({
  get: () => (model.event ? `${model.event.domain} ${model.event.verb}` : ''),
  set: (v: string) => {
    const e = events.value.find((x) => `${x.domain} ${x.verb}` === v)
    model.event = e ? { domain: e.domain, verb: e.verb } : null
  },
})
/** 已失效的预先同意（服务端判断），在勾选清单里标出来。 */
const stale = computed(() => new Set(row.value?.stalePreApproved ?? []))
/** 清单里加入了原先没有同意过的工具：要输入当前密码。 */
const needsPassword = computed(() => {
  if (model.writeMode !== 'pre_approved') return false
  const before = new Set(row.value?.preApproved ?? [])
  return model.preApproved.some((x) => !before.has(x))
})
/** 密码框：清空即不发送。 */
const password = computed({
  get: () => model.currentPassword ?? '',
  set: (v: string) => (model.currentPassword = v || undefined),
})
</script>

<template>
  <el-form
    ref="formRef"
    v-loading="loading"
    :model="model"
    :rules="rules"
    label-position="left"
    label-width="120px"
  >
    <el-form-item :label="t('field.agent.automation.name')" prop="name">
      <el-input v-model="model.name" maxlength="100" />
    </el-form-item>
    <el-form-item :label="t('field.agent.automation.trigger')" prop="trigger">
      <el-radio-group v-model="model.trigger">
        <el-radio value="schedule">{{ t('agent.automation.trigger.schedule') }}</el-radio>
        <el-radio value="event">{{ t('agent.automation.trigger.event') }}</el-radio>
        <el-radio value="manual">{{ t('agent.automation.trigger.manual') }}</el-radio>
      </el-radio-group>
    </el-form-item>
    <template v-if="model.trigger === 'schedule'">
      <el-form-item :label="t('agent.automation.preset.label')">
        <el-select v-model="preset" :aria-label="t('agent.automation.preset.label')">
          <el-option
            v-for="p in AGENT_AUTOMATION_CRON_PRESETS"
            :key="p.id"
            :value="p.id"
            :label="t(`agent.automation.preset.${p.id}`)"
          />
          <el-option value="custom" :label="t('agent.automation.preset.custom')" />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('field.agent.automation.cron')" prop="cron">
        <el-input
          v-model="model.cron"
          maxlength="64"
          :placeholder="t('agent.automation.cronHint')"
          class="automation-form__mono"
        />
      </el-form-item>
      <el-form-item :label="t('field.agent.automation.timezone')" prop="timezone">
        <el-input v-model="model.timezone" maxlength="64" />
      </el-form-item>
    </template>
    <el-form-item
      v-if="model.trigger === 'event'"
      :label="t('field.agent.automation.event')"
      prop="event"
    >
      <el-select
        v-model="eventKey"
        filterable
        :placeholder="t('agent.automation.eventHint')"
        :aria-label="t('field.agent.automation.event')"
      >
        <el-option
          v-for="e in events"
          :key="`${e.domain} ${e.verb}`"
          :value="`${e.domain} ${e.verb}`"
          :label="e.label"
        />
      </el-select>
    </el-form-item>
    <el-form-item :label="t('field.agent.automation.skill')" prop="skill">
      <el-select
        v-model="model.skill"
        clearable
        filterable
        :aria-label="t('field.agent.automation.skill')"
        @clear="model.skill = null"
      >
        <el-option v-for="s in skills" :key="s.name" :value="s.name" :label="`$${s.name}`" />
      </el-select>
    </el-form-item>
    <el-form-item :label="t('field.agent.automation.prompt')" prop="prompt">
      <el-input
        v-model="model.prompt"
        type="textarea"
        :rows="4"
        :maxlength="AGENT_MESSAGE_MAX"
        show-word-limit
      />
    </el-form-item>
    <el-form-item v-if="profiles.length" :label="t('field.agent.automation.profileId')">
      <el-select
        v-model="model.profileId"
        clearable
        :aria-label="t('field.agent.automation.profileId')"
        @clear="model.profileId = null"
      >
        <el-option v-for="p in profiles" :key="p.id" :value="p.id" :label="p.name" />
      </el-select>
    </el-form-item>
    <el-form-item :label="t('field.agent.automation.writeMode')" prop="writeMode">
      <el-radio-group v-model="model.writeMode">
        <el-radio value="read_only">{{ t('agent.automation.writeMode.read_only') }}</el-radio>
        <el-radio value="ask">{{ t('agent.automation.writeMode.ask') }}</el-radio>
        <el-radio value="pre_approved">
          {{ t('agent.automation.writeMode.pre_approved') }}
        </el-radio>
        <el-radio v-if="autoReview || model.writeMode === 'auto_review'" value="auto_review">
          {{ t('agent.automation.writeMode.auto_review') }}
        </el-radio>
      </el-radio-group>
      <div class="automation-form__hint">
        {{ t(`agent.automation.writeModeHint.${model.writeMode}`) }}
      </div>
    </el-form-item>
    <template v-if="model.writeMode === 'pre_approved'">
      <el-form-item :label="t('field.agent.automation.preApproved')" prop="preApproved">
        <el-checkbox-group v-if="tools.length" v-model="model.preApproved">
          <el-checkbox v-for="tool in tools" :key="tool.name" :value="tool.name">
            {{ tool.title }} <code class="automation-form__mono">{{ tool.name }}</code>
            <el-tag v-if="stale.has(tool.name)" size="small" type="warning" disable-transitions>
              {{ t('agent.automation.stale') }}
            </el-tag>
          </el-checkbox>
        </el-checkbox-group>
        <span v-else class="automation-form__hint">{{ t('agent.automation.noTools') }}</span>
        <div v-if="stale.size" class="automation-form__hint">
          {{ t('agent.automation.staleHint') }}
        </div>
      </el-form-item>
      <el-form-item
        v-if="needsPassword"
        :label="t('field.agent.automation.currentPassword')"
        prop="currentPassword"
      >
        <el-input
          v-model="password"
          type="password"
          show-password
          autocomplete="current-password"
          name="currentPassword"
        />
      </el-form-item>
    </template>
    <el-form-item :label="t('field.agent.automation.notify')">
      <el-checkbox v-model="model.notify.inbox">{{
        t('agent.automation.notifyInbox')
      }}</el-checkbox>
      <el-checkbox v-model="model.notify.mail">{{ t('agent.automation.notifyMail') }}</el-checkbox>
    </el-form-item>
    <el-form-item :label="t('field.agent.automation.enabled')">
      <el-switch v-model="model.enabled" :aria-label="t('field.agent.automation.enabled')" />
    </el-form-item>
    <el-form-item v-if="canShare || model.shared" :label="t('field.agent.automation.shared')">
      <el-switch
        v-model="model.shared"
        :disabled="!canShare"
        :aria-label="t('field.agent.automation.shared')"
      />
      <div class="automation-form__hint">{{ t('agent.automation.sharedHint') }}</div>
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
.automation-form__hint {
  width: 100%;
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--qw-text-3);
}
.automation-form__mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
</style>
