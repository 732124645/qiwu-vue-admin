<template>
  <z-paging
    ref="paging"
    v-model="rows"
    :default-page-size="PAGE_SIZE_DEFAULT"
    :empty-view-center="false"
    :default-theme-style="pagingTheme.style"
    :loading-more-title-custom-style="pagingTheme.title"
    :loading-more-no-more-line-custom-style="pagingTheme.line"
    @query="query"
  >
    <QwPageHeader :title="t('common.tab.message')" :sub="summary" />
    <view class="qw-sheet">
      <view class="qw-card qw-msg__bulletins" role="link" @click="openBulletins">
        <view class="qw-tile qw-tile--solid">
          <QwIcon name="megaphone" size="40rpx" />
          <!-- prettier-ignore -->
          <text v-if="feed?.unread" class="qw-badge qw-msg__badge">{{ feed.unread > 99 ? '99+' : feed.unread }}</text>
        </view>
        <view class="qw-msg__text">
          <text class="qw-msg__name">{{ t('message.bulletins') }}</text>
          <text class="qw-msg__latest">{{ feed?.items[0]?.title ?? t('message.noBulletin') }}</text>
        </view>
        <QwIcon class="qw-msg__chev" name="chevron-right" size="34rpx" />
      </view>
      <view class="qw-sec">
        <text class="qw-sec__title">{{ t('message.inbox') }}</text>
        <view
          :class="`qw-sec__link qw-msg__read-all${readAllOff ? ' is-disabled' : ''}`"
          role="button"
          :aria-disabled="readAllOff"
          @click="readAll"
        >
          <wd-loading v-if="readingAll" size="28rpx" />
          <QwIcon v-else name="checks" size="30rpx" />
          <text>{{ t('message.readAll') }}</text>
        </view>
      </view>
      <view v-if="rows.length" class="qw-group qw-msg__list">
        <view
          v-for="item in rows"
          :key="item.id"
          :class="`qw-row qw-msg__item ${item.readAt ? 'is-read' : 'is-unread'}`"
          role="link"
          @click="open(item.id)"
        >
          <view :class="`qw-tile qw-tile--${CATEGORY[item.category].tone}`">
            <QwIcon :name="CATEGORY[item.category].icon" size="38rpx" />
            <text v-if="!item.readAt" class="qw-msg__dot" />
          </view>
          <view class="qw-row__main">
            <view class="qw-row__line">
              <text v-if="!item.readAt" class="qw-sr-only">{{ t('message.unread') }}</text>
              <text class="qw-row__title">{{ item.title }}</text>
              <text class="qw-row__time">{{ formatShort(item.createdAt) }}</text>
            </view>
            <text class="qw-row__body">{{ item.body }}</text>
            <text class="qw-row__meta">{{ meta(item) }}</text>
          </view>
        </view>
      </view>
    </view>
    <template #empty="{ isLoadFailed }">
      <QwEmpty :title="t(isLoadFailed ? 'common.error.network' : 'message.empty')" />
    </template>
    <template #bottom>
      <QwTabBar current="message" />
    </template>
  </z-paging>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import {
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  type BulletinFeed,
  type InboxUnreadVo,
  type MyInboxItemVo,
  type Page,
} from '@qiwu/shared'
import QwEmpty from '@/core/components/QwEmpty.vue'
import QwIcon, { type IconName } from '@/core/components/QwIcon.vue'
import QwPageHeader from '@/core/components/QwPageHeader.vue'
import QwTabBar from '@/core/components/QwTabBar.vue'
import { formatShort } from '@/core/format'
import { t } from '@/core/i18n'
import { api } from '@/core/request'
import { useCountsStore } from '@/core/stores/counts'
import { pagingTheme } from '@/core/theme'

/**
 * Message tab: the unread count under the navy header, the bulletins entry (latest title,
 * unread badge) above my inbox, newest first, paged by z-paging (pull to refresh, load on scroll). A message opens in pages-sys, which marks it read; "mark all as read" reads the rest. Sign-in-only APIs
 * over the caller's own data (see docs/design-notes.md#workflow).
 */
