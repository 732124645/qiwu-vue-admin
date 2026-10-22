<template>
  <view class="qw-detail qw-stack qw-clock">
    <view class="qw-card qw-clock__box">
      <text class="qw-clock__title">{{ t('clock.title') }}</text>
      <template v-if="state.today">
        <view class="qw-kv"
          ><text class="qw-kv__k">{{ t('clock.workDate') }}</text
          ><text class="qw-kv__v">{{ state.today.workDate }}</text></view
        >
        <view class="qw-kv"
          ><text class="qw-kv__k">{{ t('clock.timezone') }}</text
          ><text class="qw-kv__v">{{ state.today.policy.timezone }}</text></view
        >
        <view v-for="action in ACTIONS" :key="action" class="qw-kv">
          <text class="qw-kv__k">{{ t(`clock.${action}`) }}</text>
          <text class="qw-kv__v">{{
            clockTime(action === 'check_in' ? state.today.checkIn : state.today.checkOut)
          }}</text>
        </view>
        <text v-if="!state.today.policy.enabled" class="qw-form__hint">{{
          t('clock.disabled')
        }}</text>
        <template v-if="state.today.policy.locationMode === 'site'">
          <text class="qw-form__hint">{{ t('clock.locationPurpose') }}</text>
          <text class="qw-form__hint">{{ capability }}</text>
          <picker
            :range="state.sites"
            range-key="name"
            :disabled="state.busy || state.unresolved"
            @change="chooseSite"
          >
            <wd-cell
              :title="t('clock.site')"
              :value="selectedSite?.name || t('clock.chooseSite')"
              is-link
            />
          </picker>
          <text v-if="selectedSite" class="qw-form__hint">{{
            t('clock.siteLimits', {
              radius: selectedSite.radiusM,
              accuracy: selectedSite.maxAccuracyM,
            })
          }}</text>
          <wd-button
            v-if="state.sites.length < state.siteTotal"
            size="small"
            :disabled="state.busy || loadingSites"
            :loading="loadingSites"
            @click="moreSites"
            >{{ t('clock.moreSites') }}</wd-button
          >
        </template>
        <view class="qw-clock__actions">
          <wd-button
            v-for="action in ACTIONS"
            :key="action"
            custom-class="qw-btn qw-btn--primary"
            :loading="state.busy"
            :disabled="!clock.allowed(action)"
            @click="clock.punch(action)"
            >{{ t(`clock.${action}`) }}</wd-button
          >
        </view>
      </template>
      <wd-loading v-else-if="state.busy" />
      <text v-if="state.error" class="qw-form__error" role="alert">{{ state.error }}</text>
      <text v-if="state.message" class="qw-form__hint" role="status">{{ state.message }}</text>
      <template v-if="state.unresolved">
        <text class="qw-form__hint">{{ t('clock.uncertain') }}</text>
        <view class="qw-clock__actions">
          <wd-button :loading="state.busy" :disabled="state.busy" @click="clock.resolve()">{{
            t('clock.queryResult')
          }}</wd-button>
          <wd-button
            v-if="state.retryable"
            :loading="state.busy"
            :disabled="state.busy"
            @click="clock.resolve(true)"
            >{{ t('clock.retryOriginal') }}</wd-button
          >
        </view>
      </template>
      <wd-button
        v-else
        variant="soft"
        :loading="state.busy"
        :disabled="state.busy"
        @click="clock.load()"
        >{{ t('clock.refresh') }}</wd-button
      >
    </view>
    <view v-if="state.today" class="qw-card qw-clock__box">
      <text class="qw-clock__title">{{ t('clock.records') }}</text>
      <text class="qw-form__hint">{{ t('clock.recordHint') }}</text>
      <view class="qw-field qw-clock__month">
        <text class="qw-field__label">{{ t('clock.month') }}</text>
        <wd-input
          v-model="state.month"
          placeholder="YYYY-MM"
          :disabled="state.loadingRecords || state.busy"
        />
      </view>
      <view class="qw-field qw-clock__day">
        <text class="qw-field__label">{{ t('clock.day') }}</text>
        <wd-input
          v-model="state.day"
          placeholder="YYYY-MM-DD"
          :disabled="state.loadingRecords || state.busy"
        />
      </view>
      <wd-button
        variant="soft"
        :loading="state.loadingRecords"
        :disabled="state.loadingRecords || state.busy"
        @click="clock.records(1)"
        >{{ t('clock.search') }}</wd-button
      >
      <wd-loading v-if="state.loadingRecords" />
      <text v-else-if="!state.items.length" class="qw-form__hint">{{ t('clock.noRecord') }}</text>
      <view v-for="record in state.items" :key="record.id" class="qw-clock__record">
        <text>{{ record.workDate }} · {{ t(`clock.${record.action}`) }}</text>
        <text>{{ clockTime(record) }} · {{ record.timezone }}</text>
        <text v-if="record.siteName">{{ record.siteName }}</text>
      </view>
      <view class="qw-clock__actions">
        <wd-button
          size="small"
          :disabled="state.loadingRecords || state.busy || state.page <= 1"
          @click="clock.records(state.page - 1)"
          >{{ t('clock.previous') }}</wd-button
        >
        <text>{{ t('clock.page', { page: state.page, total: state.total }) }}</text>
        <wd-button
          size="small"
          :disabled="state.loadingRecords || state.busy || state.page * 20 >= state.total"
          @click="clock.records(state.page + 1)"
          >{{ t('clock.next') }}</wd-button
        >
      </view>
    </view>
  </view>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { onLoad, onShow, onUnload } from '@dcloudio/uni-app'
