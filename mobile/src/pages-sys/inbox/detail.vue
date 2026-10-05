<template>
  <view class="qw-detail">
    <view v-if="message" class="qw-article">
      <view class="qw-inbox__head">
        <view :class="`qw-tile qw-tile--${business ? 'brand' : 'neutral'}`">
          <QwIcon :name="business ? 'briefcase' : 'bell'" size="38rpx" />
        </view>
        <text class="qw-article__title">{{ message.title }}</text>
      </view>
      <view class="qw-article__meta">
        <text>{{ t(`message.category.${message.category}`) }}</text>
        <text>{{ message.senderLabel || t('message.systemSender') }}</text>
        <text>{{ formatTime(message.createdAt) }}</text>
      </view>
      <!-- plain text (never HTML); <text> keeps its line breaks -->
      <text class="qw-article__body">{{ message.body }}</text>
    </view>
    <QwEmpty v-else-if="error" :title="error" />
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import type { InboxUnreadVo, MyInboxItemVo } from '@qiwu/shared'
import QwEmpty from '@/core/components/QwEmpty.vue'
import QwIcon from '@/core/components/QwIcon.vue'
import { formatTime } from '@/core/format'
import { t } from '@/core/i18n'
import { api, errorText } from '@/core/request'
import { useCountsStore } from '@/core/stores/counts'

/**
 * One of my inbox messages (subpackage pages-sys). Opening an unread one marks it read, and the
 * answer's unread count goes to the badges; the message tab reloads its rows when it shows again. Another
 * user's or an unknown id → the server's 404 message.
 */
const INBOX = '/messaging/inboxes/mine'
const counts = useCountsStore()
const message = ref<MyInboxItemVo>()
const error = ref('')
/** the category's icon tile, as in the message list */
const business = computed(() => message.value?.category === 'business')

onLoad(async (query) => {
  uni.setNavigationBarTitle({ title: t('message.detail') })
  const id = Number(query?.id)
  try {
    message.value = await api.get<MyInboxItemVo>(`${INBOX}/${id}`)
    if (!message.value.readAt)
      counts.unread = (await api.post<InboxUnreadVo>(`${INBOX}/${id}/read`)).unread
  } catch (e) {
    error.value = errorText(e)
  }
})
</script>

<style>
.qw-inbox__head {
  display: flex;
  align-items: center;
  gap: 22rpx;
}
</style>
