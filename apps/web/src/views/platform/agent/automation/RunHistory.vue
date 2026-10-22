<script setup lang="ts">
import { ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import dayjs from 'dayjs'
import type { AgentAutomationRunVo } from '@qiwu/shared'
import { agentAutomationApi } from '@/api/platform/agent-automation'
import Pagination from '@/core/components/Pagination.vue'
import QwTable from '@/core/components/QwTable.vue'
import { toastRest } from '@/core/composables/use-crud'
import type { QwColumn } from '@/core/composables/use-table-prefs'

/**
 * 一条自动化的运行历史（`openDialog(RunHistory, { id })`，只给创建人）：状态、触发方式、开始与结束时间、
 * 回答摘要或失败原因；有隐藏会话的可以打开它查看全过程（询问模式下也在那里确认写入）。
 */
defineOptions({ name: 'AgentAutomationRuns' })
const { id } = defineProps<{ id: number }>()
const emit = defineEmits<{ done: [saved: unknown]; cancel: [] }>()
const { t, te } = useI18n()
const router = useRouter()
const columns: QwColumn[] = [
  { prop: 'status', label: 'agent.automation.run.status', width: 100 },
  { prop: 'trigger', label: 'agent.automation.run.trigger', width: 100 },
  { prop: 'startedAt', label: 'agent.automation.run.startedAt', width: 150 },
  { prop: 'endedAt', label: 'agent.automation.run.endedAt', width: 150 },
  { prop: 'summary', label: 'agent.automation.run.summary', minWidth: 260 },
]
const rows = shallowRef<AgentAutomationRunVo[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(10)
const loading = ref(false)

/** 载入当前页；失败由请求层提示。 */
async function load() {
  loading.value = true
  try {
    const res = await agentAutomationApi.runs(id, page.value, pageSize.value)
    rows.value = res.items
    total.value = res.total
  } catch (e) {
    toastRest(e)
  } finally {
    loading.value = false
  }
}
void load()

const TAG: Record<string, 'success' | 'danger' | 'warning' | 'info' | 'primary'> = {
  completed: 'success',
  failed: 'danger',
  waiting: 'warning',
  running: 'primary',
  skipped: 'info',
  cancelled: 'info',
}
/** 失败或跳过的原因：认识的代码翻译，不认识的原样显示。 */
const errorText = (code: string) =>
  te(`agent.automation.error.${code}`) ? t(`agent.automation.error.${code}`) : code

/** 打开这次运行的隐藏会话（关掉弹窗再跳转）。 */
function openThread(threadId: number) {
  emit('cancel')
  void router.push({ name: 'agent-chat', query: { thread: String(threadId) } })
}
</script>

<template>
  <div>
    <QwTable
      table-id="agent.automationRun"
      :columns="columns"
      :data="rows"
      :loading="loading"
      row-key="id"
    >
      <template #cell-status="{ row }">
        <el-tag size="small" :type="TAG[row.status] ?? 'info'" disable-transitions>
          {{ t(`agent.automation.status.${row.status}`) }}
        </el-tag>
      </template>
      <template #cell-trigger="{ row }">{{
        t(`agent.automation.trigger.${row.trigger}`)
      }}</template>
      <template #cell-startedAt="{ row }">
        {{ dayjs(row.startedAt).format('YYYY-MM-DD HH:mm') }}
      </template>
      <template #cell-endedAt="{ row }">
        {{ row.endedAt ? dayjs(row.endedAt).format('YYYY-MM-DD HH:mm') : '' }}
      </template>
      <template #cell-summary="{ row }">
        <span v-if="row.error" class="automation-runs__error">{{ errorText(row.error) }}</span>
        <span class="automation-runs__summary">{{ row.summary ?? '' }}</span>
      </template>
      <template #actions="{ row }">
        <el-button v-if="row.threadId" link type="primary" @click="openThread(row.threadId)">
          {{ t('agent.automation.openThread') }}
        </el-button>
      </template>
    </QwTable>
    <Pagination v-model:page="page" v-model:page-size="pageSize" :total="total" @change="load" />
  </div>
</template>

<style scoped>
.automation-runs__error {
  margin-right: 8px;
  color: var(--qw-danger);
}
.automation-runs__summary {
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
