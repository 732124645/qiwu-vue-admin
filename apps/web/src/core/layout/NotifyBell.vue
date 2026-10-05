<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import dayjs from 'dayjs'
import { ElMessage } from 'element-plus'
import { useDocumentVisibility, useEventListener, useIntervalFn } from '@vueuse/core'
import { type BulletinFeedItem, type MyInboxItemVo, RT } from '@qiwu/shared'
import { bulletinFeedApi } from '@/api/platform/messaging/bulletin-feed'
import { inboxMineApi } from '@/api/platform/messaging/inbox-mine'
import DictTag from '@/core/components/DictTag.vue'
import IconButton from '@/core/components/IconButton.vue'
import { openDialog } from '@/core/dialog'
import { onRealtime, realtimeUp } from '@/core/realtime/socket'
import { ApiError } from '@/core/request/http'
import { useNotifyStore } from '@/core/stores/notify'
import BulletinView from './BulletinView.vue'
import InboxMessageView from './InboxMessageView.vue'

/**
 * Header bell (see docs/design-notes.md#layering): the unread count of published bulletins plus inbox messages as a
 * badge, the latest of each in two tabs; state lives in the `notify` store. An item opens in a dialog and
 * counts as read; "mark all as read" reads the active tab. Bulletins reload on every `notify:bulletin`
 * push, a `notify:new` push counts one more message at once; both reload when the socket comes
 * back, on window focus and when the dropdown opens, and every minute while the socket is down (tab
 * visible).
 */
defineOptions({ name: 'NotifyBell' })
const POLL_MS = 60_000
const { t } = useI18n()
const router = useRouter()
const notify = useNotifyStore()
const open = ref(false)
const tab = ref<'bulletins' | 'inbox'>('bulletins')
const opening = ref(false)
const readingAll = ref(false)

void notify.load()
const visibility = useDocumentVisibility()
useIntervalFn(() => {
  if (!realtimeUp.value && visibility.value === 'visible') void notify.load()
}, POLL_MS)
onRealtime(RT.notifyBulletin, () => void notify.loadBulletins())
onRealtime(RT.notifyNew, (payload) => notify.onInboxNew(payload))
watch(realtimeUp, (up) => up && void notify.load())
useEventListener(window, 'focus', () => void notify.load())
watch(open, (shown) => {
  if (!shown) return
  tab.value = notify.bulletinUnread ? 'bulletins' : notify.inboxUnread ? 'inbox' : 'bulletins'
  void notify.load()
})

async function showBulletin(item: BulletinFeedItem) {
  if (opening.value) return
  opening.value = true
  open.value = false
  try {
    const bulletin = await bulletinFeedApi.get(item.id)
    void openDialog(BulletinView, { bulletin }, { title: bulletin.title, width: '720px' })
    if (!item.read) await notify.readBulletin(item.id)
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) ElMessage.error(e.message)
    void notify.loadBulletins()
  } finally {
    opening.value = false
  }
}

async function showInbox(item: MyInboxItemVo) {
  if (opening.value) return
  opening.value = true
  open.value = false
  try {
    const message = await inboxMineApi.get(item.id)
    void openDialog(InboxMessageView, { message }, { title: message.title, width: '720px' })
    if (!item.readAt) await notify.readInbox(item.id)
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) ElMessage.error(e.message)
    void notify.loadInbox()
  } finally {
    opening.value = false
  }
}

async function readAll() {
  if (readingAll.value) return
  readingAll.value = true
  try {
    if (tab.value === 'bulletins') await notify.readAllBulletins()
    else await notify.readAllInbox()
  } catch {
    // the request layer shows non-404 failures
  } finally {
    readingAll.value = false
  }
}

function viewAll() {
  open.value = false
  void router.push({ name: 'my-inbox' })
}

const activeUnread = computed(() =>
  tab.value === 'bulletins' ? notify.bulletinUnread : notify.inboxUnread,
)
const label = computed(() =>
  notify.unread ? t('notify.bell.labelUnread', { count: notify.unread }) : t('notify.bell.label'),
)
</script>

