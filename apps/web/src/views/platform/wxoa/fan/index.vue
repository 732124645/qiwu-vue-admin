<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  wxoaFanRemarkBody,
  wxoaPerms,
  type Page,
  type WxoaFanRemarkBody,
  type WxoaFanVo,
  type WxoaSyncVo,
  type WxoaTagVo,
} from '@qiwu/shared'
import { wxoaFanApi } from '@/api/platform/wxoa/fan'
import { wxoaTagApi } from '@/api/platform/wxoa/tag'
import DictSelect from '@/core/components/DictSelect.vue'
import DictTag from '@/core/components/DictTag.vue'
import QwTable from '@/core/components/QwTable.vue'
import Pagination from '@/core/components/Pagination.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import { toastRest, useCrudList } from '@/core/composables/use-crud'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { openDialog } from '@/core/dialog'
import { Icon } from '@/core/icons'
import { usePerm } from '@/core/permission'
import AccountSwitch from '../components/AccountSwitch.vue'
import { useWxoaAccount } from '../components/use-wxoa-account'
import WxoaTagPanel from './tag-panel.vue'
import WxoaFanTagging from './tagging.vue'
import WxoaTextForm from './text-form.vue'

// keep-alive name = the seeded menu's component_name
defineOptions({ name: 'WxoaFan' })

const { t } = useI18n()
const perms = wxoaPerms.fan
const perm = usePerm()
const can = computed(() => ({
  modify: perm.has(perms.modify),
  sync: perm.has(perms.sync),
  tags: perm.has(wxoaPerms.tag.browse),
}))
const { accountId } = useWxoaAccount()

// every list and export call names the chosen account; none chosen yet: nothing to load
const withAccount = (params: Record<string, unknown>) => ({ ...params, accountId: accountId.value })
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
  exporting,
  exportXlsx,
} = useCrudList({
  api: {
    page: async (params: Record<string, unknown>): Promise<Page<WxoaFanVo>> =>
      accountId.value == null ? { items: [], total: 0 } : wxoaFanApi.page(withAccount(params)),
    exportFile: (params: Record<string, unknown>, filename: string) =>
      wxoaFanApi.exportFile(withAccount(params), filename),
  },
  filters: {
    // the WeChat tag id picked in the tag panel
    tagId: null as number | null,
    openId: '',
    remark: '',
    subscribed: null as string | null,
    blocked: null as string | null,
  },
})
const showSearch = ref(true)

const columns: QwColumn[] = [
  { prop: 'openId', label: 'field.wxoa.fan.openId', minWidth: 240, showOverflowTooltip: true },
  { prop: 'remark', label: 'field.wxoa.fan.remark', width: 140, showOverflowTooltip: true },
  { prop: 'tagIds', label: 'wxoa.fan.col.tags', minWidth: 180 },
  { prop: 'subscribed', label: 'field.wxoa.fan.subscribed', width: 100 },
  { prop: 'blocked', label: 'field.wxoa.fan.blocked', width: 110 },
  { prop: 'subscribedAt', label: 'wxoa.fan.col.subscribedAt', sortable: true, width: 160 },
  { prop: 'lastInboundAt', label: 'wxoa.fan.col.lastInboundAt', sortable: true, width: 160 },
  { prop: 'unsubscribedAt', label: 'wxoa.fan.col.unsubscribedAt', width: 160, hidden: true },
  { prop: 'qrScene', label: 'wxoa.fan.col.qrScene', width: 140, hidden: true },
  { prop: 'subscribeScene', label: 'wxoa.fan.col.subscribeScene', width: 180, hidden: true },
  {
    prop: 'unionId',
    label: 'wxoa.fan.col.unionId',
    width: 240,
    showOverflowTooltip: true,
    hidden: true,
  },
  { prop: 'lang', label: 'wxoa.fan.col.lang', width: 90, hidden: true },
  { prop: 'syncedAt', label: 'wxoa.fan.col.syncedAt', width: 160, hidden: true },
]
const time = (iso: string | null) => (iso ? dayjs(iso).format('YYYY-MM-DD HH:mm') : '')

const tags = shallowRef<WxoaTagVo[]>([])
const tagsLoading = ref(false)
let tagSeq = 0
async function loadTags() {
  const id = accountId.value
  const mine = ++tagSeq
  if (id == null || !can.value.tags) return
  tagsLoading.value = true
  try {
    const list = await wxoaTagApi.list(id)
    if (mine === tagSeq) tags.value = list
  } catch (e) {
    if (mine === tagSeq) toastRest(e)
  } finally {
    if (mine === tagSeq) tagsLoading.value = false
  }
}
/** WeChat tag id → name; a tag not known here shows as its id */
const tagNames = computed(() => new Map(tags.value.map((tag) => [tag.tagId, tag.name])))
const tagName = (tagId: number) => tagNames.value.get(tagId) ?? `#${tagId}`