import { t } from '@/core/i18n'
import { currentSessionVersion, errorText, sessionVersion } from '@/core/request'
import { useAuthStore } from '@/core/stores/auth'
import { clockTime, useClock } from './clock'

const ACTIONS = ['check_in', 'check_out'] as const
const clock = useClock()
const state = clock.state
const auth = useAuthStore()
const selectedSite = computed(() => state.sites.find((site) => site.id === state.siteId))
const capability = computed(() =>
  t(
    process.env.UNI_PLATFORM === 'h5'
      ? 'clock.h5Location'
      : process.env.UNI_PLATFORM === 'mp-weixin'
        ? 'clock.mpLocation'
        : 'clock.appLocation',
  ),
)
const loadingSites = ref(false)
let disposed = false
watch(sessionVersion, () => (loadingSites.value = false), { flush: 'sync' })
function chooseSite(event: { detail: { value: string | number } }) {
  if (!state.busy && !state.unresolved)
    state.siteId = state.sites[Number(event.detail.value)]?.id ?? 0
}
async function moreSites() {
  if (loadingSites.value || state.busy) return
  loadingSites.value = true
  const session = currentSessionVersion()
  try {
    await clock.loadSites(state.sitePage + 1)
  } catch (cause) {
    if (!disposed && session === currentSessionVersion()) state.error = errorText(cause)
  } finally {
    if (!disposed && session === currentSessionVersion()) loadingSites.value = false
  }
}
watch(
  () => [state.month, state.day],
  () => {
    state.items = []
    state.total = 0
  },
)
onLoad(() => uni.setNavigationBarTitle({ title: t('clock.title') }))
onShow(async () => {
  const session = currentSessionVersion()
  try {
    if (!auth.me) await auth.fetchMe()
    if (disposed || session !== currentSessionVersion()) return
    await clock.load()
  } catch (cause) {
    if (!disposed && session === currentSessionVersion()) state.error = errorText(cause)
  }
})
onUnload(() => {
  disposed = true
  clock.dispose()
})
</script>
<style scoped>
.qw-clock__box {
  display: flex;
  flex-direction: column;
  gap: var(--qw-space-3);
  padding: var(--qw-space-4);
}
.qw-clock__title {
  font-size: var(--qw-fs-title);
  font-weight: 600;
}
.qw-clock__actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--qw-space-2);
  flex-wrap: wrap;
}
.qw-clock__record {
  display: flex;
  flex-direction: column;
  gap: var(--qw-space-1);
  padding: var(--qw-space-3) 0;
  border-bottom: 1px solid var(--qw-border);
  font-size: var(--qw-fs-body);
}
</style>