<template>
  <el-popover v-model:visible="open" trigger="click" placement="bottom-end" :width="360">
    <template #reference>
      <span class="notify-bell">
        <el-badge
          :value="notify.unread"
          :max="99"
          :hidden="!notify.unread"
          class="notify-bell__badge"
        >
          <IconButton icon="lucide:bell" :label="label" :aria-expanded="open" />
        </el-badge>
      </span>
    </template>
    <section class="notify-bell__panel" :aria-label="t('notify.bell.label')">
      <header class="notify-bell__head">
        <span class="notify-bell__heading">{{ t('notify.bell.label') }}</span>
        <el-button
          link
          type="primary"
          :disabled="!activeUnread"
          :loading="readingAll"
          class="notify-bell__read-all"
          @click="readAll"
        >
          {{ t('notify.bell.readAll') }}
        </el-button>
      </header>
      <el-tabs v-model="tab" class="notify-bell__tabs">
        <el-tab-pane name="bulletins">
          <template #label>
            {{ t('notify.tabs.bulletins') }}
            <span v-if="notify.bulletinUnread" class="notify-bell__count">{{
              notify.bulletinUnread
            }}</span>
          </template>
          <ul v-if="notify.bulletins.length" class="notify-bell__list">
            <li v-for="item in notify.bulletins" :key="item.id">
              <button
                type="button"
                class="notify-bell__item"
                :class="{ 'is-unread': !item.read }"
                :disabled="opening"
                @click="showBulletin(item)"
              >
                <span
                  class="notify-bell__dot"
                  :role="item.read ? undefined : 'img'"
                  :aria-label="item.read ? undefined : t('notify.bell.unreadMark')"
                />
                <span class="notify-bell__text">
                  <span class="notify-bell__title">{{ item.title }}</span>
                  <span class="notify-bell__meta">
                    <DictTag code="messaging.bulletin_kind" :value="item.kind" />
                    <time :datetime="item.publishedAt">{{
                      dayjs(item.publishedAt).format('YYYY-MM-DD HH:mm')
                    }}</time>
                  </span>
                </span>
              </button>
            </li>
          </ul>
          <p v-else class="notify-bell__empty">{{ t('notify.bell.empty') }}</p>
        </el-tab-pane>
        <el-tab-pane name="inbox">
          <template #label>
            {{ t('notify.tabs.inbox') }}
            <span v-if="notify.inboxUnread" class="notify-bell__count">{{
              notify.inboxUnread
            }}</span>
          </template>
          <ul v-if="notify.inbox.length" class="notify-bell__list">
            <li v-for="item in notify.inbox" :key="item.id">
              <button
                type="button"
                class="notify-bell__item"
                :class="{ 'is-unread': !item.readAt }"
                :disabled="opening"
                @click="showInbox(item)"
              >
                <span
                  class="notify-bell__dot"
                  :role="item.readAt ? undefined : 'img'"
                  :aria-label="item.readAt ? undefined : t('notify.bell.unreadMark')"
                />
                <span class="notify-bell__text">
                  <span class="notify-bell__title">{{ item.title }}</span>
                  <span class="notify-bell__meta">
                    <span>{{ item.senderLabel || t('notify.inbox.systemSender') }}</span>
                    <time :datetime="item.createdAt">{{
                      dayjs(item.createdAt).format('YYYY-MM-DD HH:mm')
                    }}</time>
                  </span>
                </span>
              </button>
            </li>
          </ul>
          <p v-else class="notify-bell__empty">{{ t('notify.inbox.empty') }}</p>
          <el-button link type="primary" class="notify-bell__view-all" @click="viewAll">
            {{ t('notify.inbox.viewAll') }}
          </el-button>
        </el-tab-pane>
      </el-tabs>
    </section>
  </el-popover>
</template>
<style scoped>
.notify-bell {
  display: inline-flex;
  flex: none;
}
.notify-bell__badge :deep(.el-badge__content) {
  top: 6px;
  right: 8px;
}
.notify-bell__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 4px 8px;
  border-bottom: 1px solid var(--qw-border);
}
.notify-bell__count {
  display: inline-block;
  min-width: 18px;
  margin-left: 4px;
  padding: 0 5px;
  font-size: 12px;
  line-height: 18px;
  text-align: center;
  color: var(--qw-brand-text);
  background: var(--qw-brand-weak);
  border-radius: 9px;
}
.notify-bell__heading {
  font-weight: 650;
  color: var(--qw-text);
}
.notify-bell__list {
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
}
.notify-bell__item {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  width: 100%;
  padding: 10px 8px;
  font: inherit;
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: var(--qw-radius-sm);
  transition: background-color 0.15s;
}
.notify-bell__item:hover:not(:disabled) {
  background: var(--qw-surface-2);
}
.notify-bell__item:disabled {
  cursor: wait;
}
.notify-bell__dot {
  flex: none;
  width: 8px;
  height: 8px;
  margin-top: 7px;
  border-radius: 50%;
}
.notify-bell__item.is-unread .notify-bell__dot {
  background: var(--qw-danger);
}
.notify-bell__text {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.notify-bell__title {
  overflow: hidden;
  color: var(--qw-text-2);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.notify-bell__item.is-unread .notify-bell__title {
  font-weight: 600;
  color: var(--qw-text);
}
.notify-bell__meta {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 12px;
  color: var(--qw-text-3);
}
.notify-bell__empty {
  margin: 0;
  padding: 24px 0;
  font-size: 13px;
  color: var(--qw-text-3);
  text-align: center;
}
</style>
<style scoped>
.notify-bell__view-all {
  display: block;
  margin: 8px auto 0;
}
</style>
