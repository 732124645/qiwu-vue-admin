<script setup lang="ts">
import { ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  monitorPerms,
  PAGE_SIZE_DEFAULT,
  QUEUE_JOB_STATES,
  type QueueJobState,
  type QueueJobVo,
  type QueueVo,
} from '@qiwu/shared'
import { monitorApi } from '@/api/platform/monitor'
import EmptyState from '@/core/components/EmptyState.vue'
import Pagination from '@/core/components/Pagination.vue'
import QwTable from '@/core/components/QwTable.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { count } from '../format'

// keep-alive name = the seeded menu's component_name
defineOptions({ name: 'MonitorQueue' })

const { t } = useI18n()

const COUNTS = ['waiting', 'prioritized', 'active', 'delayed', 'failed', 'completed'] as const
// order and visibility are the user's column settings (table id `monitor.queue`)
const columns: QwColumn[] = [
  { prop: 'name', label: 'field.monitor.queue.name', minWidth: 180, showOverflowTooltip: true },
  ...COUNTS.map((prop): QwColumn => ({
    prop,
    label: `field.monitor.queue.${prop}`,
    width: 110,
    align: 'right',
  })),
  { prop: 'paused', label: 'field.monitor.queue.state', width: 110 },
]

const rows = shallowRef<QueueVo[]>([])
const loading = ref(false)
async function load() {
  loading.value = true
  try {
    rows.value = await monitorApi.queues()
  } catch {
    // toasted by the request layer
  } finally {
    loading.value = false
  }
}

// the jobs drawer: one queue, one state, paged
const drawerOpen = ref(false)
const current = ref('')
const state = ref<QueueJobState>('failed')
const page = ref(1)
const pageSize = ref(PAGE_SIZE_DEFAULT)
const jobs = shallowRef<QueueJobVo[]>([])
const total = ref(0)
const jobsLoading = ref(false)
async function loadJobs() {
  const name = current.value
  jobsLoading.value = true
  try {
    const res = await monitorApi.queueJobs(name, {
      state: state.value,
      page: page.value,
      pageSize: pageSize.value,
    })
    if (current.value === name) {
      jobs.value = res.items
      total.value = res.total
    }
  } catch {
    // toasted by the request layer
  } finally {
    jobsLoading.value = false
  }
}
function openJobs(row: QueueVo, to: QueueJobState = 'failed') {
  current.value = row.name
  state.value = to
  page.value = 1
  jobs.value = []
  total.value = 0
  drawerOpen.value = true
  void loadJobs()
}
function pickState() {
  page.value = 1
  void loadJobs()
}

/** the job whose retry or removal is pending: its buttons spin, every job's are disabled */
const pending = ref<{ id: string; action: 'retry' | 'remove' }>()
async function act(job: QueueJobVo, action: 'retry' | 'remove') {
  if (action === 'remove')
    try {
      await ElMessageBox.confirm(
        t('monitor.queue.removeConfirm', { id: job.id }),
        t('crud.confirm.title'),
        {
          type: 'warning',
          confirmButtonText: t('crud.action.delete'),
          cancelButtonText: t('common.action.cancel'),
        },
      )
    } catch {
      return
    }
  pending.value = { id: job.id, action }
  try {
    if (action === 'retry') {
      await monitorApi.queueRetry(current.value, job.id)
      ElMessage.success(t('monitor.queue.retried'))
    } else {
      await monitorApi.queueRemove(current.value, job.id)
      ElMessage.success(t('crud.msg.deleted'))
    }
  } catch {
    return
  } finally {
    pending.value = undefined
  }
  await Promise.all([loadJobs(), load()])
}

const time = (iso: string | null) => (iso ? dayjs(iso).format('YYYY-MM-DD HH:mm:ss') : '')

void load()
</script>

