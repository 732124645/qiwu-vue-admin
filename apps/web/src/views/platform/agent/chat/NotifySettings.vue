<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import type { AgentNotifySettings } from '@qiwu/shared'
import { agentNotifyApi } from '@/api/platform/agent'
import { toastRest } from '@/core/composables/use-crud'

/**
 * 对话页“会话设置”里的“通知”一页：每类提醒是否同时发邮件；站内信总会发（手机端经站内信同步）。
 * 打开这一页时载入，点保存才提交。
 */
defineOptions({ name: 'AgentNotifySettings' })
const { t } = useI18n()

const EVENTS = ['turnDone', 'waiting', 'automation'] as const
const form = reactive<AgentNotifySettings>({
  turnDone: { mail: false },
  waiting: { mail: false },
  automation: { mail: false },
})
const loaded = ref(false)
const loading = ref(false)
const saving = ref(false)

/** 打开这一页时载入本人的设置（同一实例只载一次）。 */
async function load() {
  if (loaded.value || loading.value) return
  loading.value = true
  try {
    Object.assign(form, await agentNotifyApi.get())
    loaded.value = true
  } catch (e) {
    toastRest(e)
  } finally {
    loading.value = false
  }
}

/** 保存设置；成功提示，失败由请求层提示。 */
async function save() {
  if (saving.value) return
  saving.value = true
  try {
    Object.assign(form, await agentNotifyApi.save({ ...form }))
    ElMessage.success(t('crud.msg.updated'))
  } catch (e) {
    toastRest(e)
  } finally {
    saving.value = false
  }
}
onMounted(load)
</script>

<template>
  <div v-loading="loading" class="agent-notify">
    <p class="agent-notify__title">{{ t('agent.chat.notify.title') }}</p>
    <div v-for="e in EVENTS" :key="e" class="agent-notify__row">
      <span class="agent-notify__name">{{ t(`agent.chat.notify.event.${e}`) }}</span>
      <el-switch
        v-model="form[e].mail"
        :data-event="e"
        :disabled="!loaded"
        :aria-label="`${t(`agent.chat.notify.event.${e}`)} ${t('agent.chat.notify.mail')}`"
        :active-text="t('agent.chat.notify.mail')"
      />
    </div>
    <p class="agent-notify__hint">{{ t('agent.chat.notify.hint') }}</p>
    <el-button
      size="small"
      type="primary"
      :loading="saving"
      :disabled="saving || !loaded"
      @click="save"
    >
      {{ t('crud.action.save') }}
    </el-button>
  </div>
</template>

<style scoped>
.agent-notify__title {
  margin: 0 0 8px;
  font-weight: 600;
  color: var(--qw-text);
}
.agent-notify__row {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0;
}
.agent-notify__name {
  color: var(--qw-text-2);
}
.agent-notify__hint {
  margin: 8px 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--qw-text-3);
}
</style>
