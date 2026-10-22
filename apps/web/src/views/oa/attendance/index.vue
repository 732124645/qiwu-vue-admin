<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  clockPerms,
  type ClockRecordVo,
  type ClockAdminRecordVo,
  type ClockDaySummaryVo,
  type ClockSummaryPageVo,
  type WfUserOption,
} from '@qiwu/shared'
import { attendanceApi } from '@/api/oa/attendance'
import DeptTreeSelect from '@/core/components/DeptTreeSelect.vue'
import UserPicker from '@/core/components/UserPicker.vue'
import QwTable from '@/core/components/QwTable.vue'
import Pagination from '@/core/components/Pagination.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { toastRest } from '@/core/composables/use-crud'
import { ApiError } from '@/core/request/http'
import { openDialog } from '@/core/dialog'
import { tx } from '@/core/i18n'
import { usePerm } from '@/core/permission'
import { useAuthStore } from '@/core/stores/auth'

defineOptions({ name: 'OaAttendance' })
type RawRow = ClockRecordVo & Partial<Pick<ClockAdminRecordVo, 'employeeName' | 'deptName'>>
type SummaryRow = ClockDaySummaryVo & { key: string }
const { t, locale } = useI18n()
const auth = useAuthStore()
const perm = usePerm()
const available = computed(
  () => !!auth.me && (auth.me.features === undefined || auth.me.features.includes('oa')),
)
const canAdmin = computed(() => available.value && perm.has(clockPerms.browse))
const scope = ref<'mine' | 'admin'>('mine')
const tab = ref<'records' | 'summary'>('records')
const paging = reactive({ page: 1, pageSize: 20 })
const dates = ref<string[]>([])
const action = ref('')
const workDate = ref('')
const timezone = ref('')
const userId = ref<number | null>(null)
const employee = ref('')
const deptId = ref<number | number[] | null | undefined>(null)
const raw = shallowRef<RawRow[]>([])
const summaries = shallowRef<SummaryRow[]>([])
const summary = shallowRef<ClockSummaryPageVo | null>(null)
const total = ref(0)
const loading = ref(false)
const error = ref('')
const showSearch = ref(true)
let sequence = 0
const tableId = computed(() => `oa.attendance.${scope.value}.${tab.value}`)
const columns = computed<QwColumn[]>(() => [
  ...(scope.value === 'admin'
    ? [
        { prop: 'employeeName', label: 'field.oa.clock.userId', minWidth: 130 },
        { prop: 'deptName', label: 'field.oa.clock.deptId', minWidth: 130 },
      ]
    : []),
  ...(tab.value === 'records'
    ? [
        { prop: 'workDate', label: 'field.oa.clock.workDate', width: 120 },
        { prop: 'action', label: 'field.oa.clock.action', minWidth: 100 },
        { prop: 'punchedAt', label: 'field.oa.clock.punchedAt', minWidth: 180 },
        { prop: 'timezone', label: 'field.oa.clock.timezone', minWidth: 160 },
        { prop: 'siteName', label: 'field.oa.clock.siteName', minWidth: 130 },
        { prop: 'validationResult', label: 'field.oa.clock.validationResult', minWidth: 140 },
      ]
    : [
        { prop: 'checkIn', label: 'oa.attendance.checkIn', minWidth: 180 },
        { prop: 'checkOut', label: 'oa.attendance.checkOut', minWidth: 180 },
        { prop: 'recordCount', label: 'oa.attendance.recordCount', width: 110 },
        { prop: 'clockTimezones', label: 'oa.attendance.clockTimezones', minWidth: 150 },
        { prop: 'absences', label: 'oa.attendance.absences', minWidth: 280 },
      ]),
])
const filtered = computed(
  () =>
    dates.value.length > 0 ||
    !!action.value ||
    !!workDate.value ||
    !!timezone.value ||
    userId.value !== null ||
    deptId.value != null,
)
const detailVisible = ref(false)
const detail = shallowRef<ClockAdminRecordVo | null>(null)
const detailLoading = ref(false)
const detailError = ref('')
let detailSequence = 0

