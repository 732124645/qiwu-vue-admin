<template>
  <view class="qw-empty">
    <image class="qw-empty__art" :src="art" mode="aspectFit" aria-hidden="true" />
    <text class="qw-empty__title">{{ title }}</text>
    <text v-if="desc" class="qw-empty__desc">{{ desc }}</text>
    <view v-if="action" class="qw-btn qw-btn--soft qw-empty__action" role="button" @click="emit('action')">
      {{ action }}
    </view>
  </view>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { isDark } from '@/core/theme'

/**
 * An empty state (§12.4): the resting bird under the parasol tree (day art; night art in dark mode), a title,
 * an optional hint and an optional soft button (`action` is its text; `@action` its click). For z-paging's
 * `#empty` slot and wherever a list or a page has nothing to show.
 */
defineOptions({ options: { virtualHost: true } })
defineProps<{ title: string; desc?: string; action?: string }>()
const emit = defineEmits<{ action: [] }>()

const art = computed(() => `/static/empty/rest${isDark.value ? '-night' : ''}.svg`)
</script>

<style>
.qw-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 68rpx var(--qw-space-5) 0;
  text-align: center;
}

.qw-empty__art {
  width: 410rpx;
  height: 298rpx;
}

.qw-empty__title {
  margin-top: 26rpx;
  font-size: var(--qw-fs-title);
  font-weight: 600;
  color: var(--qw-text);
}

.qw-empty__desc {
  max-width: 522rpx;
  margin-top: 12rpx;
  font-size: var(--qw-fs-body);
  line-height: 1.5;
  color: var(--qw-text-3);
}

.qw-empty__action {
  margin-top: 34rpx;
}
</style>
