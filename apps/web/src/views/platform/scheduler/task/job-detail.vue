<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import type { TagProps } from 'element-plus'
import { CRON_NEXT_COUNT, fieldLabelKeys, type JobOutcome } from '@qiwu/shared'
import { jobApi, type JobRunView, type JobTaskView } from '@/api/platform/scheduler/job'
import CodeViewer from '@/core/components/CodeViewer.vue'
import DictTag from '@/core/components/DictTag.vue'
import { describeCron, useNextFireTimes } from '@/core/composables/use-cron'
import { currentLocale, tx } from '@/core/i18n'

/**
 * One task in the task list's detail drawer (scheduler page-2): its settings
 * (`GET /scheduler/tasks/:id`), the next fire times the server computes for its cron and, with `runs`
 * (the caller may browse the run log), its latest runs (`GET /scheduler/runs?taskId=`). Mount it inside
 * an `el-drawer` with `destroy-on-close`: each opening loads anew.
 */
defineOptions({ name: 'SchedulerTaskDetail' })
const { id, runs: showRuns = true } = defineProps<{ id: number; runs?: boolean }>()
const { t, te } = useI18n()

const task = shallowRef<JobTaskView>()
const recent = shallowRef<JobRunView[]>([])
const loading = ref(true)
const loadingRuns = ref(showRuns)
// failures are toasted by the request layer (a 404 leaves the drawer empty, as the generated details)
jobApi
  .task(id)
  .then((r) => (task.value = r))
  .catch(() => undefined)
  .finally(() => (loading.value = false))
if (showRuns)
  jobApi
    .recentRuns(id)
    .then((p) => (recent.value = p.items))
    .catch(() => undefined)
    .finally(() => (loadingRuns.value = false))

const {
  times,
  error: nextError,
  loading: loadingNext,
} = useNextFireTimes(() => task.value?.cron ?? '', 0)
const words = computed(() => describeCron(task.value?.cron ?? ''))

/** the generated modules' field labels (`field.scheduler.<task|run>.<prop>`), else the prop */
const label = (domain: 'task' | 'run', prop: string) => {
  const key = fieldLabelKeys(`scheduler.${domain}`, [prop]).find((k) => te(k))
  return key ? t(key) : prop
}
/** a known key's text, else the code itself (a handler without a label, a later value) */
const known = (key: string, code: string) => (te(key) ? t(key) : code)
const time = (iso: string | null | undefined, seconds = false) =>
  iso ? dayjs(iso).format(seconds ? 'YYYY-MM-DD HH:mm:ss' : 'YYYY-MM-DD HH:mm') : ''
const ms = (n: number | null | undefined) =>
  n == null
    ? ''
    : new Intl.NumberFormat(currentLocale(), {
        style: 'unit',
        unit: 'millisecond',
        unitDisplay: 'short',
      }).format(n)
const params = (p: unknown) =>
  p == null || p === '' ? '' : typeof p === 'string' ? p : JSON.stringify(p, null, 2)
const paramsFiles = computed(() => [
  { path: 'params.json', content: params(task.value?.params), language: 'json' },
])
const OUTCOME_TAG: Record<JobOutcome, TagProps['type']> = {
  ok: 'success',
  failed: 'danger',
  timeout: 'warning',
  skipped: 'info',
}
</script>

