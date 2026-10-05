<template>
  <view class="qw-detail qw-stack">
    <view class="qw-about">
      <QwBrandMark size="120rpx" />
      <text class="qw-about__name">{{ t('common.app.name') }}</text>
      <text class="qw-about__version">{{ `${t('common.version')} ${version}` }}</text>
      <text class="qw-about__intro">{{ t('mine.intro') }}</text>
    </view>
    <wd-cell-group custom-class="qw-group" border>
      <wd-cell :title="t('mine.license')" value="MIT" />
    </wd-cell-group>
  </view>
</template>

<script setup lang="ts">
import { onLoad } from '@dcloudio/uni-app'
import QwBrandMark from '@/core/components/QwBrandMark.vue'
import { t } from '@/core/i18n'

// About (subpackage pages-sys, the brand mark and wordmark on the canvas): the app's name and
// the version of manifest.json (versionName)
const version = uni.getAppBaseInfo().appVersion ?? ''

onLoad(() => uni.setNavigationBarTitle({ title: t('mine.about') }))
</script>

<style>
.qw-about {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 40rpx 32rpx 16rpx;
  text-align: center;
}

.qw-about__name {
  margin-top: 24rpx;
  font-size: var(--qw-fs-title-lg);
  font-weight: 650;
  letter-spacing: 0.06em;
  color: var(--qw-text);
}

.qw-about__version {
  margin-top: 4rpx;
  font-size: var(--qw-fs-caption);
  color: var(--qw-text-3);
  font-variant-numeric: tabular-nums;
}

.qw-about__intro {
  margin-top: 20rpx;
  font-size: var(--qw-fs-body);
  color: var(--qw-text-2);
}
</style>
