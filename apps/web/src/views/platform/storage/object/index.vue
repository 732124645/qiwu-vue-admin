<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import { ElMessage, ElMessageBox, type UploadRequestOptions } from 'element-plus'
import { STORAGE_BIZ_TAGS, storageObjectPerms, type FsObjectRowVo } from '@qiwu/shared'
import { storageApi } from '@/api/platform/storage/object'
import DictSelect from '@/core/components/DictSelect.vue'
import DictTag from '@/core/components/DictTag.vue'
import QwTable from '@/core/components/QwTable.vue'
import Pagination from '@/core/components/Pagination.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import { useCrudList } from '@/core/composables/use-crud'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { formatSize, isImage, toastUploadError } from '@/core/composables/use-upload'
import { refName, tx } from '@/core/i18n'
import { Icon } from '@/core/icons'

/**
 * File list (see docs/design-notes.md#storage): every stored object, newest first. A name opens the file (public:
 * its URL; private: downloaded with the token), images preview (private ones through `fetchBlob`), public
 * objects' links copy, uploads go in as private attachments. A deleted file stops being served at once, its
 * stored copy is purged after the retention period (`audit.purge`); nothing records where a file is
 * used, so the confirmation warns that links to it may break.
 */
// keep-alive name = the seeded menu's component_name
defineOptions({ name: 'StorageObject' })

const { t, te } = useI18n()
const {
  query,
  rows,
  total,
  loading,
  filtered,
  search,
  reset,
  refresh,
  onSortChange,
  exporting,
  exportXlsx,
} = useCrudList({
  // deletes go through `remove` below: one object at a time, with its own warning
  api: { page: storageApi.page, exportFile: storageApi.exportFile },
  filters: {
    originalName: '',
    bizTag: null as string | null,
    isPublic: null as string | null,
    createdAtRange: null as [string, string] | null,
  },
  sort: '-createdAt',
})
const showSearch = ref(true)
const columns: QwColumn[] = [
  {
    prop: 'originalName',
    label: 'field.storage.object.originalName',
    minWidth: 200,
    showOverflowTooltip: true,
  },
  { prop: 'mime', label: 'field.storage.object.mime', width: 160, showOverflowTooltip: true },
  {
    prop: 'size',
    label: 'field.storage.object.size',
    sortable: true,
    width: 120,
    align: 'right',
  },
  { prop: 'bizTag', label: 'field.storage.object.bizTag', width: 120 },
  { prop: 'isPublic', label: 'field.storage.object.isPublic', width: 110 },
  {
    prop: 'storageName',
    label: 'field.storage.object.storageId',
    width: 140,
    showOverflowTooltip: true,
  },
  {
    prop: 'uploaderName',
    label: 'storage.object.uploader',
    width: 130,
    showOverflowTooltip: true,
  },
  { prop: 'createdAt', label: 'storage.object.uploadedAt', sortable: true, width: 160 },
]

/** the tag's name; one this page does not know (a later module's) as it is */
const tagLabel = (tag: string) =>
  te(`storage.object.tag.${tag}`) ? t(`storage.object.tag.${tag}`) : tag

// uploads from the list: private attachments, through the server (sniffed and whitelisted there)
const uploading = ref(0)
async function send({ file }: UploadRequestOptions) {
  uploading.value++
  try {
    await storageApi.upload(file, 'attachment')
    ElMessage.success(t('storage.object.uploaded', { name: file.name }))
  } catch (e) {
    toastUploadError(e)
  } finally {
    uploading.value--
    await refresh()
  }
}

async function copyLink(row: FsObjectRowVo) {
  if (!row.url) return
  try {
    await navigator.clipboard.writeText(new URL(row.url, location.origin).href)
    ElMessage.success(t('storage.object.copied'))
  } catch {
    ElMessage.error(t('storage.object.copyFailed'))
  }
}

// the image viewer: a public image by its URL, a private one as an object URL (revoked on close)
const preview = ref('')
const loadingPreview = reactive(new Set<number>())
async function openPreview(row: FsObjectRowVo) {
  if (row.url) {
    preview.value = row.url
    return
  }
  if (loadingPreview.has(row.id)) return
  loadingPreview.add(row.id)
  try {
    // failures are toasted by the request layer (403 without access)
    const blob = await storageApi.blob(row.id).catch(() => null)
    if (blob) preview.value = URL.createObjectURL(blob)
  } finally {
    loadingPreview.delete(row.id)
  }
}
function closePreview() {
  if (preview.value.startsWith('blob:')) URL.revokeObjectURL(preview.value)
  preview.value = ''
}