/** 原始打卡按历史时区显示，日汇总时刻固定 UTC；关联区间采用服务端返回的查询时区。 */
function at(value: string | null, zone = 'UTC') {
  if (!value) return t('oa.attendance.noRecord')
  try {
    return new Intl.DateTimeFormat(locale.value, {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(value))
  } catch {
    return value
  }
}
function closeDetail() {
  detailSequence++
  detail.value = null
  detailError.value = ''
  detailVisible.value = false
  detailLoading.value = false
}
function clearEmployee() {
  userId.value = null
  employee.value = ''
}
function clearFilters() {
  dates.value = []
  action.value = ''
  workDate.value = ''
  timezone.value = ''
  userId.value = null
  employee.value = ''
  deptId.value = null
  paging.page = 1
}

/** 切换范围或权限时先清除旧数据，仅最后一代请求能回填，避免迟到的管理记录流入本人视图。 */
async function load() {
  const mine = ++sequence
  raw.value = []
  summaries.value = []
  summary.value = null
  total.value = 0
  error.value = ''
  if (!available.value || (scope.value === 'admin' && !canAdmin.value)) {
    loading.value = false
    return
  }
  loading.value = true
  const admin = scope.value === 'admin'
  const params: Record<string, unknown> = { page: paging.page, pageSize: paging.pageSize }
  if (admin) {
    if (userId.value != null) params.userId = userId.value
    if (typeof deptId.value === 'number') params.deptId = deptId.value
  }
  try {
    if (tab.value === 'records') {
      params.sort = '-punchedAt,-id'
      if (dates.value[0]) params.workDateFrom = dates.value[0]
      if (dates.value[1]) params.workDateTo = dates.value[1]
      if (action.value) params.action = action.value
      const page = await (admin ? attendanceApi.admin(params) : attendanceApi.mine(params))
      if (mine !== sequence) return
      raw.value = page.items
      total.value = page.total
    } else {
      if (workDate.value) params.workDate = workDate.value
      if (timezone.value.trim()) params.timezone = timezone.value.trim()
      const page = await (admin ? attendanceApi.summary(params) : attendanceApi.mineSummary(params))
      if (mine !== sequence) return
      summary.value = page
      total.value = page.total
      summaries.value = page.items.map((row) => ({
        ...row,
        key: `${row.userId}:${row.deptId ?? 'none'}`,
      }))
    }
  } catch (e) {
    if (mine === sequence) {
      error.value = e instanceof ApiError ? e.message : t('oa.attendance.loadFailed')
      toastRest(e)
    }
  } finally {
    if (mine === sequence) loading.value = false
  }
}
function search() {
  paging.page = 1
  void load()
}
function reset() {
  clearFilters()
  void load()
}
async function pickEmployee() {
  if (scope.value !== 'admin' || !canAdmin.value) return
  const mine = sequence
  const selected = await openDialog<WfUserOption[]>(
    UserPicker,
    {},
    { title: () => t('oa.attendance.pickEmployee'), width: 880 },
  )
  if (mine !== sequence || scope.value !== 'admin' || !canAdmin.value) return
  if (selected?.[0]) {
    userId.value = selected[0].id
    employee.value = selected[0].displayName
  }
}
async function openDetail(row: RawRow) {
  if (!available.value || (scope.value === 'admin' && !perm.has(clockPerms.view))) return
  const mine = ++detailSequence
  const admin = scope.value === 'admin'
  detail.value = null
  detailError.value = ''
  detailVisible.value = true
  detailLoading.value = true
  try {
    const value = await attendanceApi.detail(row.id, admin)
    if (mine === detailSequence) detail.value = value
  } catch (e) {
    if (mine === detailSequence) {
      detailError.value = e instanceof ApiError ? e.message : t('oa.attendance.loadFailed')
      toastRest(e)
    }
  } finally {
    if (mine === detailSequence) detailLoading.value = false
  }
}
watch(
  [() => auth.me, scope, tab],
  () => {
    sequence++
    closeDetail()
    raw.value = []
    summaries.value = []
    total.value = 0
    clearFilters()
    if (scope.value === 'admin' && !canAdmin.value) {
      scope.value = 'mine'
      return
    }
    void load()
  },
  { immediate: true, deep: true },
)
onBeforeUnmount(() => {
  sequence++
  detailSequence++
})
</script>

<template>
  <div class="qw-page">
    <el-alert
      v-if="!available"
      :title="t('oa.attendance.unavailable')"
      type="warning"
      :closable="false"
    />
    <template v-else>
      <el-card>
        <el-radio-group v-model="scope" :aria-label="t('oa.attendance.scope')"
          ><el-radio-button value="mine">{{ t('oa.attendance.mine') }}</el-radio-button
          ><el-radio-button v-if="canAdmin" value="admin">{{
            t('oa.attendance.admin')
          }}</el-radio-button></el-radio-group
        >
        <el-tabs v-model="tab"
          ><el-tab-pane :label="t('oa.attendance.records')" name="records" /><el-tab-pane
            :label="t('oa.attendance.summary')"
            name="summary"
        /></el-tabs>
        <el-alert
          :title="t(tab === 'summary' ? 'oa.attendance.activityHint' : 'oa.attendance.recordHint')"
          type="info"
          :closable="false"
        />
      </el-card>
      <el-card v-show="showSearch" class="qw-search-panel"
        ><el-form inline :disabled="loading" @submit.prevent="search">
          <template v-if="tab === 'records'"
            ><el-form-item :label="t('oa.attendance.workDates')"
              ><el-date-picker
                v-model="dates"
                type="daterange"
                value-format="YYYY-MM-DD"
                :aria-label="t('oa.attendance.workDates')" /></el-form-item
            ><el-form-item :label="t('field.oa.clock.action')"
              ><el-select v-model="action" clearable :aria-label="t('field.oa.clock.action')"
                ><el-option
                  v-for="value in ['check_in', 'check_out']"
                  :key="value"
                  :value
                  :label="t(`oa.attendance.action.${value}`)" /></el-select></el-form-item
          ></template>
          <template v-else
            ><el-form-item :label="t('field.oa.clock.workDate')"
              ><el-date-picker
                v-model="workDate"
                type="date"
                value-format="YYYY-MM-DD"
                :aria-label="t('field.oa.clock.workDate')" /></el-form-item
            ><el-form-item :label="t('oa.attendance.summaryTimezone')"
              ><el-input
                v-model="timezone"
                :aria-label="t('oa.attendance.summaryTimezone')"
                maxlength="64"
                placeholder="Asia/Shanghai" /></el-form-item
          ></template>
          <template v-if="scope === 'admin'"
            ><el-form-item :label="t('field.oa.clock.userId')"
              ><el-button :disabled="loading" @click="pickEmployee">{{
                employee || t('oa.attendance.pickEmployee')
              }}</el-button
              ><el-button
                v-if="userId != null"
                text
                :aria-label="t('oa.attendance.clearEmployee')"
                @click="clearEmployee"
                >{{ t('oa.attendance.clearEmployee') }}</el-button
              ></el-form-item
            ><el-form-item :label="t('field.oa.clock.deptId')"
              ><DeptTreeSelect
                v-model="deptId"
                :aria-label="t('field.oa.clock.deptId')" /></el-form-item
          ></template>
          <el-button type="primary" plain native-type="submit" :disabled="loading">{{
            t('crud.action.search')
          }}</el-button
          ><el-button :disabled="loading" @click="reset">{{ t('crud.action.reset') }}</el-button>
        </el-form></el-card
      >
      <el-card class="qw-table-panel">
        <TableToolbar v-model:search="showSearch" :table-id="tableId" :columns @refresh="load" />
        <el-alert v-if="error" :title="error" type="error" :closable="false" />
        <template v-if="summary"
          ><p class="attendance-hint">{{ t('oa.attendance.utcHint') }}</p>
          <p class="attendance-hint">{{ summary.workDate }} · {{ summary.timezone }}</p>
          <p class="attendance-hint">
            {{
              t('oa.attendance.window', {
                start: summary.dayStart,
                end: summary.dayEnd,
                timezone: summary.timezone,
              })
            }}
          </p></template
        >
        <QwTable
          v-if="tab === 'records'"
          :key="tableId"
          :table-id="tableId"
          :columns
          :data="raw"
          :loading
          :filtered
          @reset-filters="reset"
        >
          <template #cell-employeeName="{ row }">{{
            row.employeeName || t('oa.attendance.unknown')
          }}</template
          ><template #cell-deptName="{ row }">{{
            row.deptName ? tx(row.deptName) : t('oa.attendance.none')
          }}</template>
          <template #cell-action="{ row }">{{ t(`oa.attendance.action.${row.action}`) }}</template
          ><template #cell-punchedAt="{ row }">{{ at(row.punchedAt, row.timezone) }}</template
          ><template #cell-validationResult="{ row }">{{
            t(`oa.attendance.validation.${row.validationResult}`)
          }}</template>
          <template #actions="{ row }"
            ><el-button
              v-if="scope === 'mine' || perm.has(clockPerms.view)"
              link
              type="primary"
              @click="openDetail(row)"
              >{{ t('oa.view') }}</el-button
            ></template
          >
        </QwTable>
        <QwTable
          v-else
          :key="tableId"
          :table-id="tableId"
          :columns
          :data="summaries"
          row-key="key"
          :loading
          :filtered
          @reset-filters="reset"
        >
          <template #cell-employeeName="{ row }">{{
            row.employeeName || t('oa.attendance.unknown')
          }}</template
          ><template #cell-deptName="{ row }">{{
            row.deptName ? tx(row.deptName) : t('oa.attendance.none')
          }}</template>
          <template #cell-checkIn="{ row }">{{ at(row.checkIn) }}</template
          ><template #cell-checkOut="{ row }">{{ at(row.checkOut) }}</template
          ><template #cell-clockTimezones="{ row }">{{
            row.clockTimezones.join(', ') || t('oa.attendance.none')
          }}</template>
          <template #cell-absences="{ row }"
            ><ul v-if="row.absences.length" class="absence-intervals">
              <li v-for="absence in row.absences" :key="`${absence.type}:${absence.sourceId}`">
                {{ t(`oa.attendance.absenceType.${absence.type}`) }} ·
                {{ at(absence.startAt, summary?.timezone) }} —
                {{ at(absence.endAt, summary?.timezone) }}
              </li>
            </ul>
            <span v-else>{{ t('oa.attendance.none') }}</span>
            <p v-if="row.absencesTruncated" class="attendance-hint">
              {{
                t('oa.attendance.truncated', {
                  shown: row.absences.length,
                  count: row.absenceCount,
                })
              }}
            </p>
            <p v-else class="attendance-hint">
              {{ t('oa.attendance.absenceCount', { count: row.absenceCount }) }}
            </p></template
          >
        </QwTable>
        <Pagination
          v-model:page="paging.page"
          v-model:page-size="paging.pageSize"
          :total
          @change="load"
        />
      </el-card>
      <el-dialog
        v-model="detailVisible"
        :title="t('oa.attendance.detail')"
        width="680px"
        @closed="closeDetail"
      >
        <el-skeleton v-if="detailLoading" :rows="5" animated /><el-alert
          v-else-if="detailError"
          :title="detailError"
          type="error"
          :closable="false"
        />
        <template v-else-if="detail"
          ><el-alert
            :title="t('oa.attendance.snapshotHint')"
            type="info"
            :closable="false"
          /><el-descriptions :column="1" border>
            <el-descriptions-item :label="t('field.oa.clock.workDate')">{{
              detail.workDate
            }}</el-descriptions-item
            ><el-descriptions-item :label="t('field.oa.clock.action')">{{
              t(`oa.attendance.action.${detail.action}`)
            }}</el-descriptions-item
            ><el-descriptions-item :label="t('field.oa.clock.punchedAt')"
              >{{ at(detail.punchedAt, detail.timezone) }} ·
              {{ detail.timezone }}</el-descriptions-item
            ><el-descriptions-item :label="t('field.oa.clock.source')">{{
              t('oa.attendance.native')
            }}</el-descriptions-item
            ><el-descriptions-item :label="t('field.oa.clock.validationResult')">{{
              t(`oa.attendance.validation.${detail.validationResult}`)
            }}</el-descriptions-item>
            <el-descriptions-item :label="t('field.oa.clock.policySnapshot')"
              >{{
                t(
                  detail.policySnapshot.enabled
                    ? 'oa.attendance.enabled'
                    : 'oa.attendance.disabled',
                )
              }}
              · {{ detail.policySnapshot.timezone }} ·
              {{ t(`oa.attendance.location.${detail.policySnapshot.locationMode}`) }} ·
              {{ detail.policySnapshot.retentionDays }}</el-descriptions-item
            >
            <el-descriptions-item :label="t('field.oa.clock.siteSnapshot')"
              ><template v-if="detail.siteSnapshot"
                >{{ detail.siteSnapshot.name }} · {{ t('field.oa.attendanceSite.radiusM') }}:
                {{ detail.siteSnapshot.radiusM }} · {{ t('field.oa.attendanceSite.maxAccuracyM') }}:
                {{ detail.siteSnapshot.maxAccuracyM }}</template
              ><template v-else>{{ t('oa.attendance.none') }}</template></el-descriptions-item
            ><el-descriptions-item :label="t('field.oa.clock.distanceM')">{{
              detail.distanceM ?? t('oa.attendance.none')
            }}</el-descriptions-item
            ><el-descriptions-item :label="t('field.oa.clock.accuracyM')">{{
              detail.accuracyM ?? t('oa.attendance.none')
            }}</el-descriptions-item>
          </el-descriptions></template
        >
      </el-dialog>
    </template>
  </div>
</template>
<style scoped>
.attendance-hint {
  color: var(--qw-text-3);
  font-size: 12px;
}
.absence-intervals {
  margin: 0;
  padding-inline-start: 18px;
}
</style>
