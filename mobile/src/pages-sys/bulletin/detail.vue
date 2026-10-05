<template>
  <view class="qw-detail">
    <view v-if="bulletin" class="qw-article">
      <view class="qw-bulletin__head">
        <view class="qw-tile qw-tile--solid">
          <QwIcon name="megaphone" size="38rpx" />
        </view>
        <text class="qw-article__title">{{ bulletin.title }}</text>
      </view>
      <view class="qw-article__meta">
        <text class="qw-tag qw-tag--primary is-plain">{{
          t(`message.kind.${bulletin.kind}`)
        }}</text>
        <text>{{ formatTime(bulletin.publishedAt) }}</text>
      </view>
      <rich-text class="qw-article__body" :nodes="html" />
    </view>
    <QwEmpty v-else-if="error" :title="error" />
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import type { BulletinFeedDetail } from '@qiwu/shared'
import QwEmpty from '@/core/components/QwEmpty.vue'
import QwIcon from '@/core/components/QwIcon.vue'
import { formatTime } from '@/core/format'
import { t } from '@/core/i18n'
import { api, errorText } from '@/core/request'

/**
 * One published bulletin (subpackage pages-sys). `body` is HTML the server cleaned with its fixed
 * whitelist when it was saved (core/sanitize.ts: no style/class, http(s) images), shown by uni's
 * rich-text; images get a width cap (a class would not reach rich-text nodes on mp-weixin). Opening an
 * unread one marks it read (the list reloads when it shows again). A draft or unknown id → the server's 404.
 */
const FEED = '/messaging/bulletins/feed'
const bulletin = ref<BulletinFeedDetail>()
const error = ref('')
const html = computed(
  () => bulletin.value?.body.replace(/<img\b/gi, '<img style="max-width:100%;height:auto"') ?? '',
)

onLoad(async (query) => {
  uni.setNavigationBarTitle({ title: t('message.bulletinDetail') })
  const id = Number(query?.id)
  try {
    bulletin.value = await api.get<BulletinFeedDetail>(`${FEED}/${id}`)
    if (!bulletin.value.read) await api.post(`${FEED}/${id}/read`)
  } catch (e) {
    error.value = errorText(e)
  }
})
</script>

<style>
.qw-bulletin__head {
  display: flex;
  align-items: center;
  gap: 22rpx;
}
</style>
