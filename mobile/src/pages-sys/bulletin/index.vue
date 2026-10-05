<template>
  <view class="qw-detail qw-bulletins">
    <view class="qw-sec qw-bulletins__bar">
      <text class="qw-sec__title">{{ t('message.bulletins') }}</text>
      <view
        :class="`qw-sec__link qw-bulletins__read-all${readAllOff ? ' is-disabled' : ''}`"
        role="button"
        :aria-disabled="readAllOff"
        @click="readAll"
      >
        <wd-loading v-if="readingAll" size="28rpx" />
        <QwIcon v-else name="checks" size="30rpx" />
        <text>{{ t('message.readAll') }}</text>
      </view>
    </view>
    <view v-if="feed?.items.length" class="qw-group">
      <view
        v-for="item in feed.items"
        :key="item.id"
        :class="`qw-row qw-bulletins__item ${item.read ? 'is-read' : 'is-unread'}`"
        role="link"
        @click="open(item.id)"
      >
        <view class="qw-tile qw-tile--warning">
          <QwIcon name="megaphone" size="38rpx" />
          <text v-if="!item.read" class="qw-bulletins__dot" />
        </view>
        <view class="qw-row__main">
          <view class="qw-row__line">
            <text v-if="!item.read" class="qw-sr-only">{{ t('message.unread') }}</text>
            <text class="qw-row__title">{{ item.title }}</text>
            <text class="qw-row__time">{{ formatShort(item.publishedAt) }}</text>
          </view>
          <text class="qw-row__meta">{{ t(`message.kind.${item.kind}`) }}</text>
        </view>
      </view>
    </view>
    <QwEmpty v-else-if="feed" :title="t('message.noBulletin')" />
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import type { BulletinFeed, BulletinUnread } from '@qiwu/shared'
import QwEmpty from '@/core/components/QwEmpty.vue'
import QwIcon from '@/core/components/QwIcon.vue'
import { formatShort } from '@/core/format'
import { t } from '@/core/i18n'
import { api } from '@/core/request'

/**
 * Bulletins (subpackage pages-sys): the published ones as the web's bell lists them, reloaded
 * whenever the page shows (back from one reads it); one opens its detail, "mark all as read" reads every
 * published one. Every signed-in user (see docs/design-notes.md#workflow).
 */
// The feed API answers the latest BULLETIN_FEED_SIZE (5) only; a paged reader endpoint on the
// server + z-paging here if older bulletins must be reachable on mobile
const FEED = '/messaging/bulletins/feed'
const feed = ref<BulletinFeed>()
const readingAll = ref(false)
const readAllOff = computed(() => !feed.value?.unread || readingAll.value)

async function readAll() {
  if (readAllOff.value) return
  readingAll.value = true
  try {
    const { unread } = await api.post<BulletinUnread>(`${FEED}/read-all`)
    if (feed.value)
      feed.value = { unread, items: feed.value.items.map((i) => ({ ...i, read: true })) }
  } catch {
    // the request layer shows it
  } finally {
    readingAll.value = false
  }
}

const open = (id: number) => uni.navigateTo({ url: `/pages-sys/bulletin/detail?id=${id}` })

onShow(() => {
  uni.setNavigationBarTitle({ title: t('message.bulletins') })
  api.get<BulletinFeed>(FEED).then(
    (res) => (feed.value = res),
    () => {},
  )
})
</script>

<style>
.qw-bulletins__bar {
  margin-top: 0;
}

.qw-bulletins__read-all.is-disabled {
  opacity: 0.4;
  pointer-events: none;
}

/* the unread mark on the icon tile, ringed in the card's colour (as the message tab's) */
.qw-bulletins__dot {
  position: absolute;
  top: -4rpx;
  right: -4rpx;
  width: 18rpx;
  height: 18rpx;
  border-radius: 50%;
  background: var(--qw-danger);
  box-shadow: 0 0 0 2px var(--qw-surface);
}
</style>
