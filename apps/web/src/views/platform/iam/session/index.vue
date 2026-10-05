<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import { ElMessage, ElMessageBox } from 'element-plus'
import { FIRST_PARTY_CLIENTS, sessionPerms, type SessionVo } from '@qiwu/shared'
import { sessionApi } from '@/api/platform/iam/session'
import DictTag from '@/core/components/DictTag.vue'
import QwTable from '@/core/components/QwTable.vue'
import Pagination from '@/core/components/Pagination.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import { useCrudList } from '@/core/composables/use-crud'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { clientName, tx } from '@/core/i18n'
import { Icon } from '@/core/icons'
import { ApiError } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'

// keep-alive name = the seeded menu's component_name
defineOptions({ name: 'IamSession' })

const { t } = useI18n()
const {
  query,
  rows,
  total,
  loading,
  filtered,
  selection,
  search,
  reset,
  refresh,
  onSelectionChange,
  onSortChange,
} = useCrudList({
  api: sessionApi,
  filters: { username: '', ip: '', clientId: '' },
  sort: '-loginAt',
})
const showSearch = ref(true)
// fits 1440 beside the side menu: the location takes the spare width, the rarer columns start hidden
const columns: QwColumn[] = [
  { prop: 'username', label: 'field.iam.session.username', width: 130, showOverflowTooltip: true },
  { prop: 'deptName', label: 'field.iam.session.deptName', width: 130, showOverflowTooltip: true },
  { prop: 'ip', label: 'field.iam.session.ip', width: 130, showOverflowTooltip: true },
  {
    prop: 'location',
    label: 'field.iam.session.location',
    minWidth: 120,
    showOverflowTooltip: true,
  },
  {
    prop: 'browser',
    label: 'field.iam.session.browser',
    width: 120,
    showOverflowTooltip: true,
    hidden: true,
  },
  {
    prop: 'os',
    label: 'field.iam.session.os',
    width: 120,
    showOverflowTooltip: true,
    hidden: true,
  },
  // computer (console) or phone (mobile app); an OAuth2 client by its id
  { prop: 'clientId', label: 'field.iam.session.clientId', width: 100 },
  { prop: 'loginAt', label: 'field.iam.session.loginAt', sortable: true, width: 160 },
  { prop: 'lastSeenAt', label: 'field.iam.session.lastSeenAt', sortable: true, width: 160 },
  { prop: 'expiresAt', label: 'field.iam.session.expiresAt', width: 160, hidden: true },
  { prop: 'keepSignedIn', label: 'field.iam.session.keepSignedIn', width: 110, hidden: true },
  {
    prop: 'userAgent',
    label: 'field.iam.session.userAgent',
    minWidth: 200,
    showOverflowTooltip: true,
    hidden: true,
  },
]
const time = (v: string | null) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '')
// ending your own session would sign you out: that is the sign-out button's job
const notCurrent = (row: SessionVo) => !row.current
const auth = useAuthStore()
const isMine = (row: SessionVo) => row.userId != null && row.userId === auth.me?.user.id

/** Asks first; `true` once confirmed. */
async function confirmed(message: string) {
  try {
    await ElMessageBox.confirm(message, t('crud.confirm.title'), {
      type: 'warning',
      confirmButtonText: t('iam.session.kick'),
      cancelButtonText: t('common.action.cancel'),
    })
    return true
  } catch {
    return false
  }
}

const kicking = ref(false)
/**
 * Runs a kick, reports it and reloads (a session that ended meanwhile is gone from the list as well); the
 * kick buttons stay busy until the reload has replaced the rows and the selection they held.
 */
async function run(kick: () => Promise<number>) {
  kicking.value = true
  try {
    ElMessage.success(t('iam.session.kicked', { count: await kick() }))
  } catch (e) {
    // 403/409/422/429/5xx are toasted by the request layer
    if (e instanceof ApiError && (e.status === 400 || e.status === 404)) ElMessage.error(e.message)
  } finally {
    await refresh()
    kicking.value = false
  }
}

async function kickOne(row: SessionVo) {
  if (!(await confirmed(t('iam.session.kickConfirm', { username: row.username, ip: row.ip }))))
    return
  await run(async () => (await sessionApi.kick(row.sid), 1))
}

async function kickUser(row: SessionVo) {
  if (row.userId == null) return
  if (!(await confirmed(t('iam.session.kickUserConfirm', { username: row.username })))) return
  const userId = row.userId
  await run(async () => (await sessionApi.kickMany({ userId })).kicked)
}