<template>
  <div v-loading="loading" class="qw-detail job-detail">
    <template v-if="task">
      <el-descriptions :column="1" border>
        <el-descriptions-item :label="label('task', 'name')">{{
          tx(task.name)
        }}</el-descriptions-item>
        <el-descriptions-item :label="label('task', 'groupCode')">
          <DictTag v-if="task.groupCode" code="scheduler.job_group" :value="task.groupCode" />
        </el-descriptions-item>
        <el-descriptions-item :label="label('task', 'handler')">
          {{ known(`scheduler.handler.${task.handler}`, task.handler) }}
          <div v-if="te(`scheduler.handler.${task.handler}`)" class="job-detail__sub">
            <code class="job-detail__code">{{ task.handler }}</code>
          </div>
        </el-descriptions-item>
        <el-descriptions-item :label="label('task', 'cron')">
          <code class="job-detail__code">{{ task.cron }}</code>
          <div v-if="words" class="job-detail__sub">{{ words }}</div>
        </el-descriptions-item>
        <el-descriptions-item :label="label('task', 'params')">
          <CodeViewer
            v-if="paramsFiles[0]?.content"
            :files="paramsFiles"
            height="min(240px, 40vh)"
          />
        </el-descriptions-item>
        <el-descriptions-item :label="label('task', 'enabled')">
          <DictTag code="core.enabled" :value="task.enabled" />
        </el-descriptions-item>
        <el-descriptions-item :label="label('task', 'allowOverlap')">
          <DictTag code="core.yes_no" :value="task.allowOverlap" />
        </el-descriptions-item>
        <el-descriptions-item :label="label('task', 'misfire')">
          {{ known(`scheduler.job.misfire.${task.misfire}`, task.misfire) }}
        </el-descriptions-item>
        <el-descriptions-item :label="label('task', 'retryMax')">{{
          task.retryMax
        }}</el-descriptions-item>
        <el-descriptions-item :label="label('task', 'retryDelayMs')">
          {{ ms(task.retryDelayMs) }}
        </el-descriptions-item>
        <el-descriptions-item :label="label('task', 'timeoutMs')">
          {{ ms(task.timeoutMs) }}
        </el-descriptions-item>
        <el-descriptions-item :label="label('task', 'lastFireAt')">
          {{ time(task.lastFireAt, true) }}
        </el-descriptions-item>
        <el-descriptions-item :label="label('task', 'note')">
          <span class="qw-detail__text">{{ task.note }}</span>
        </el-descriptions-item>
      </el-descriptions>

      <section class="job-detail__section" aria-live="polite">
        <h3 class="job-detail__title">{{ t('cron.next', { count: CRON_NEXT_COUNT }) }}</h3>
        <p v-if="!task.enabled" class="job-detail__sub">{{ t('scheduler.job.paused') }}</p>
        <p v-if="nextError" class="job-detail__error">{{ nextError }}</p>
        <ol v-else v-loading="loadingNext" class="job-detail__times">
          <li v-for="at in times" :key="at">{{ time(at, true) }}</li>
        </ol>
      </section>

      <section v-if="showRuns" class="job-detail__section">
        <h3 class="job-detail__title">{{ t('scheduler.job.recentRuns') }}</h3>
        <el-table
          v-loading="loadingRuns"
          :data="recent"
          size="small"
          :empty-text="t('scheduler.job.noRuns')"
        >
          <el-table-column :label="label('run', 'startedAt')" width="160">
            <template #default="{ row }">{{ time(row.startedAt, true) }}</template>
          </el-table-column>
          <el-table-column :label="label('run', 'outcome')" width="100">
            <template #default="{ row }">
              <el-tag
                :type="OUTCOME_TAG[row.outcome as JobOutcome]"
                class="qw-dict-tag"
                disable-transitions
              >
                {{ known(`scheduler.job.outcome.${row.outcome}`, row.outcome) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column
            :label="label('run', 'attempt')"
            prop="attempt"
            width="80"
            align="right"
          />
          <el-table-column :label="label('run', 'costMs')" width="100" align="right">
            <template #default="{ row }">{{ ms(row.costMs) }}</template>
          </el-table-column>
          <el-table-column
            :label="label('run', 'error')"
            prop="error"
            min-width="120"
            show-overflow-tooltip
          />
        </el-table>
      </section>
    </template>
  </div>
</template>

<style scoped>
.job-detail :deep(.code-viewer__code) {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.job-detail__code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  color: var(--qw-text-2);
}
.job-detail__sub {
  margin: 2px 0 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--qw-text-3);
}
.job-detail__section {
  margin-top: 20px;
}
.job-detail__title {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--qw-text);
}
.job-detail__error {
  margin: 0;
  font-size: 12px;
  color: var(--qw-danger);
}
.job-detail__times {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 18px;
  margin: 0;
  padding: 0;
  font-size: 13px;
  color: var(--qw-text-2);
  font-variant-numeric: tabular-nums;
  list-style: none;
}
</style>
