<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import { ElMessage, ElMessageBox } from 'element-plus'
import { wxoaPerms, type Page, type WxoaQrcodeVo, type WxoaTagVo } from '@qiwu/shared'
import { storageApi } from '@/api/platform/storage/object'
import { wxoaQrcodeApi } from '@/api/platform/wxoa/qrcode'
import { wxoaTagApi } from '@/api/platform/wxoa/tag'
import DictSelect from '@/core/components/DictSelect.vue'
import DictTag from '@/core/components/DictTag.vue'
import Pagination from '@/core/components/Pagination.vue'
import QwTable from '@/core/components/QwTable.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import { toastRest, useCrudList } from '@/core/composables/use-crud'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { openDialog } from '@/core/dialog'
import { Icon } from '@/core/icons'
import { usePerm } from '@/core/permission'
import { saveBlob } from '@/core/request/http'
import AccountSwitch from '../components/AccountSwitch.vue'
import { useWxoaAccount } from '../components/use-wxoa-account'
import WxoaMediaImage from '../components/WxoaMediaImage.vue'
import WxoaQrcodeForm from './form.vue'
import WxoaQrcodeStats from './stats.vue'

/**
 * Channel QR codes of the chosen account (see docs/design-notes.md#wxoa): the image copy (preview and
 * download; a code without one shows a placeholder), scan and subscribe counts, daily stats, creating
 * one on WeChat with an optional auto tag, renaming or changing the tag, and deleting it here only (a
 * permanent code keeps working on WeChat).
 */
// keep-alive name = the seeded menu's component_name
defineOptions({ name: 'WxoaQrcode' })

const { t } = useI18n()
const perms = wxoaPerms.qrcode
const perm = usePerm()
const canModify = computed(() => perm.has(perms.modify))
const canTags = computed(() => perm.has(wxoaPerms.tag.browse))
const { accountId } = useWxoaAccount()

const { query, rows, total, loading, filtered, search, reset, refresh, onSortChange } = useCrudList(
  {
    api: {
      // none chosen yet: nothing to load
      page: async (params: Record<string, unknown>): Promise<Page<WxoaQrcodeVo>> =>
        accountId.value == null
          ? { items: [], total: 0 }
          : wxoaQrcodeApi.page({ ...params, accountId: accountId.value }),
    },
    filters: { label: '', qrKind: null as string | null },
    sort: '-createdAt',
  },
)
const showSearch = ref(true)
const columns: QwColumn[] = [
  { prop: 'image', label: 'wxoa.qrcode.col.image', width: 96 },
  { prop: 'label', label: 'field.wxoa.qrcode.label', minWidth: 160, showOverflowTooltip: true },
  { prop: 'qrKind', label: 'field.wxoa.qrcode.qrKind', width: 120 },
  { prop: 'scene', label: 'field.wxoa.qrcode.scene', minWidth: 160, showOverflowTooltip: true },
  { prop: 'tagId', label: 'field.wxoa.qrcode.tagId', width: 140 },
  { prop: 'scanCount', label: 'wxoa.qrcode.col.scanCount', sortable: true, width: 110 },
  { prop: 'subscribeCount', label: 'wxoa.qrcode.col.subscribeCount', sortable: true, width: 120 },
  { prop: 'expiresAt', label: 'wxoa.qrcode.col.expiresAt', width: 160 },
  { prop: 'createdAt', label: 'field.common.createdAt', sortable: true, width: 160 },
  { prop: 'qrUrl', label: 'wxoa.qrcode.col.qrUrl', minWidth: 240, hidden: true },
]
const time = (iso: string) => dayjs(iso).format('YYYY-MM-DD HH:mm')
const expired = (q: WxoaQrcodeVo) => q.expiresAt != null && dayjs(q.expiresAt).isBefore(dayjs())

// the account's tags: the auto tag's name, and what the form offers
const tags = shallowRef<WxoaTagVo[] | null>(null)
let tagSeq = 0
async function loadTags() {
  const id = accountId.value
  const mine = ++tagSeq
  tags.value = null
  if (id == null || !canTags.value) return
  const list = await wxoaTagApi.list(id).catch(() => null)
  if (mine === tagSeq) tags.value = list
}
const tagNames = computed(() => new Map(tags.value?.map((tag) => [tag.tagId, tag.name])))
const tagName = (tagId: number) => tagNames.value.get(tagId) ?? `#${tagId}`

watch(accountId, () => {
  // nothing of the previous account stays on screen, even if the new list fails to load
  rows.value = []
  total.value = 0
  void loadTags()
  void search()
})
void loadTags()

