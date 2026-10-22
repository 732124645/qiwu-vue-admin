<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import { attendanceSitePerms, type AttendanceSiteVo } from '@qiwu/shared'
import { attendanceSiteApi } from '@/api/oa/attendance'
import QwTable from '@/core/components/QwTable.vue'
import Pagination from '@/core/components/Pagination.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { toastRest } from '@/core/composables/use-crud'
import { ApiError } from '@/core/request/http'
import { openDialog } from '@/core/dialog'
import { usePerm } from '@/core/permission'
import { useAuthStore } from '@/core/stores/auth'
import SiteForm from './SiteForm.vue'

defineOptions({ name: 'OaAttendanceSites' })
const { t } = useI18n()
const auth = useAuthStore()
const perm = usePerm()
const available = computed(
  () => !!auth.me && (auth.me.features === undefined || auth.me.features.includes('oa')),
)
const canRead = computed(() => available.value && perm.has(attendanceSitePerms.browse))
const query = reactive({ page: 1, pageSize: 20, name: '', enabled: '' })
const rows = shallowRef<AttendanceSiteVo[]>([])
const total = ref(0)
const loading = ref(false)
const opening = ref(false)
const mutating = ref<number | null>(null)
const error = ref('')
const busy = computed(() => loading.value || opening.value || mutating.value !== null)
const showSearch = ref(true)
const columns: QwColumn[] = [
  { prop: 'name', label: 'field.oa.attendanceSite.name', minWidth: 160 },
  { prop: 'latitude', label: 'field.oa.attendanceSite.latitude', minWidth: 125 },
  { prop: 'longitude', label: 'field.oa.attendanceSite.longitude', minWidth: 125 },
  { prop: 'radiusM', label: 'field.oa.attendanceSite.radiusM', width: 135 },
  { prop: 'maxAccuracyM', label: 'field.oa.attendanceSite.maxAccuracyM', width: 150 },
  { prop: 'enabled', label: 'field.oa.attendanceSite.enabled', width: 110 },
]
let sequence = 0
let actionSequence = 0
async function load() {
  const mine = ++sequence
  rows.value = []
  total.value = 0
  error.value = ''
  if (!canRead.value) {
    loading.value = false
    return
  }
  loading.value = true
  try {
    const page = await attendanceSiteApi.page({
      page: query.page,
      pageSize: query.pageSize,
      ...(query.name.trim() && { name: query.name.trim() }),
      ...(query.enabled && { enabled: query.enabled }),
    })
    if (mine === sequence) {
      rows.value = page.items
      total.value = page.total
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
  query.page = 1
  void load()
}
function reset() {
  query.name = ''
  query.enabled = ''
  search()
}
async function form(row?: AttendanceSiteVo, readonly = false) {
  const allowed = row
    ? perm.has(attendanceSitePerms.view) && (readonly || perm.has(attendanceSitePerms.modify))
    : perm.has(attendanceSitePerms.create)
  if (!canRead.value || !allowed || busy.value) return
  opening.value = true
  try {
    const saved = await openDialog(
      SiteForm,
      { id: row?.id, readonly },
      {
        title: () =>
          t(
            readonly
              ? 'oa.attendance.siteDetails'
              : row
                ? 'oa.attendance.editSite'
                : 'oa.attendance.createSite',
          ),
      },
    )
    if (saved && canRead.value) await load()
  } finally {
    opening.value = false
  }
}
async function enable(row: AttendanceSiteVo, enabled: boolean) {
  if (!canRead.value || !perm.has(attendanceSitePerms.modify) || busy.value) return
  const mine = ++actionSequence
  mutating.value = row.id
  try {
    await attendanceSiteApi.update(row.id, { enabled })
    if (mine !== actionSequence) return
    ElMessage.success(t('crud.msg.updated'))
    await load()
  } catch (e) {
    if (mine === actionSequence) {
      error.value = e instanceof ApiError ? e.message : t('oa.attendance.loadFailed')
      rows.value = []
      toastRest(e)
    }
  } finally {
    if (mine === actionSequence) mutating.value = null
  }
}
async function remove(row: AttendanceSiteVo) {
  if (!canRead.value || !perm.has(attendanceSitePerms.remove) || busy.value) return
  const mine = ++actionSequence
  mutating.value = row.id
  try {
    await ElMessageBox.confirm(t('crud.confirm.delete'), t('crud.confirm.title'), {
      type: 'warning',
      confirmButtonText: t('crud.action.delete'),
      cancelButtonText: t('common.action.cancel'),
    })
    if (mine !== actionSequence || !canRead.value || !perm.has(attendanceSitePerms.remove)) return
    await attendanceSiteApi.remove(row.id)
    if (mine !== actionSequence) return
    ElMessage.success(t('crud.msg.deleted'))
    await load()
  } catch (e) {
    if (mine === actionSequence && e !== 'cancel' && e !== 'close') {
      error.value = e instanceof ApiError ? e.message : t('oa.attendance.loadFailed')
      toastRest(e)
    }
  } finally {
    if (mine === actionSequence) mutating.value = null
  }
}
watch(
  () => auth.me,
  () => {
    actionSequence++
    mutating.value = null
    query.page = 1
    void load()
  },
  { immediate: true, deep: true },
)
onBeforeUnmount(() => {
  sequence++
  actionSequence++
})
</script>
<template>
  <div class="qw-page">
    <el-alert
      v-if="!canRead"
      :title="t(available ? 'oa.attendance.notAllowed' : 'oa.attendance.unavailable')"
      type="warning"
      :closable="false"
    /><template v-else>
      <el-card v-show="showSearch" class="qw-search-panel"
        ><el-form inline :disabled="busy" @submit.prevent="search"
          ><el-form-item :label="t('field.oa.attendanceSite.name')"
            ><el-input
              v-model="query.name"
              :aria-label="t('field.oa.attendanceSite.name')"
              clearable /></el-form-item
          ><el-form-item :label="t('field.oa.attendanceSite.enabled')"
            ><el-select
              v-model="query.enabled"
              clearable
              :aria-label="t('field.oa.attendanceSite.enabled')"
              ><el-option value="true" :label="t('oa.attendance.enabled')" /><el-option
                value="false"
                :label="t('oa.attendance.disabled')" /></el-select></el-form-item
          ><el-button type="primary" plain native-type="submit" :disabled="busy">{{
            t('crud.action.search')
          }}</el-button
          ><el-button :disabled="busy" @click="reset">{{
            t('crud.action.reset')
          }}</el-button></el-form
        ></el-card
      >
      <el-card class="qw-table-panel"
        ><TableToolbar
          v-model:search="showSearch"
          table-id="oa.attendance.sites"
          :columns
          @refresh="load"
          ><el-button
            v-if="perm.has(attendanceSitePerms.create)"
            type="primary"
            :disabled="busy"
            @click="form()"
            >{{ t('crud.action.create') }}</el-button
          ></TableToolbar
        ><el-alert v-if="error" :title="error" type="error" :closable="false" />
        <QwTable
          table-id="oa.attendance.sites"
          :columns
          :data="rows"
          :loading
          :filtered="!!query.name || !!query.enabled"
          @reset-filters="reset"
          ><template #cell-enabled="{ row }"
            ><el-switch
              :model-value="row.enabled"
              :loading="mutating === row.id"
              :aria-label="t('field.oa.attendanceSite.enabled')"
              :disabled="busy || !perm.has(attendanceSitePerms.modify)"
              @change="enable(row, Boolean($event))" /></template
          ><template #actions="{ row }"
            ><el-button
              v-if="perm.has(attendanceSitePerms.view)"
              link
              type="primary"
              :disabled="busy"
              @click="form(row, true)"
              >{{ t('oa.view') }}</el-button
            ><el-button
              v-if="perm.all([attendanceSitePerms.view, attendanceSitePerms.modify])"
              link
              type="primary"
              :disabled="busy"
              @click="form(row)"
              >{{ t('crud.action.edit') }}</el-button
            ><el-button
              v-if="perm.has(attendanceSitePerms.remove)"
              link
              type="danger"
              :loading="mutating === row.id"
              :disabled="busy"
              @click="remove(row)"
              >{{ t('crud.action.delete') }}</el-button
            ></template
          ></QwTable
        >
        <Pagination
          v-model:page="query.page"
          v-model:page-size="query.pageSize"
          :total
          @change="load"
        /> </el-card
    ></template>
  </div>
</template>
