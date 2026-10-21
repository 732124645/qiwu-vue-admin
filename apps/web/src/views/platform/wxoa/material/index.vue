<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  WXOA_MEDIA_KINDS,
  wxoaPerms,
  type Page,
  type WxoaMaterialVo,
  type WxoaMediaKind,
  type WxoaSyncVo,
} from '@qiwu/shared'
import { storageApi } from '@/api/platform/storage/object'
import { wxoaMaterialApi } from '@/api/platform/wxoa/material'
import QwTable from '@/core/components/QwTable.vue'
import Pagination from '@/core/components/Pagination.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import { toastRest, useCrudList } from '@/core/composables/use-crud'
import { useDict } from '@/core/composables/use-dict'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { formatSize } from '@/core/composables/use-upload'
import { openDialog } from '@/core/dialog'
import { Icon } from '@/core/icons'
import { usePerm } from '@/core/permission'
import AccountSwitch from '../components/AccountSwitch.vue'
import { useWxoaAccount } from '../components/use-wxoa-account'
import WxoaMediaImage from '../components/WxoaMediaImage.vue'
import WxoaMaterialUpload from './upload.vue'

/**
 * Permanent materials of the chosen account, one tab per kind (see docs/design-notes.md#wxoa). An image
 * shows its local copy when there is one, else its WeChat link on the mmbiz hosts only; voice and video
 * copies download. Uploads store a local copy first; a sync pulls WeChat's list (links only) in the
 * background, its progress polled while the page shows. Deleting removes it on WeChat too.
 */
// keep-alive name = the seeded menu's component_name
defineOptions({ name: 'WxoaMaterial' })

const { t } = useI18n()
const perms = wxoaPerms.material
const perm = usePerm()
const can = computed(() => ({
  create: perm.has(perms.create),
  remove: perm.has(perms.remove),
  sync: perm.has(perms.sync),
}))
const { accountId } = useWxoaAccount()
const kindDict = useDict('wxoa.media_kind')
const tab = ref<WxoaMediaKind>('image')

const { query, rows, total, loading, filtered, search, reset, refresh, onSortChange } = useCrudList(
  {
    api: {
      // none chosen yet: nothing to load
      page: async (params: Record<string, unknown>): Promise<Page<WxoaMaterialVo>> =>
        accountId.value == null
          ? { items: [], total: 0 }
          : wxoaMaterialApi.page({ ...params, accountId: accountId.value, mediaKind: tab.value }),
    },
    filters: { title: '' },
    sort: '-createdAt',
  },
)
const showSearch = ref(true)
const columns: QwColumn[] = [
  { prop: 'preview', label: 'wxoa.material.col.preview', width: 96 },
  { prop: 'title', label: 'field.wxoa.material.title', minWidth: 160, showOverflowTooltip: true },
  {
    prop: 'fileName',
    label: 'wxoa.material.col.fileName',
    minWidth: 180,
    showOverflowTooltip: true,
  },
  { prop: 'byteSize', label: 'wxoa.material.col.byteSize', width: 110 },
  { prop: 'origin', label: 'wxoa.material.col.origin', width: 130 },
  {
    prop: 'mediaId',
    label: 'wxoa.material.col.mediaId',
    minWidth: 220,
    showOverflowTooltip: true,
    hidden: true,
  },
  { prop: 'intro', label: 'field.wxoa.material.intro', minWidth: 180, hidden: true },
  { prop: 'createdAt', label: 'field.common.createdAt', sortable: true, width: 160 },
]
const imageKind = computed(() => tab.value === 'image' || tab.value === 'thumb')
const nameOf = (m: WxoaMaterialVo) => m.title || m.fileName || m.mediaId

function clear() {
  rows.value = []
  total.value = 0
}
watch(tab, () => {
  clear()
  void search()
})

async function openUpload() {
  const id = accountId.value
  if (id == null) return
  const saved = await openDialog<WxoaMaterialVo>(
    WxoaMaterialUpload,
    { accountId: id, mediaKind: tab.value },
    { title: () => t('wxoa.material.upload.title'), width: 600 },
  )
  if (!saved) return
  ElMessage.success(t('wxoa.material.upload.done'))
  if (saved.mediaKind !== tab.value) tab.value = saved.mediaKind
  else await refresh()
}

/** saves the local copy under its file name */
function download(m: WxoaMaterialVo) {
  if (m.objectId == null) return
  void storageApi
    .download({ id: m.objectId, originalName: m.fileName || `${m.mediaKind}-${m.id}` })
    .catch(toastRest)
}