function pickTag(tagId: number | null) {
  query.tagId = tagId
  void search()
}
/** a tag added, renamed, deleted or synced: names and counts change, a deleted one leaves the fans */
function onTagsChanged() {
  void loadTags()
  void refresh()
}

// the full fan sync runs in the background on the server; while it runs and the page is shown, its
// progress is polled, each poll 2 s after the previous answer
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
    const state = await wxoaFanApi.syncState(id)
    if (mine !== syncSeq) return
    const finished = sync.value?.state === 'running' && state.state !== 'running'
    sync.value = state
    if (finished) onTagsChanged()
    if (state.state === 'running' && active) syncTimer = setTimeout(loadSync, SYNC_POLL_MS)
  } catch {
    // the request layer said why; the state is unknown now, so the button is free again
    // (a sync still running answers 409 and its progress shows again)
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
    await wxoaFanApi.sync(id)
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
const syncText = computed(() => {
  const s = sync.value
  switch (s?.state) {
    case 'running':
      return s.total == null
        ? t('wxoa.fan.sync.runningNoTotal', { done: s.done })
        : t('wxoa.fan.sync.running', { done: s.done, total: s.total })
    case 'done':
      return t('wxoa.fan.sync.done', { time: time(s.finishedAt) })
    case 'failed':
      return t('wxoa.fan.sync.failed', { code: s.code ?? '' })
    case 'interrupted':
      return t('wxoa.fan.sync.interrupted')
    default:
      return ''
  }
})

watch(accountId, () => {
  // nothing of the previous account stays on screen or selected, even if the new list fails to load
  query.tagId = null
  rows.value = []
  total.value = 0
  selection.value = []
  tags.value = []
  sync.value = null
  void loadTags()
  void loadSync()
  void search()
})
void loadTags()
void loadSync()
// kept alive: no polling while hidden, the state again once shown
onDeactivated(() => {
  active = false
  stopSync()
})
onActivated(() => {
  active = true
  void loadSync()
})
onBeforeUnmount(stopSync)

async function openRemark(row: WxoaFanVo) {
  const saved = await openDialog(
    WxoaTextForm,
    {
      schema: wxoaFanRemarkBody,
      prop: 'remark',
      value: row.remark,
      maxlength: 30,
      save: (body: WxoaFanRemarkBody) => wxoaFanApi.remark(row.id, body),
    },
    { title: () => t('wxoa.fan.remark.title') },
  )
  if (!saved) return
  ElMessage.success(t('crud.msg.updated'))
  await refresh()
}

async function openTagging(fans: WxoaFanVo[]) {
  if (!fans.length) return
  const saved = await openDialog(
    WxoaFanTagging,
    {
      accountId: fans[0]!.accountId,
      fanIds: fans.map((f) => f.id),
      // WeChat tag ids are numbered per account: only the fans' own account's tags may be offered
      tags: tags.value.filter((tag) => tag.accountId === fans[0]!.accountId),
    },
    { title: () => t('wxoa.fan.tagging.title') },
  )
  if (!saved) return
  ElMessage.success(t('wxoa.fan.tagging.done'))
  onTagsChanged()
}

const blocking = ref(false)
async function setBlocked(fans: WxoaFanVo[], blocked: boolean) {
  if (blocking.value || !fans.length) return
  const verb = blocked ? 'block' : 'unblock'
  try {
    await ElMessageBox.confirm(
      t(`wxoa.fan.${verb}.confirm`, { count: fans.length }),
      t('crud.confirm.title'),
      {
        type: 'warning',
        confirmButtonText: t(`wxoa.fan.${verb}.action`),
        cancelButtonText: t('common.action.cancel'),
      },
    )
  } catch {
    return
  }
  blocking.value = true
  try {
    await wxoaFanApi.blocking({
      accountId: fans[0]!.accountId,
      fanIds: fans.map((f) => f.id),
      blocked,
    })
    ElMessage.success(t(`wxoa.fan.${verb}.done`))
    await refresh()
  } catch (e) {
    toastRest(e)
  } finally {
    blocking.value = false
  }
}
</script>

<template>
  <div class="qw-page">
    <AccountSwitch />
    <div v-if="accountId != null" class="wxoa-fan">
      <WxoaTagPanel
        v-if="can.tags"
        :model-value="query.tagId"
        :account-id="accountId"
        :tags
        :loading="tagsLoading"
        @update:model-value="pickTag"
        @changed="onTagsChanged"
      />
      <div class="wxoa-fan__main">
        <el-card v-show="showSearch" class="qw-search-panel">
          <el-form :model="query" inline @submit.prevent="search">
            <el-form-item :label="t('field.wxoa.fan.openId')">
              <el-input v-model="query.openId" name="openId" clearable />
            </el-form-item>
            <el-form-item :label="t('field.wxoa.fan.remark')">
              <el-input v-model="query.remark" name="remark" clearable />
            </el-form-item>
            <el-form-item :label="t('field.wxoa.fan.subscribed')">
              <DictSelect v-model="query.subscribed" code="core.yes_no" />
            </el-form-item>
            <el-form-item :label="t('field.wxoa.fan.blocked')">
              <DictSelect v-model="query.blocked" code="core.yes_no" />
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
            table-id="wxoa.fan"
            :columns="columns"
            @refresh="refresh"
          >
            <el-button
              v-if="can.sync"
              type="primary"
              :loading="starting || syncRunning"
              @click="startSync"
            >
              <el-icon v-if="!starting && !syncRunning" class="el-icon--left">
                <Icon icon="lucide:refresh-cw" />
              </el-icon>
              {{ t('wxoa.fan.sync.action') }}
            </el-button>
            <el-button
              v-perm="perms.export"
              :loading="exporting"
              @click="exportXlsx(`${t('menu.wxoa.fan')}.xlsx`)"
            >
              <el-icon class="el-icon--left"><Icon icon="lucide:download" /></el-icon>
              {{ t('crud.action.export') }}
            </el-button>
            <template v-if="can.modify && selection.length">
              <el-button v-if="tags.length" @click="openTagging(selection)">
                {{ t('wxoa.fan.tagging.action') }}
              </el-button>
              <el-button :loading="blocking" @click="setBlocked(selection, true)">
                {{ t('wxoa.fan.block.action') }}
              </el-button>
              <el-button :loading="blocking" @click="setBlocked(selection, false)">
                {{ t('wxoa.fan.unblock.action') }}
              </el-button>
            </template>
            <span v-if="syncText" class="wxoa-fan__sync" role="status">
              {{ syncText }}
            </span>
          </TableToolbar>

          <QwTable
            table-id="wxoa.fan"
            :columns="columns"
            :data="rows"
            :loading="loading"
            :filtered
            selection
            :actions-width="180"
            @selection-change="onSelectionChange"
            @sort-change="onSortChange"
            @reset-filters="reset"
          >
            <template #cell-tagIds="{ row }">
              <el-tag v-for="id in row.tagIds" :key="id" class="wxoa-fan__tag" size="small">
                {{ tagName(id) }}
              </el-tag>
            </template>
            <template #cell-subscribed="{ row }">
              <DictTag code="core.yes_no" :value="row.subscribed" />
            </template>
            <template #cell-blocked="{ row }">
              <DictTag code="core.yes_no" :value="row.blocked" />
            </template>
            <template #cell-subscribedAt="{ row }">{{ time(row.subscribedAt) }}</template>
            <template #cell-lastInboundAt="{ row }">{{ time(row.lastInboundAt) }}</template>
            <template #cell-unsubscribedAt="{ row }">{{ time(row.unsubscribedAt) }}</template>
            <template #cell-syncedAt="{ row }">{{ time(row.syncedAt) }}</template>
            <template v-if="can.modify" #actions="{ row }">
              <el-button link type="primary" @click="openRemark(row)">
                {{ t('wxoa.fan.remark.action') }}
              </el-button>
              <el-button
                link
                :type="row.blocked ? 'primary' : 'danger'"
                @click="setBlocked([row], !row.blocked)"
              >
                {{ t(row.blocked ? 'wxoa.fan.unblock.action' : 'wxoa.fan.block.action') }}
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
      </div>
    </div>
  </div>
</template>

<style scoped>
.wxoa-fan {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}
.wxoa-fan__main {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}
.wxoa-fan__sync {
  align-self: center;
  font-size: 13px;
  color: var(--qw-text-2);
}
.wxoa-fan__tag + .wxoa-fan__tag {
  margin-left: 4px;
}
/* narrow screens: the tag panel stacks above the fans (its root carries this page's scope too) */
@media (max-width: 1100px) {
  .wxoa-fan {
    flex-direction: column;
    align-items: stretch;
  }
  .wxoa-fan > .wxoa-tags {
    width: auto;
  }
}
</style>
