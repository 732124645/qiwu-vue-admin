<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import dayjs from 'dayjs'
import { wxoaPerms, type WxoaPublishVo } from '@qiwu/shared'
import type { WxoaDraftVo } from '@/api/platform/wxoa/draft'
import { wxoaPublishApi } from '@/api/platform/wxoa/publish'
import DictTag from '@/core/components/DictTag.vue'
import Pagination from '@/core/components/Pagination.vue'
import QwTable from '@/core/components/QwTable.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import EmptyState from '@/core/components/EmptyState.vue'
import { useCrudList, toastRest } from '@/core/composables/use-crud'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { openDialog } from '@/core/dialog'
import { usePerm } from '@/core/permission'
import AccountSwitch from '../components/AccountSwitch.vue'
import { useWxoaAccount } from '../components/use-wxoa-account'
import VerifiedHint from '../components/VerifiedHint.vue'
import DraftPicker from '../draft/DraftPicker.vue'
import { publishDraft } from '../draft/publish-draft'

/**
 * 发表记录：提交发布已同步的草稿、从微信拉取记录、删除已发表文章。文章留言不在这里：微信的留言
 * 接口只认群发返回的 msg_data_id，发布的文章没有它，留言从群发记录打开。
 */
defineOptions({ name: 'WxoaPublish' })
const { t } = useI18n()
const perms = wxoaPerms.publish
const perm = usePerm()
const { accountId } = useWxoaAccount()
const can = computed(() => ({
  create: perm.has(perms.create),
  remove: perm.has(perms.remove),
  commentBrowse: perm.has(wxoaPerms.comment.browse),
}))
const { query, rows, total, loading, refresh } = useCrudList({
  api: {
    page: (params: Record<string, unknown>) =>
      accountId.value == null
        ? Promise.resolve({ items: [], total: 0 })
        : wxoaPublishApi.page({ ...params, accountId: accountId.value }),
  },
  filters: {},
  sort: '-createdAt',
})
const columns: QwColumn[] = [
  { prop: 'title', label: 'wxoa.publish.col.title', minWidth: 240, showOverflowTooltip: true },
  { prop: 'publishState', label: 'wxoa.publish.col.state', width: 140 },
  {
    prop: 'publishId',
    label: 'wxoa.publish.col.publishId',
    minWidth: 180,
    showOverflowTooltip: true,
  },
  {
    prop: 'articleId',
    label: 'wxoa.publish.col.articleId',
    minWidth: 180,
    showOverflowTooltip: true,
  },
  { prop: 'articleUrls', label: 'wxoa.publish.col.articleUrls', minWidth: 200 },
  { prop: 'finishedAt', label: 'wxoa.publish.col.finishedAt', width: 180 },
]
const syncLoading = ref(false)
const displayDate = (value: string | null) => (value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '')
/** 只把 http(s) 链接渲染成可点的地址，别的协议不进 href */
const safeUrl = (url: string) => /^https?:\/\//i.test(url)
/** 正在删除的行（`remove:<id>`），对应按钮加载、其余删除按钮禁用 */
const acting = ref('')
const publishing = ref(false)
/** 选一份已同步的草稿，确认后提交发布。 */
async function publish() {
  const id = accountId.value
  if (id == null || publishing.value) return
  const draft = await openDialog<WxoaDraftVo>(
    DraftPicker,
    { accountId: id },
    { title: () => t('wxoa.publish.create.pick'), width: '640px' },
  )
  if (!draft) return
  publishing.value = true
  try {
    if (await publishDraft(id, draft)) await refresh()
  } finally {
    publishing.value = false
  }
}
async function pull() {
  if (accountId.value == null || syncLoading.value) return
  syncLoading.value = true
  try {
    await wxoaPublishApi.pull(accountId.value)
    ElMessage.success(t('wxoa.publish.pull.done'))
    await refresh()
  } catch (e) {
    toastRest(e)
  } finally {
    syncLoading.value = false
  }
}
async function remove(row: WxoaPublishVo) {
  if (acting.value) return
  try {
    await ElMessageBox.confirm(
      t('wxoa.publish.removeConfirm', { title: row.title }),
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
  acting.value = `remove:${row.id}`
  try {
    await wxoaPublishApi.remove(row.id)
    ElMessage.success(t('crud.msg.deleted'))
    await refresh()
  } catch (e) {
    toastRest(e)
  } finally {
    acting.value = ''
  }
}
watch(accountId, () => {
  rows.value = []
  total.value = 0
  void refresh()
})
</script>

<template>
  <div class="qw-page wxoa-publish-page">
    <AccountSwitch />
    <template v-if="accountId != null">
      <VerifiedHint />
      <el-alert
        v-if="can.commentBrowse"
        class="wxoa-publish__hint"
        type="info"
        :closable="false"
        show-icon
        :title="t('wxoa.publish.commentsHint')"
      />
      <el-card class="qw-table-panel">
        <TableToolbar
          table-id="wxoa.publish"
          :columns="columns"
          :searchable="false"
          @refresh="refresh"
        >
          <el-button v-if="can.create" type="primary" :loading="publishing" @click="publish">{{
            t('wxoa.publish.create.action')
          }}</el-button>
          <el-button v-if="can.create" :loading="syncLoading" @click="pull">{{
            t('wxoa.publish.pull.action')
          }}</el-button>
        </TableToolbar>
        <QwTable
          table-id="wxoa.publish"
          :columns="columns"
          :data="rows"
          :loading="loading"
          :actions-width="120"
        >
          <template #cell-publishState="{ row }"
            ><DictTag code="wxoa.publish_state" :value="row.publishState"
          /></template>
          <template #cell-articleUrls="{ row }">
            <div class="wxoa-publish__urls">
              <template v-for="(url, i) in row.articleUrls ?? []" :key="i">
                <el-link
                  v-if="safeUrl(url)"
                  :href="url"
                  target="_blank"
                  rel="noopener noreferrer"
                  type="primary"
                  >{{ t('wxoa.publish.articleLink', { n: i + 1 }) }}</el-link
                >
              </template>
            </div>
          </template>
          <template #cell-finishedAt="{ row }">{{ displayDate(row.finishedAt) }}</template>
          <template #actions="{ row }">
            <el-button
              v-if="can.remove"
              link
              type="danger"
              :loading="acting === `remove:${row.id}`"
              :disabled="!!acting && acting !== `remove:${row.id}`"
              @click="remove(row)"
              >{{ t('crud.action.delete') }}</el-button
            >
          </template>
          <template #empty><EmptyState :description="t('wxoa.publish.empty')" /></template>
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
.wxoa-publish__urls {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.wxoa-publish__hint {
  margin-bottom: 16px;
}
</style>
