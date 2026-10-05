<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import { ElMessage } from 'element-plus'
import { INBOX_CATEGORIES, type MyInboxItemVo } from '@qiwu/shared'
import { inboxMineApi } from '@/api/platform/messaging/inbox-mine'
import QwTable from '@/core/components/QwTable.vue'
import Pagination from '@/core/components/Pagination.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import { useCrudList } from '@/core/composables/use-crud'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { openDialog } from '@/core/dialog'
import { Icon } from '@/core/icons'
import { ApiError } from '@/core/request/http'
import { useNotifyStore } from '@/core/stores/notify'
import InboxMessageView from '@/core/layout/InboxMessageView.vue'

/**
 * My messages: the caller's inbox only (the server limits every query to user_id = me),
 * filtered by read state and category; a message opens as plain text and counts as read, "mark all as
 * read" reads the rest. Any signed-in user: a static route, like the personal center.
 */
defineOptions({ name: 'MyInbox' })
const { t } = useI18n()
const notify = useNotifyStore()
const { query, rows, total, loading, filtered, search, reset, refresh, onSortChange } = useCrudList(
  {
    api: inboxMineApi,
    filters: { unread: '', category: '' },
    sort: '-createdAt,-id',
  },
)
void notify.loadInbox()
const showSearch = ref(true)
const opening = ref(false)
const readingAll = ref(false)
const columns: QwColumn[] = [
  { prop: 'readAt', label: 'notify.inbox.state', width: 110 },
  { prop: 'title', label: 'notify.inbox.title', minWidth: 220, showOverflowTooltip: true },
  { prop: 'category', label: 'notify.inbox.categoryLabel', width: 130 },
  { prop: 'senderLabel', label: 'notify.inbox.sender', width: 150, showOverflowTooltip: true },
  { prop: 'createdAt', label: 'notify.inbox.receivedAt', width: 180, sortable: true },
]

async function view(row: MyInboxItemVo) {
  if (opening.value) return
  opening.value = true
  try {
    const message = await inboxMineApi.get(row.id)
    void openDialog(InboxMessageView, { message }, { title: message.title, width: '720px' })
    if (!row.readAt) {
      await notify.readInbox(row.id)
      rows.value = rows.value.map((item) =>
        item.id === row.id ? { ...item, readAt: new Date().toISOString() } : item,
      )
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) ElMessage.error(e.message)
    void refresh()
  } finally {
    opening.value = false
  }
}

async function readAll() {
  if (readingAll.value) return
  readingAll.value = true
  try {
    await notify.readAllInbox()
    await refresh()
  } catch {
    // request layer shows the error
  } finally {
    readingAll.value = false
  }
}
</script>

<template>
  <div class="qw-page">
    <div class="qw-page-bar">
      <el-button :loading="readingAll" :disabled="!notify.inboxUnread" @click="readAll">
        {{ t('notify.bell.readAll') }}
      </el-button>
    </div>
    <el-card v-show="showSearch" class="qw-search-panel">
      <el-form :model="query" inline @submit.prevent="search">
        <el-form-item :label="t('notify.inbox.readFilter')">
          <el-select v-model="query.unread" :aria-label="t('notify.inbox.readFilter')">
            <el-option :label="t('notify.inbox.all')" value="" />
            <el-option :label="t('notify.inbox.unreadOnly')" value="true" />
          </el-select>
        </el-form-item>
        <el-form-item :label="t('notify.inbox.categoryLabel')">
          <el-select v-model="query.category" :aria-label="t('notify.inbox.categoryLabel')">
            <el-option :label="t('notify.inbox.all')" value="" />
            <el-option
              v-for="category in INBOX_CATEGORIES"
              :key="category"
              :label="t(`notify.inbox.category.${category}`)"
              :value="category"
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
        table-id="messaging.inboxMine"
        :columns="columns"
        @refresh="refresh"
      />
      <QwTable
        table-id="messaging.inboxMine"
        :columns="columns"
        :data="rows"
        :loading="loading"
        :filtered
        @sort-change="onSortChange"
        @reset-filters="reset"
      >
        <template #cell-readAt="{ row }">
          <span class="inbox-state" :class="{ 'is-unread': !row.readAt }">
            {{ t(row.readAt ? 'notify.inbox.read' : 'notify.inbox.unread') }}
          </span>
        </template>
        <template #cell-category="{ row }">{{
          t(`notify.inbox.category.${row.category}`)
        }}</template>
        <template #cell-senderLabel="{ row }">{{
          row.senderLabel || t('notify.inbox.systemSender')
        }}</template>
        <template #cell-createdAt="{ row }">{{
          dayjs(row.createdAt).format('YYYY-MM-DD HH:mm')
        }}</template>
        <template #actions="{ row }">
          <el-button link type="primary" :disabled="opening" @click="view(row)">
            {{ t('notify.inbox.view') }}
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
</template>

<style scoped>
.inbox-state {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  padding: 2px 10px;
  border-radius: 999px;
  color: var(--qw-neutral);
  background: var(--qw-neutral-weak);
}
.inbox-state::before {
  width: 6px;
  height: 6px;
  content: '';
  background: currentcolor;
  border-radius: 50%;
}
.inbox-state.is-unread {
  color: var(--qw-brand-text);
  background: var(--qw-brand-weak);
}
</style>