async function kickSelected() {
  const sids = selection.value.map((r) => r.sid)
  if (!sids.length || !(await confirmed(t('iam.session.batchConfirm', { count: sids.length }))))
    return
  await run(async () => (await sessionApi.kickMany({ sids })).kicked)
}
</script>

<template>
  <div class="qw-page">
    <el-card v-show="showSearch" class="qw-search-panel">
      <el-form :model="query" inline @submit.prevent="search">
        <el-form-item :label="t('field.iam.session.username')">
          <el-input v-model="query.username" name="username" clearable />
        </el-form-item>
        <el-form-item :label="t('field.iam.session.ip')">
          <el-input v-model="query.ip" name="ip" clearable />
        </el-form-item>
        <el-form-item :label="t('field.iam.session.clientId')">
          <!-- the raw id is matched exactly: pick a first-party client by name, or type an OAuth2 client id -->
          <el-select
            v-model="query.clientId"
            :aria-label="t('field.iam.session.clientId')"
            clearable
            filterable
            allow-create
            default-first-option
          >
            <el-option
              v-for="c in FIRST_PARTY_CLIENTS"
              :key="c"
              :label="clientName(c)"
              :value="c"
            />
          </el-select>
        </el-form-item>
        <el-form-item class="qw-search-actions">
          <el-button type="primary" plain native-type="submit">
            <el-icon class="el-icon--left"><Icon icon="lucide:search" /></el-icon>
            {{ t('crud.action.search') }}
          </el-button>
          <el-button @click="reset">{{ t('crud.action.reset') }}</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card class="qw-table-panel">
      <TableToolbar
        v-model:search="showSearch"
        table-id="iam.session"
        :columns="columns"
        @refresh="refresh"
      >
        <el-button
          v-if="selection.length"
          v-perm="sessionPerms.kick"
          type="danger"
          plain
          :loading="kicking"
          @click="kickSelected"
        >
          <el-icon class="el-icon--left"><Icon icon="lucide:log-out" /></el-icon>
          {{ t('iam.session.batchKick') }}
        </el-button>
      </TableToolbar>

      <QwTable
        table-id="iam.session"
        :columns="columns"
        :data="rows"
        :loading="loading"
        :filtered
        row-key="sid"
        selection
        :selectable="notCurrent"
        :actions-width="190"
        @selection-change="onSelectionChange"
        @sort-change="onSortChange"
        @reset-filters="reset"
      >
        <template #cell-clientId="{ row }">
          <span class="qw-session-client">
            <Icon :icon="row.clientId === 'mobile' ? 'lucide:smartphone' : 'lucide:monitor'" />
            {{ clientName(row.clientId) }}
          </span>
        </template>
        <template #cell-deptName="{ row }">{{ row.deptName ? tx(row.deptName) : '' }}</template>
        <template #cell-loginAt="{ row }">{{ time(row.loginAt) }}</template>
        <template #cell-lastSeenAt="{ row }">{{ time(row.lastSeenAt) }}</template>
        <template #cell-expiresAt="{ row }">{{ time(row.expiresAt) }}</template>
        <template #cell-keepSignedIn="{ row }">
          <DictTag code="core.yes_no" :value="row.keepSignedIn" />
        </template>
        <template #actions="{ row }">
          <!-- the caller's own session: signing it out is the sign-out button's job -->
          <el-tag v-if="row.current" size="small" disable-transitions>
            {{ t('iam.session.current') }}
          </el-tag>
          <template v-else>
            <el-button
              v-perm="sessionPerms.kick"
              link
              type="danger"
              :disabled="kicking"
              @click="kickOne(row)"
            >
              {{ t('iam.session.kick') }}
            </el-button>
            <el-button
              v-perm="sessionPerms.kick"
              link
              type="danger"
              :disabled="row.userId == null || isMine(row) || kicking"
              @click="kickUser(row)"
            >
              {{ t('iam.session.kickUser') }}
            </el-button>
          </template>
        </template>
      </QwTable>

      <Pagination
        v-model:page="query.page"
        v-model:page-size="query.pageSize"
        :total="total"
        @change="refresh"
      />
    </el-card>
  </div>
</template>

<style scoped>
.qw-session-client {
  display: inline-flex;
  gap: 4px;
  align-items: center;
}
</style>