const INBOX = '/messaging/inboxes/mine'
/** a message's icon tile by category: business (a briefcase, brand), system (a bell, neutral) */
const CATEGORY: Record<MyInboxItemVo['category'], { icon: IconName; tone: string }> = {
  business: { icon: 'briefcase', tone: 'brand' },
  system: { icon: 'bell', tone: 'neutral' },
}

const counts = useCountsStore()
const paging = ref<ZPagingRef<MyInboxItemVo>>()
const rows = ref<MyInboxItemVo[]>([])
const feed = ref<BulletinFeed>()
const readingAll = ref(false)
const readAllOff = computed(() => !counts.unread || readingAll.value)

/** "3 unread"; a blank line until the count is in (no jump) */
const summary = computed(() =>
  counts.unread === null
    ? '\u00a0'
    : counts.unread
      ? t('message.summary', { n: counts.unread })
      : t('message.summaryNone'),
)

function query(page: number, pageSize: number) {
  api
    .get<Page<MyInboxItemVo>>(INBOX, { page, pageSize })
    .then((res) => paging.value?.completeByTotal(res.items, res.total))
    .catch(() => paging.value?.complete(false))
}

const loadFeed = () =>
  api.get<BulletinFeed>('/messaging/bulletins/feed', undefined, { silent: true }).then(
    (res) => (feed.value = res),
    () => {},
  )

async function readAll() {
  if (readAllOff.value) return
  readingAll.value = true
  try {
    counts.unread = (await api.post<InboxUnreadVo>(`${INBOX}/read-all`)).unread
    const now = new Date().toISOString()
    for (const row of rows.value) row.readAt ??= now
  } catch {
    // the request layer shows it
  } finally {
    readingAll.value = false
  }
}

/** "category · sender" (no sender: a system message) */
const meta = (item: MyInboxItemVo) =>
  `${t(`message.category.${item.category}`)} · ${item.senderLabel || t('message.systemSender')}`

const open = (id: number) => uni.navigateTo({ url: `/pages-sys/inbox/detail?id=${id}` })
const openBulletins = () => uni.navigateTo({ url: '/pages-sys/bulletin/index' })

// z-paging loads the first page itself; showing again (back from a message, another tab, the
// background) reloads the loaded pages in one request, within the API's page size limit
let shown = false
onShow(() => {
  void loadFeed()
  if (shown && paging.value)
    void (rows.value.length >= PAGE_SIZE_MAX ? paging.value.reload() : paging.value.refresh())
  shown = true
})
</script>

<style>
.qw-msg__bulletins {
  display: flex;
  align-items: center;
  gap: 22rpx;
  padding: 26rpx 22rpx 26rpx 30rpx;
}

.qw-msg__badge {
  position: absolute;
  top: -11rpx;
  right: -11rpx;
}

.qw-msg__text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4rpx;
  min-width: 0;
}

.qw-msg__name {
  font-size: var(--qw-fs-body-lg);
  font-weight: 600;
  color: var(--qw-text);
}

.qw-msg__latest {
  overflow: hidden;
  font-size: var(--qw-fs-caption);
  color: var(--qw-text-2);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.qw-msg__chev {
  color: var(--qw-text-3);
}

/* "mark all as read" while there is nothing to read, or it runs */
.qw-msg__read-all.is-disabled {
  opacity: 0.4;
  pointer-events: none;
}

/* the unread mark on a message's icon tile, ringed in the card's colour */
.qw-msg__dot {
  position: absolute;
  top: -4rpx;
  right: -4rpx;
  width: 18rpx;
  height: 18rpx;
  border-radius: 50%;
  background: var(--qw-danger);
  box-shadow: 0 0 0 2px var(--qw-surface);
}

.qw-msg__list {
  margin-bottom: var(--qw-space-4);
}
</style>
