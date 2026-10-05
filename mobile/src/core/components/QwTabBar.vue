<template>
  <wd-tabbar
    :model-value="current"
    fixed
    placeholder
    bordered
    safe-area-inset-bottom
    custom-class="qw-tabbar"
    @change="go"
  >
    <wd-tabbar-item v-for="tab in TABS" :key="tab" :name="tab">
      <template #icon="{ active }">
        <view class="qw-tabbar__icon">
          <image class="qw-tabbar__img" :src="icon(tab, active)" aria-hidden="true" />
          <!-- prettier-ignore -->
          <text v-if="badge(tab)" class="qw-badge qw-tabbar__badge" aria-hidden="true">{{ badgeText(tab) }}</text>
        </view>
        <!-- the label (wot-ui's own node, drawn here); with a badge, screen readers get it with the count -->
        <!-- prettier-ignore -->
        <text :class="`wd-tabbar-item__body-title ${active ? 'is-active' : 'is-inactive'}`" :aria-hidden="badge(tab) > 0">{{ t(`common.tab.${tab}`) }}</text>
        <!-- prettier-ignore -->
        <text v-if="badge(tab)" class="qw-sr-only">{{ t(`common.tabBadge.${tab}`, { n: badge(tab) }) }}</text>
      </template>
    </wd-tabbar-item>
  </wd-tabbar>
</template>

<script setup lang="ts">
import { onUnmounted } from 'vue'
import { onHide, onShow } from '@dcloudio/uni-app'
import { t } from '@/core/i18n'
import { pollCounts, startRealtime } from '@/core/realtime'
import { LOGIN_PAGE, hasSession, toPasswordChange } from '@/core/request'
import { useAuthStore } from '@/core/stores/auth'
import { POLL_MS, useCountsStore } from '@/core/stores/counts'
import { isDark, whiteStatusBar } from '@/core/theme'

/**
 * The four tab pages' bar (native tab bars take no runtime texts). pages.json still lists
 * the tab pages, so `switchTab` keeps them alive; the native bar is hidden whenever one shows. Each tab
 * page holds one: it gates the page on a session (and on a due password change), titles it, and reloads the
 * counts when it shows (tab switch, back from a sub-page, back to the foreground) and every minute while it
 * stays shown; App: it keeps the status bar text white on the navy (core/theme.ts). Our own
 * drawn icons (static SVGs, one set per theme: the mini program's <image> reads no CSS variables), the red
 * badge read out with the tab's name (a visually hidden text: an aria-label on wot-ui's role-less node is
 * not read, and the mini program's virtual host drops it).
 */
// mp-weixin / App may flash the native bar once before hideTabBar; a native custom-tab-bar
// (mp-weixin) would avoid it
defineOptions({ options: { virtualHost: true } })
type Tab = 'home' | 'approval' | 'message' | 'mine'
const props = defineProps<{ current: Tab }>()

const TABS: Tab[] = ['home', 'approval', 'message', 'mine']

const auth = useAuthStore()
const counts = useCountsStore()
/** the approval tab shows my to-dos, the message tab my unread messages; 0 / null show no badge */
const badge = (tab: Tab) =>
  (tab === 'approval' ? counts.todo : tab === 'message' ? counts.unread : null) || 0
const badgeText = (tab: Tab) => (badge(tab) > 99 ? '99+' : String(badge(tab)))

const icon = (tab: Tab, active: boolean) =>
  `/static/tab/${tab}${active ? '-on' : ''}${isDark.value ? '-dark' : ''}.svg`
const go = ({ value }: { value: Tab }) => uni.switchTab({ url: `/pages/${value}/index` })

let timer: ReturnType<typeof setInterval> | undefined
const stop = () => clearInterval(timer)

onShow(() => {
  whiteStatusBar()
  if (!hasSession()) return void uni.reLaunch({ url: LOGIN_PAGE })
  if (auth.passwordChangeDue) return void toPasswordChange()
  uni.hideTabBar({ animation: false, fail: () => {} })
  uni.setNavigationBarTitle({ title: t(`common.tab.${props.current}`) })
  counts.load()
  startRealtime()
  stop()
  // pushes reload the counts while the socket is up; the poll covers when it is not
  timer = setInterval(pollCounts, POLL_MS)
})
onHide(stop)
onUnmounted(stop)
</script>

<style>
/* the bar and its labels: App.vue's `.qw-tabbar` (wot-ui's nodes) */
.qw-tabbar__icon {
  position: relative;
  width: 48rpx;
  height: 48rpx;
}

.qw-tabbar__img {
  width: 100%;
  height: 100%;
}

/* App.vue's red badge, pinned to the icon (not the label: English labels are wider) */
.qw-tabbar__badge {
  position: absolute;
  top: -8rpx;
  left: 50%;
  margin-left: 12rpx;
}
</style>