async function remove(m: WxoaMaterialVo) {
  try {
    await ElMessageBox.confirm(
      t('wxoa.material.removeConfirm', { name: nameOf(m) }),
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
  try {
    // one an auto-reply rule uses: 409, toasted by the request layer
    await wxoaMaterialApi.remove(m.id)
  } catch (e) {
    toastRest(e)
    return
  }
  ElMessage.success(t('crud.msg.deleted'))
  await refresh()
}

// the sync runs in the background on the server; while it runs and the page is shown, its progress is
// polled, each poll 2 s after the previous answer
const sync = shallowRef<WxoaSyncVo | null>(null)
const SYNC_POLL_MS = 2000
// false while keep-alive has parked the page
let active = true
let syncSeq = 0
let syncTimer: ReturnType<typeof setTimeout> | undefined
/** drops the scheduled poll and any answer still on its way */
function stopSync() {
  syncSeq++
  clearTimeout(syncTimer)
}
async function loadSync() {
  stopSync()
  const id = accountId.value
  if (id == null || !can.value.sync) return
  const mine = syncSeq
  try {
    const state = await wxoaMaterialApi.syncState(id)
    if (mine !== syncSeq) return
    const finished = sync.value?.state === 'running' && state.state !== 'running'
    sync.value = state
    if (finished) void refresh()
    if (state.state === 'running' && active) syncTimer = setTimeout(loadSync, SYNC_POLL_MS)
  } catch {
    // the request layer said why; the state is unknown now, so the button is free again
    if (mine === syncSeq) sync.value = null
  }
}
const syncRunning = computed(() => sync.value?.state === 'running')
const starting = ref(false)
async function startSync() {
  const id = accountId.value
  if (starting.value || syncRunning.value || id == null) return
  starting.value = true
  try {
    await wxoaMaterialApi.sync(id)
    sync.value = {
      state: 'running',
      done: 0,
      total: null,
      startedAt: null,
      finishedAt: null,
      code: null,
    }
  } catch (e) {
    // one already running (409) is toasted by the request layer; its progress shows below
    toastRest(e)
  } finally {
    starting.value = false
  }
  await loadSync()
}
const time = (iso: string | null) => (iso ? dayjs(iso).format('YYYY-MM-DD HH:mm') : '')
const syncText = computed(() => {
  const s = sync.value
  switch (s?.state) {
    case 'running':
      return s.total == null
        ? t('wxoa.material.sync.runningNoTotal', { done: s.done })
        : t('wxoa.material.sync.running', { done: s.done, total: s.total })
    case 'done':
      return t('wxoa.material.sync.done', { time: time(s.finishedAt) })
    case 'failed':
      return t('wxoa.material.sync.failed', { code: s.code ?? '' })
    case 'interrupted':
      return t('wxoa.material.sync.interrupted')
    default:
      return ''
  }
})

watch(accountId, () => {
  // nothing of the previous account stays on screen, even if the new list fails to load
  clear()
  sync.value = null
  void loadSync()
  void search()
})
void loadSync()
onDeactivated(() => {
  active = false
  stopSync()
})
onActivated(() => {
  active = true
  void loadSync()
})
onBeforeUnmount(stopSync)
</script>

<template>
  <div class="qw-page">
    <AccountSwitch />
    <template v-if="accountId != null">
      <el-card v-show="showSearch" class="qw-search-panel">
        <el-form :model="query" inline @submit.prevent="search">
          <el-form-item :label="t('field.wxoa.material.title')">
            <el-input v-model="query.title" name="title" clearable />
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
        <el-tabs v-model="tab">
          <el-tab-pane
            v-for="k in WXOA_MEDIA_KINDS"
            :key="k"
            :name="k"
            :label="kindDict.label(k)"
          />
        </el-tabs>
        <TableToolbar
          v-model:search="showSearch"
          table-id="wxoa.material"
          :columns="columns"
          @refresh="refresh"
        >
          <el-button v-if="can.create" type="primary" @click="openUpload">
            <el-icon class="el-icon--left"><Icon icon="lucide:upload" /></el-icon>
            {{ t('wxoa.material.upload.action') }}
          </el-button>
          <el-button v-if="can.sync" :loading="starting || syncRunning" @click="startSync">
            <el-icon v-if="!starting && !syncRunning" class="el-icon--left">
              <Icon icon="lucide:refresh-cw" />
            </el-icon>
            {{ t('wxoa.material.sync.action') }}
          </el-button>
          <span v-if="syncText" class="wxoa-material__sync" role="status">{{ syncText }}</span>
        </TableToolbar>

        <QwTable
          table-id="wxoa.material"
          :columns="columns"
          :data="rows"
          :loading="loading"
          :filtered
          @sort-change="onSortChange"
          @reset-filters="reset"
        >
          <template #cell-preview="{ row }">
            <WxoaMediaImage
              v-if="imageKind"
              :object-id="row.objectId"
              :url="row.wxUrl"
              :alt="nameOf(row)"
              preview
            />
            <span v-else class="wxoa-material__icon" aria-hidden="true">
              <Icon
                :icon="row.mediaKind === 'voice' ? 'lucide:audio-lines' : 'lucide:clapperboard'"
              />
            </span>
          </template>
          <template #cell-byteSize="{ row }">
            {{ row.byteSize == null ? '' : formatSize(row.byteSize) }}
          </template>
          <template #cell-origin="{ row }">
            {{ row.origin ? t(`wxoa.material.origin.${row.origin}`) : '' }}
          </template>
          <template #cell-createdAt="{ row }">{{ time(row.createdAt) }}</template>
          <template #actions="{ row }">
            <el-button v-if="row.objectId != null" link type="primary" @click="download(row)">
              {{ t('wxoa.material.download') }}
            </el-button>
            <el-button v-if="can.remove" link type="danger" @click="remove(row)">
              {{ t('crud.action.delete') }}
            </el-button>
          </template>
        </QwTable>

        <Pagination
          v-model:page="query.page"
          v-model:page-size="query.pageSize"
          :total="total"
          @change="refresh"
        />
      </el-card>
    </template>
  </div>
</template>

<style scoped>
.wxoa-material__sync {
  align-self: center;
  font-size: 13px;
  color: var(--qw-text-2);
}
.wxoa-material__icon {
  font-size: 22px;
  color: var(--qw-text-3);
}
</style>
