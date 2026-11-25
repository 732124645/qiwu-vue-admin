<template>
  <z-paging
    ref="paging"
    v-model="rows"
    :default-page-size="PAGE_SIZE_DEFAULT"
    :empty-view-center="false"
    :default-theme-style="pagingTheme.style"
    :loading-more-title-custom-style="pagingTheme.title"
    :loading-more-no-more-line-custom-style="pagingTheme.line"
    :hide-empty-view="chatMode"
    :to-bottom-loading-more-enabled="!chatMode"
    @query="query"
  >
    <QwPageHeader :title="t('common.tab.message')" :sub="summary" />
    <view class="qw-sheet">
      <!-- #ifndef MP-WEIXIN -->
      <view v-if="imCalls.media.state === 'disconnecting'" class="qw-card qw-msg-call-cleanup">
        <text>{{ t('imMedia.call.cleanup') }}</text>
        <button
          class="qw-im-media-button"
          role="button"
          :tabindex="imCallCleanupBusy ? -1 : 0"
          :aria-disabled="imCallCleanupBusy"
          @keydown="activateImMediaButton($event, imCallCleanupBusy, retryImCallDisconnect)"
          :loading="imCallCleanupBusy"
          :disabled="imCallCleanupBusy"
          @click="retryImCallDisconnect"
        >
          {{ t('imMedia.call.retryDisconnect') }}
        </button>
      </view>
      <!-- #endif -->
      <view v-if="imChatVisible" class="qw-seg qw-msg__seg" role="tablist">
        <view
          v-for="name in MODES"
          :key="name"
          :class="`qw-seg__item${name === mode ? ' is-on' : ''}`"
          role="tab"
          :aria-selected="name === mode"
          @click="mode = name"
        >
          <text class="qw-seg__label">{{ t(`im.mode.${name}`) }}</text>
          <!-- prettier-ignore -->
          <text v-if="modeCount(name)" class="qw-seg__n">{{ modeCount(name) > 99 ? '99+' : modeCount(name) }}</text>
        </view>
      </view>
      <template v-if="chatMode">
        <view class="qw-sec">
          <text class="qw-sec__title">{{ t('im.rooms') }}</text>
          <view class="qw-sec__link qw-msg__new" role="button" @click="openDirectory">
            <QwIcon name="message" size="30rpx" />
            <text>{{ t('im.newChat') }}</text>
          </view>
        </view>
        <view v-if="rooms.length" class="qw-group qw-msg__list qw-im-rooms">
          <view
            v-for="room in rooms"
            :key="room.roomId"
            :class="`qw-row qw-im-room ${room.unread ? 'is-unread' : 'is-read'}`"
            role="link"
            @click="openRoom(room.roomId)"
          >
            <view
              v-if="room.detail?.kind === 'group'"
              class="qw-tile qw-tile--brand"
              aria-hidden="true"
            >
              <QwIcon name="message" size="38rpx" />
            </view>
            <view
              v-else
              :class="`qw-av qw-av--${avatarTone(room.detail?.peerId ?? room.roomId)}`"
              aria-hidden="true"
            >
              {{ initial(roomTitle(room, directory)) }}
            </view>
            <view class="qw-row__main">
              <view class="qw-row__line">
                <text class="qw-row__title qw-im-room__title">{{ roomTitle(room, directory) }}</text>
                <text v-if="room.lastAt" class="qw-row__time">{{ formatShort(room.lastAt) }}</text>
              </view>
              <view class="qw-row__line">
                <text class="qw-row__sub qw-msg__preview">{{ previewText(room, directory) }}</text>
                <!-- prettier-ignore -->
                <text v-if="room.unread" class="qw-badge qw-im-room__badge">{{ room.unread > 99 ? '99+' : room.unread }}</text>
                <text v-if="room.unread" class="qw-sr-only">{{ t('message.unread') }}</text>
              </view>
            </view>
          </view>
        </view>
        <QwEmpty v-else :title="t('im.noRooms')" />
      </template>
      <view
        v-if="!chatMode"
        class="qw-card qw-msg__bulletins"
        role="link"
        @click="openBulletins"
      >
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
      <view v-if="!chatMode" class="qw-sec">
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
      <view v-if="rows.length && !chatMode" class="qw-group qw-msg__list">
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
import { activateImMediaButton } from '../../core/im/media-button'
import { computed, onUnmounted, ref, shallowRef, watch } from 'vue'
import { onHide, onShow } from '@dcloudio/uni-app'
import {
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  type BulletinFeed,
  type InboxUnreadVo,
  type MyInboxItemVo,
  type ImDirectory,
  type Page,
} from '@qiwu/shared'
import type { ImRoomRecord } from '@qiwu/shared/im-client'
import QwEmpty from '@/core/components/QwEmpty.vue'
import QwIcon, { type IconName } from '@/core/components/QwIcon.vue'
import QwPageHeader from '@/core/components/QwPageHeader.vue'
import QwTabBar from '@/core/components/QwTabBar.vue'
import { formatShort } from '@/core/format'
import { t } from '@/core/i18n'
import {
  imChatVisible,
  imCurrent,
  imOpenChat,
  imState,
  imUnread,
  onImChange,
} from '@/core/im/client'
import { imCallCleanupBusy, imCalls, retryImCallDisconnect } from '@/core/im/calls'
import { avatarTone, initial, previewText, roomTitle } from '@/core/im/view'
import { api } from '@/core/request'
import { useCountsStore } from '@/core/stores/counts'
import { pagingTheme } from '@/core/theme'