<template>
  <div class="qw-page">
    <el-card class="qw-table-panel">
      <TableToolbar
        table-id="monitor.queue"
        :columns="columns"
        :searchable="false"
        @refresh="load"
      />

      <QwTable
        table-id="monitor.queue"
        :columns="columns"
        :data="rows"
        :loading="loading"
        row-key="name"
        :actions-width="120"
      >
        <template v-for="prop in COUNTS" #[`cell-${prop}`]="{ row }" :key="prop">
          <el-button
            v-if="row[prop] > 0"
            link
            :type="prop === 'failed' ? 'danger' : 'primary'"
            class="qw-cell-link"
            @click="openJobs(row, prop as QueueJobState)"
          >
            {{ count(row[prop]) }}
          </el-button>
          <span v-else :class="{ 'queue-monitor__zero': !row[prop] }">{{ count(row[prop]) }}</span>
        </template>
        <template #cell-paused="{ row }">
          <el-tag :type="row.paused ? 'warning' : 'success'" disable-transitions>
            {{ row.paused ? t('field.monitor.queue.paused') : t('monitor.queue.running') }}
          </el-tag>
        </template>
        <template #actions="{ row }">
          <el-button link type="primary" @click="openJobs(row)">
            {{ t('monitor.queue.showJobs') }}
          </el-button>
        </template>
        <template #empty>
          <EmptyState
            :title="t('monitor.queue.empty')"
            :description="t('monitor.queue.emptyHint')"
          />
        </template>
      </QwTable>
    </el-card>

    <el-drawer
      v-model="drawerOpen"
      :title="t('monitor.queue.jobsOf', { name: current })"
      size="min(960px, 92vw)"
    >
      <el-radio-group v-model="state" class="queue-monitor__states" @change="pickState">
        <el-radio-button v-for="s in QUEUE_JOB_STATES" :key="s" :value="s">
          {{ t(`field.monitor.queue.${s}`) }}
        </el-radio-button>
      </el-radio-group>
      <el-table v-loading="jobsLoading" :data="jobs" row-key="id" class="queue-monitor__jobs">
        <el-table-column type="expand">
          <template #default="{ row }">
            <pre class="queue-monitor__data">{{ row.data ?? t('monitor.queue.noData') }}</pre>
          </template>
        </el-table-column>
        <el-table-column prop="id" :label="t('field.monitor.queue.id')" width="96" />
        <el-table-column
          prop="name"
          :label="t('field.monitor.queue.jobName')"
          min-width="120"
          show-overflow-tooltip
        />
        <el-table-column :label="t('field.monitor.queue.tenantId')" width="80" align="right">
          <template #default="{ row }">{{ row.tenantId ?? '' }}</template>
        </el-table-column>
        <el-table-column :label="t('field.monitor.queue.attempts')" width="96" align="right">
          <template #default="{ row }">{{ row.attemptsMade }} / {{ row.attempts }}</template>
        </el-table-column>
        <el-table-column
          v-if="state === 'failed'"
          prop="failedReason"
          :label="t('field.monitor.queue.failedReason')"
          min-width="160"
          show-overflow-tooltip
        />
        <el-table-column :label="t('field.monitor.queue.createdAt')" width="160">
          <template #default="{ row }">{{ time(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column :label="t('field.monitor.queue.finishedAt')" width="160">
          <template #default="{ row }">{{ time(row.finishedAt) }}</template>
        </el-table-column>
        <!-- running jobs are listed read-only: a worker holds them -->
        <el-table-column
          v-if="state !== 'active'"
          :label="t('crud.action.operations')"
          width="120"
          fixed="right"
        >
          <template #default="{ row }">
            <el-button
              v-if="state === 'failed'"
              v-perm="monitorPerms.queueRetry"
              link
              type="primary"
              :loading="pending?.id === row.id && pending?.action === 'retry'"
              :disabled="!!pending"
              @click="act(row, 'retry')"
            >
              {{ t('monitor.queue.retry') }}
            </el-button>
            <el-button
              v-perm="monitorPerms.queueRemove"
              link
              type="danger"
              :loading="pending?.id === row.id && pending?.action === 'remove'"
              :disabled="!!pending"
              @click="act(row, 'remove')"
            >
              {{ t('crud.action.delete') }}
            </el-button>
          </template>
        </el-table-column>
        <template #empty>
          <EmptyState :title="t('monitor.queue.noJobs')" />
        </template>
      </el-table>
      <Pagination
        v-model:page="page"
        v-model:page-size="pageSize"
        :total="total"
        @change="loadJobs"
      />
    </el-drawer>
  </div>
</template>

<style scoped>
.queue-monitor__zero {
  color: var(--qw-text-3);
}
.queue-monitor__states {
  margin-bottom: 12px;
}
.queue-monitor__data {
  margin: 0;
  padding: 8px 16px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  color: var(--qw-text-2);
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