const deleting = reactive(new Set<number>())
async function remove(row: FsObjectRowVo) {
  try {
    await ElMessageBox.confirm(
      t('storage.object.deleteConfirm', { name: row.originalName }),
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
  deleting.add(row.id)
  try {
    await storageApi.remove(row.id)
    ElMessage.success(t('crud.msg.deleted'))
  } catch (e) {
    // 403/409/422/429/5xx are toasted by the request layer; a row deleted meanwhile answers 404
    toastUploadError(e)
  } finally {
    deleting.delete(row.id)
    await refresh()
  }
}
</script>

<template>
  <div class="qw-page">
    <el-card v-show="showSearch" class="qw-search-panel">
      <el-form :model="query" inline @submit.prevent="search">
        <el-form-item :label="t('field.storage.object.originalName')">
          <el-input v-model="query.originalName" name="originalName" clearable />
        </el-form-item>
        <el-form-item :label="t('field.storage.object.bizTag')">
          <el-select v-model="query.bizTag" clearable>
            <el-option
              v-for="tag in STORAGE_BIZ_TAGS"
              :key="tag"
              :label="tagLabel(tag)"
              :value="tag"
            />
          </el-select>
        </el-form-item>
        <el-form-item :label="t('field.storage.object.isPublic')">
          <DictSelect v-model="query.isPublic" code="core.yes_no" />
        </el-form-item>
        <el-form-item :label="t('storage.object.uploadedAt')" class="qw-search-wide">
          <el-date-picker
            v-model="query.createdAtRange"
            type="daterange"
            value-format="YYYY-MM-DD"
            :start-placeholder="t('field.storage.object.createdAtFrom')"
            :end-placeholder="t('field.storage.object.createdAtTo')"
          />
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
        table-id="storage.object"
        :columns="columns"
        @refresh="refresh"
      >
        <el-upload :show-file-list="false" multiple :http-request="send">
          <el-button type="primary" :loading="uploading > 0">
            <el-icon class="el-icon--left"><Icon icon="lucide:upload" /></el-icon>
            {{ t('upload.action.upload') }}
          </el-button>
        </el-upload>
        <el-button
          v-perm="storageObjectPerms.export"
          :loading="exporting"
          @click="exportXlsx(`${t('menu.storage.object')}.xlsx`)"
        >
          <el-icon class="el-icon--left"><Icon icon="lucide:download" /></el-icon>
          {{ t('crud.action.export') }}
        </el-button>
      </TableToolbar>

      <QwTable
        table-id="storage.object"
        :columns="columns"
        :actions-width="200"
        :data="rows"
        :loading="loading"
        :filtered
        @sort-change="onSortChange"
        @reset-filters="reset"
      >
        <template #cell-originalName="{ row }">
          <el-link
            v-if="row.url"
            type="primary"
            :href="row.url"
            target="_blank"
            rel="noopener"
            underline="never"
          >
            {{ row.originalName }}
          </el-link>
          <el-button
            v-else
            link
            type="primary"
            class="qw-cell-link"
            @click="storageApi.download(row)"
          >
            {{ row.originalName }}
          </el-button>
        </template>
        <template #cell-size="{ row }">{{ formatSize(row.size) }}</template>
        <template #cell-bizTag="{ row }">{{ tagLabel(row.bizTag) }}</template>
        <template #cell-isPublic="{ row }">
          <DictTag code="core.yes_no" :value="row.isPublic" />
        </template>
        <template #cell-storageName="{ row }">{{ tx(row.storageName) }}</template>
        <template #cell-uploaderName="{ row }">{{
          refName(row.uploaderId, row.uploaderName)
        }}</template>
        <template #cell-createdAt="{ row }">{{
          dayjs(row.createdAt).format('YYYY-MM-DD HH:mm')
        }}</template>
        <template #actions="{ row }">
          <el-button
            v-if="isImage(row.mime)"
            link
            type="primary"
            :loading="loadingPreview.has(row.id)"
            @click="openPreview(row)"
          >
            {{ t('storage.object.preview') }}
          </el-button>
          <el-button v-if="row.url" link type="primary" @click="copyLink(row)">
            {{ t('storage.object.copyLink') }}
          </el-button>
          <el-button
            v-perm="storageObjectPerms.remove"
            link
            type="danger"
            :loading="deleting.has(row.id)"
            @click="remove(row)"
          >
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

    <el-image-viewer
      v-if="preview"
      :url-list="[preview]"
      hide-on-click-modal
      teleported
      @close="closePreview"
    />
  </div>
</template>