/**
 * Message tab: the unread count under the navy header, the bulletins entry (latest title,
 * unread badge) above my inbox, newest first, paged by z-paging (pull to refresh, load on scroll). A message opens in pages-sys, which marks it read; "mark all as read" reads the rest. Sign-in-only APIs
 * over the caller's own data (see docs/design-notes.md#workflow).
 * With chat available (the probe answered, or offline with this account's cache; never in the mini program) a
 * chat / notifications switch on top: the chat side lists the conversations from the local cache, newest
 * first, re-read on every change the engine reports (no request of its own; the directory loads once here).
 */
const INBOX = '/messaging/inboxes/mine'
/** a message's icon tile by category: business (a briefcase, brand), system (a bell, neutral) */
const CATEGORY: Record<MyInboxItemVo['category'], { icon: IconName; tone: string }> = {
  business: { icon: 'briefcase', tone: 'brand' },
  system: { icon: 'bell', tone: 'neutral' },
}

type Mode = 'chat' | 'notice'
const MODES: readonly Mode[] = ['chat', 'notice']

const counts = useCountsStore()
const MODE_KEY = 'qw.message.mode'
/** notifications first until the user picks chat (remembered on this device) */
const mode = ref<Mode>(uni.getStorageSync(MODE_KEY) === 'chat' ? 'chat' : 'notice')
const chatMode = computed(() => imChatVisible.value && mode.value === 'chat')
const modeCount = (name: Mode) => (name === 'chat' ? imUnread.value : counts.unread ?? 0)
const rooms = shallowRef<ImRoomRecord[]>([])
const directory = shallowRef<ImDirectory>()

/** 页面是否在前台（onShow 与 onHide 之间） */
let listShown = true

/** 从本地缓存读会话（按最近时间，没有时间的排后）与通讯录快照。 */
async function loadRooms() {
  const ctx = imCurrent()
  if (!ctx) {
    rooms.value = []
    directory.value = undefined
    return
  }
  const [list, dir] = await Promise.all([ctx.cache.listRooms(), ctx.cache.getDirectory()])
  if (ctx !== imCurrent()) return
  rooms.value = list
    .filter((r) => r.detail)
    .sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? '') || b.roomId - a.roomId)
  directory.value = dir?.data
  // 列表看得见的会话收到提示时增量拉取（更新预览）；不在聊天区时一个都不算看得见
  ctx.engine.setVisibleRooms(chatMode.value && listShown ? rooms.value.map((r) => r.roomId) : [])
}

/** 聊天区不在眼前（切到通知、页面隐藏或卸载）：不再为列表拉取 */
const hideRooms = () => imCurrent()?.engine.setVisibleRooms([])

const stopWatch = onImChange((c) => {
  if (c.type !== 'outbox') void loadRooms()
})
onUnmounted(() => {
  stopWatch()
  hideRooms()
})
onHide(() => {
  listShown = false
  hideRooms()
})
// 第一次切到聊天时才取通讯录与我的表情（之后带 ETag 复验）；选择记在本机
watch([chatMode, imState], ([on]) => {
  if (!on) return void hideRooms()
  void loadRooms()
  imOpenChat()
})
watch(imState, () => {
  if (imCurrent()) return
  rooms.value = []
  directory.value = undefined
}, { flush: 'sync' })
watch(mode, (m) => uni.setStorageSync(MODE_KEY, m))

const openRoom = (id: number) => uni.navigateTo({ url: `/pages-im/room/index?id=${id}` })
const openDirectory = () => uni.navigateTo({ url: '/pages-im/directory/index' })
const paging = ref<ZPagingRef<MyInboxItemVo>>()
const rows = ref<MyInboxItemVo[]>([])
const feed = ref<BulletinFeed>()
const readingAll = ref(false)
const readAllOff = computed(() => !counts.unread || readingAll.value)

/** "3 unread" (inbox plus chat); a blank line until the count is in (no jump) */
const summary = computed(() => {
  if (counts.unread === null) return '\u00a0'
  const n = counts.unread + (imChatVisible.value ? imUnread.value : 0)
  return n ? t('message.summary', { n }) : t('message.summaryNone')
})

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
  listShown = true
  void loadRooms()
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

/* chat / notifications: the segmented switch of visual-system §12.4 */
.qw-msg__seg {
  margin: var(--qw-space-4) var(--qw-space-4) 0;
}

.qw-seg {
  display: flex;
  height: 44px;
  border-radius: var(--qw-radius-lg);
  background: var(--qw-neutral-weak);
}

.qw-seg__item {
  position: relative;
  z-index: 0;
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 8rpx;
  min-width: 0;
  font-size: var(--qw-fs-body);
  font-weight: 500;
  color: var(--qw-text-2);
  white-space: nowrap;
}

.qw-seg__item.is-on {
  font-weight: 600;
  color: var(--qw-text);
}

.qw-seg__item.is-on::before {
  content: '';
  position: absolute;
  z-index: -1;
  top: 3px;
  right: 3px;
  bottom: 3px;
  left: 3px;
  border-radius: var(--qw-radius);
  background: var(--qw-raised);
  box-shadow: var(--qw-shadow-1);
}

.qw-seg__n {
  box-sizing: border-box;
  min-width: 36rpx;
  height: 36rpx;
  padding: 0 10rpx;
  border-radius: 999px;
  font-size: var(--qw-fs-micro);
  font-weight: 600;
  line-height: 36rpx;
  text-align: center;
  color: var(--qw-on-brand);
  background: var(--qw-brand);
  font-variant-numeric: tabular-nums;
}

.qw-msg__preview {
  flex: 1;
  min-width: 0;
}
.qw-msg-call-cleanup { padding: var(--qw-space-3); color: var(--qw-danger); font-size: var(--qw-fs-caption); }

.qw-im-media-button:focus-visible {
  outline: 2px solid var(--qw-brand);
  outline-offset: 2px;
}
</style>
