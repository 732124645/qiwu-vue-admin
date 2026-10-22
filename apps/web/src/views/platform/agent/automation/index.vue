<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import { ElMessage } from 'element-plus'
import {
  AGENT_AUTOMATION_CRON_PRESETS,
  agentAutomationPerms,
  type AgentAutomationVo,
} from '@qiwu/shared'
import { agentAutomationApi } from '@/api/platform/agent-automation'
import QwTable from '@/core/components/QwTable.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import { toastRest } from '@/core/composables/use-crud'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { openDialog } from '@/core/dialog'
import { usePerm } from '@/core/permission'
import { useList } from '../setting/use-list'
import AutomationForm from './AutomationForm.vue'
import RunHistory from './RunHistory.vue'

/**
 * 自动化：本人的与本租户共享的自动化（定时、业务事件或手动触发，以创建人的身份在隐藏会话里运行一个技能
 * 或一段提示词）。只有创建人能改、启停、立即运行、看运行历史与删除（服务端给 `editable`）；结果按通知方式
 * 进收件箱，运行历史里可以打开隐藏会话查看。
 */
defineOptions({ name: 'AgentAutomation' })
const { t } = useI18n()
const perm = usePerm()
const canShare = computed(() => perm.has(agentAutomationPerms.share))
const columns: QwColumn[] = [
  { prop: 'name', label: 'field.agent.automation.name', minWidth: 180, showOverflowTooltip: true },
  { prop: 'trigger', label: 'field.agent.automation.trigger', minWidth: 200 },
  { prop: 'writeMode', label: 'field.agent.automation.writeMode', width: 120 },
  { prop: 'enabled', label: 'field.agent.automation.enabled', width: 90 },
  { prop: 'lastRunAt', label: 'agent.automation.lastRunAt', width: 150 },
  { prop: 'nextRunAt', label: 'agent.automation.nextRunAt', width: 150 },
  { prop: 'ownerName', label: 'agent.automation.owner', width: 140 },
]

const { rows, loading, refresh, remove: confirmRemove } = useList(() => agentAutomationApi.list())

/** 触发方式的说明：预设名或 cron 加时区、事件、手动。 */
function triggerText(row: AgentAutomationVo): string {
  if (row.trigger === 'schedule') {
    const p = AGENT_AUTOMATION_CRON_PRESETS.find((x) => x.cron === row.cron)
    const when = p ? t(`agent.automation.preset.${p.id}`) : (row.cron ?? '')
    return `${when} (${row.timezone ?? ''})`
  }
  if (row.trigger === 'event' && row.event) return `${row.event.domain} · ${row.event.verb}`
  return t('agent.automation.trigger.manual')
}
const time = (v: string | null) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '-')

/** 新增（无 id）或编辑，保存后重新载入。 */
async function openForm(id?: number) {
  const name = () => t('agent.automation.entity')
  const saved = await openDialog(
    AutomationForm,
    { id, canShare: canShare.value },
    {
      title: () => t(id ? 'crud.title.edit' : 'crud.title.create', { name: name() }),
      width: 760,
    },
  )
  if (saved) await refresh()
}

/** 运行历史。 */
function openRuns(row: AgentAutomationVo) {
  void openDialog(
    RunHistory,
    { id: row.id },
    { title: () => t('agent.automation.runsTitle', { name: row.name }), width: 900 },
  )
}

/** 正在处理的行（启停 / 立即运行）：按钮与开关在请求期间加载并禁用。 */
const busy = ref<number>()

/** 启用 / 停用；完成后以服务端为准重新载入。 */
async function setEnabled(row: AgentAutomationVo, enabled: boolean) {
  if (busy.value) return
  busy.value = row.id
  try {
    await agentAutomationApi.setEnabled(row.id, enabled)
  } catch (e) {
    toastRest(e)
  } finally {
    await refresh()
    busy.value = undefined
  }
}

/** 立即运行：开始后提示，到运行历史里看结果。 */
async function runNow(row: AgentAutomationVo) {
  if (busy.value) return
  busy.value = row.id
  try {
    await agentAutomationApi.run(row.id)
    ElMessage.success(t('agent.automation.started'))
  } catch (e) {
    toastRest(e)
  } finally {
    await refresh()
    busy.value = undefined
  }
}

/** 确认后删除并重新载入。 */
const remove = (row: AgentAutomationVo) => confirmRemove(() => agentAutomationApi.remove(row.id))
</script>

<template>
  <div class="qw-page">
    <el-card class="qw-table-panel">
      <p class="automation__hint">{{ t('agent.automation.hint') }}</p>
      <TableToolbar
        table-id="agent.automation"
        :columns="columns"
        :searchable="false"
        @refresh="refresh"
      >
        <el-button type="primary" @click="openForm()">{{ t('crud.action.create') }}</el-button>
      </TableToolbar>
      <QwTable
        table-id="agent.automation"
        :columns="columns"
        :data="rows"
        :loading="loading"
        row-key="id"
      >
        <template #cell-name="{ row }">
          {{ row.name }}
          <el-tag v-if="row.shared" size="small" type="primary" disable-transitions>
            {{ t('agent.automation.sharedTag') }}
          </el-tag>
        </template>
        <template #cell-trigger="{ row }">{{ triggerText(row) }}</template>
        <template #cell-writeMode="{ row }">
          {{ t(`agent.automation.writeMode.${row.writeMode}`) }}
          <el-tag
            v-if="row.stalePreApproved.length"
            size="small"
            type="warning"
            disable-transitions
            :title="row.stalePreApproved.join(', ')"
          >
            {{ t('agent.automation.stale') }}
          </el-tag>
        </template>
        <template #cell-enabled="{ row }">
          <el-switch
            v-if="row.editable"
            size="small"
            :model-value="row.enabled"
            :loading="busy === row.id"
            :disabled="busy != null"
            :aria-label="`${t('field.agent.automation.enabled')} ${row.name}`"
            @change="setEnabled(row, $event as boolean)"
          />
          <el-tag v-else size="small" :type="row.enabled ? 'success' : 'info'" disable-transitions>
            {{ t(row.enabled ? 'agent.automation.on' : 'agent.automation.off') }}
          </el-tag>
        </template>
        <template #cell-lastRunAt="{ row }">{{ time(row.lastRunAt) }}</template>
        <template #cell-nextRunAt="{ row }">{{ time(row.nextRunAt) }}</template>
        <template #actions="{ row }">
          <template v-if="row.editable">
            <el-button
              link
              type="primary"
              :loading="busy === row.id"
              :disabled="busy != null"
              @click="runNow(row)"
            >
              {{ t('agent.automation.runNow') }}
            </el-button>
            <el-button link type="primary" @click="openRuns(row)">
              {{ t('agent.automation.runs') }}
            </el-button>
            <el-button link type="primary" @click="openForm(row.id)">
              {{ t('crud.action.edit') }}
            </el-button>
            <el-button link type="danger" @click="remove(row)">
              {{ t('crud.action.delete') }}
            </el-button>
          </template>
        </template>
      </QwTable>
    </el-card>
  </div>
</template>

<style scoped>
.automation__hint {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--qw-text-3);
}
</style>