/** Create (no row) or rename / retag in the form dialog; reload once saved. */
async function openForm(row?: WxoaQrcodeVo) {
  const owner = row?.accountId ?? accountId.value
  if (owner == null) return
  const saved = await openDialog(
    WxoaQrcodeForm,
    {
      accountId: owner,
      row: row ?? null,
      // tag ids are numbered per account: only the code's own account's tags
      tags: tags.value?.filter((tag) => tag.accountId === owner) ?? null,
    },
    {
      title: () =>
        t(row ? 'crud.title.edit' : 'crud.title.create', { name: t('wxoa.qrcode.entity') }),
      width: 600,
    },
  )
  if (!saved) return
  ElMessage.success(t(row ? 'crud.msg.updated' : 'crud.msg.created'))
  await refresh()
}

function openStats(row: WxoaQrcodeVo) {
  void openDialog(
    WxoaQrcodeStats,
    { id: row.id, label: row.label },
    { title: () => t('wxoa.qrcode.stats.title', { name: row.label }), width: 760 },
  )
}

const IMAGE_EXT = /^image\/(png|gif|bmp)$/
/** saves the image copy, named after the scene */
async function downloadImage(row: WxoaQrcodeVo) {
  if (row.objectId == null) return
  try {
    const blob = await storageApi.blob(row.objectId)
    saveBlob(blob, `qrcode-${row.scene}.${IMAGE_EXT.exec(blob.type)?.[1] ?? 'jpg'}`)
  } catch (e) {
    toastRest(e)
  }
}

async function remove(row: WxoaQrcodeVo) {
  try {
    await ElMessageBox.confirm(
      t(`wxoa.qrcode.removeConfirm.${row.qrKind}`, { name: row.label }),
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
    await wxoaQrcodeApi.remove(row.id)
  } catch (e) {
    toastRest(e)
    return
  }
  ElMessage.success(t('crud.msg.deleted'))
  await refresh()
}
</script>

<template>
  <div class="qw-page">
    <AccountSwitch />
    <template v-if="accountId != null">
      <el-card v-show="showSearch" class="qw-search-panel">
        <el-form :model="query" inline @submit.prevent="search">
          <el-form-item :label="t('field.wxoa.qrcode.label')">
            <el-input v-model="query.label" name="label" clearable />
          </el-form-item>
          <el-form-item :label="t('field.wxoa.qrcode.qrKind')">
            <DictSelect v-model="query.qrKind" code="wxoa.qr_kind" />
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
          table-id="wxoa.qrcode"
          :columns="columns"
          @refresh="refresh"
        >
          <el-button v-perm="perms.create" type="primary" @click="openForm()">
            <el-icon class="el-icon--left"><Icon icon="lucide:plus" /></el-icon>
            {{ t('crud.action.create') }}
          </el-button>
        </TableToolbar>
        <QwTable
          table-id="wxoa.qrcode"
          :columns="columns"
          :data="rows"
          :loading="loading"
          :filtered
          :actions-width="220"
          @sort-change="onSortChange"
          @reset-filters="reset"
        >
          <!-- el-table also renders cell slots with an empty row while collecting its columns -->
          <template #cell-image="{ row }">
            <WxoaMediaImage v-if="row.id" :object-id="row.objectId" :alt="row.label" preview />
          </template>
          <template #cell-qrKind="{ row }">
            <DictTag code="wxoa.qr_kind" :value="row.qrKind" />
          </template>
          <template #cell-scene="{ row }">
            <code class="wxoa-qrcode__scene">{{ row.scene }}</code>
          </template>
          <template #cell-tagId="{ row }">
            <el-tag v-if="row.tagId != null" size="small">{{ tagName(row.tagId) }}</el-tag>
          </template>
          <template #cell-expiresAt="{ row }">
            <template v-if="row.expiresAt">
              <span :class="{ 'wxoa-qrcode__expired': expired(row) }">
                {{ time(row.expiresAt) }}
              </span>
              <el-tag v-if="expired(row)" size="small" type="info" class="wxoa-qrcode__badge">
                {{ t('wxoa.qrcode.expired') }}
              </el-tag>
            </template>
            <span v-else-if="row.id" class="wxoa-qrcode__muted">{{ t('wxoa.qrcode.never') }}</span>
          </template>
          <template #cell-createdAt="{ row }">{{ row.createdAt && time(row.createdAt) }}</template>
          <template #actions="{ row }">
            <el-button link type="primary" @click="openStats(row)">
              {{ t('wxoa.qrcode.stats.action') }}
            </el-button>
            <el-button v-if="row.objectId != null" link type="primary" @click="downloadImage(row)">
              {{ t('wxoa.qrcode.download') }}
            </el-button>
            <el-button v-if="canModify" link type="primary" @click="openForm(row)">
              {{ t('crud.action.edit') }}
            </el-button>
            <el-button v-perm="perms.remove" link type="danger" @click="remove(row)">
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
.wxoa-qrcode__scene {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  word-break: break-all;
}
.wxoa-qrcode__expired,
.wxoa-qrcode__muted {
  color: var(--qw-text-3);
}
.wxoa-qrcode__badge {
  margin-left: 4px;
}
</style>
