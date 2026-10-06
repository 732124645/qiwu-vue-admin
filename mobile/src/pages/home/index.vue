<template>
  <view class="qw-home">
    <QwPageHeader variant="hero">
      <template #bar>
        <QwBrandMark size="48rpx" />
        <text class="qw-home__brand">{{ t('common.app.name') }}</text>
      </template>
      <view class="qw-home__hello">
        <text class="qw-hdr__title qw-home__name" role="heading">{{ hello }}</text>
        <text v-if="org" class="qw-hdr__sub">{{ org }}</text>
      </view>
    </QwPageHeader>
    <view class="qw-sheet qw-home__sheet">
      <view class="qw-card qw-home__stats">
        <view
          v-for="stat in stats"
          :key="stat.name"
          :class="`qw-home__stat qw-home__stat--${stat.name}`"
          role="link"
          @click="toTab(stat.tab)"
        >
          <view class="qw-home__label">
            <QwIcon :class="`qw-home__tone--${stat.tone}`" :name="stat.icon" size="30rpx" />
            <text>{{ t(`home.stats.${stat.name}`) }}</text>
          </view>
          <text class="qw-home__value">{{ stat.value ?? '-' }}</text>
        </view>
      </view>
      <view class="qw-sec">
        <text class="qw-sec__title">{{ t('home.shortcuts') }}</text>
      </view>
      <view class="qw-card qw-home__grid">
        <view
          v-for="item in shortcuts"
          :key="item.name"
          :class="`qw-home__shortcut qw-home__shortcut--${item.name}`"
          role="link"
          @click="open(item.url)"
        >
          <view :class="`qw-tile qw-tile--${item.tone} qw-home__icon`">
            <QwIcon :name="item.icon" size="44rpx" />
          </view>
          <text>{{ t(`home.shortcut.${item.name}`) }}</text>
        </view>
      </view>
      <view class="qw-sec">
        <text class="qw-sec__title">{{ t('home.recent') }}</text>
        <view class="qw-sec__link qw-home__all" role="link" @click="toTab('approval')">
          <text>{{ t('home.viewAll') }}</text>
          <QwIcon name="chevron-right" size="30rpx" />
        </view>
      </view>
      <view v-if="recent.length" class="qw-group">
        <view
          v-for="row in recent"
          :key="row.id"
          class="qw-row qw-home__todo"
          role="link"
          @click="openTask(row.instance.id)"
        >
          <!-- prettier-ignore -->
          <text :class="`qw-av qw-av--${tone(row.instance.initiator.id)}`" aria-hidden="true">{{ initial(row.instance.initiator.name) }}</text>
          <view class="qw-row__main">
            <view class="qw-row__line">
              <text class="qw-row__title">{{ tx(row.instance.modelName) }}</text>
              <text class="qw-row__time">{{ formatShort(row.createdAt) }}</text>
            </view>
            <text class="qw-row__sub">{{ sub(row) }}</text>
          </view>
        </view>
      </view>
      <text v-else-if="recentLoaded" class="qw-card qw-home__none">{{
        t('approval.emptyTodo')
      }}</text>
    </view>
    <QwTabBar current="home" />
  </view>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { onHide, onShow } from '@dcloudio/uni-app'
import { leavePerms, type Page, type WfTaskItemVo } from '@qiwu/shared'
import QwBrandMark from '@/core/components/QwBrandMark.vue'
import QwIcon, { type IconName } from '@/core/components/QwIcon.vue'
import QwPageHeader from '@/core/components/QwPageHeader.vue'
import QwTabBar from '@/core/components/QwTabBar.vue'
import { formatShort } from '@/core/format'
import { t, tx } from '@/core/i18n'
import { api } from '@/core/request'
import { useAuthStore } from '@/core/stores/auth'
import { useCountsStore } from '@/core/stores/counts'

/**
 * Workbench: the greeting under the navy header; my to-dos, my running processes and unread
 * messages (shared with the tab badges, reloaded as the tab bar says); the shortcuts the user may open; my
 * newest to-dos. Each shortcut opens a page of its domain's subpackage; one with `perm` shows only
 * with that permission (display only: the server enforces it).
 */
type Tone = 'brand' | 'success' | 'warning' | 'neutral'
interface Shortcut {
  name: string
  icon: IconName
  tone: Tone
  url: string
  perm?: string
}
// the approval center and the bulletin feed need a sign-in only (see docs/design-notes.md#workflow)
const SHORTCUTS: Shortcut[] = [
  { name: 'start', icon: 'send', tone: 'brand', url: '/pages-wf/start/index' },
  // a new leave request (its submit starts the approval)
  {
    name: 'leave',
    icon: 'calendar',
    tone: 'success',
    url: '/pages-biz/leave/index',
    perm: leavePerms.create,
  },
  { name: 'bulletin', icon: 'megaphone', tone: 'warning', url: '/pages-sys/bulletin/index' },
]
/** the counters: each opens its tab */
const STATS = [
  { name: 'todo', icon: 'doc', tone: 'brand', tab: 'approval' },
  { name: 'running', icon: 'clock', tone: 'warning', tab: 'approval' },
  { name: 'unread', icon: 'message', tone: 'success', tab: 'message' },
] as const
/** the newest to-dos the workbench lists */
const RECENT = 3
/** a person's initial on one of four grounds, by user id */
const TONES: Tone[] = ['brand', 'success', 'warning', 'neutral']

const auth = useAuthStore()
const counts = useCountsStore()
const me = computed(() => auth.me)
const hello = computed(() => t('home.hello', { name: me.value?.user.displayName ?? '' }))
/** "Dept · roles": seeded names are i18n keys */
const org = computed(() =>
  [me.value?.user.deptName, ...(me.value?.user.roleNames ?? [])]
    .filter((name): name is string => !!name)
    .map(tx)
    .join(' · '),
)
const stats = computed(() => STATS.map((stat) => ({ ...stat, value: counts[stat.name] })))
const shortcuts = computed(() => SHORTCUTS.filter((s) => !s.perm || auth.hasPerm(s.perm)))

const toTab = (tab: string) => uni.switchTab({ url: `/pages/${tab}/index` })
const open = (url: string) => uni.navigateTo({ url })
const openTask = (instanceId: number) =>
  uni.navigateTo({ url: `/pages-wf/detail/index?id=${instanceId}` })

// my newest to-dos: reloaded with every to-do count answer while the workbench shows (its tab bar reloads the
// counts on every show and every minute), changed or not (one handled and one new keep the count), so list and
// count agree. Hidden, it skips the answers of the other tabs' polls: its next show reloads the counts anyway.
const recent = ref<WfTaskItemVo[]>([])
const recentLoaded = ref(false)
let shown = false
let seq = 0
function loadRecent() {
  const mine = ++seq
  api
    .get<Page<WfTaskItemVo>>('/wf/tasks/todo', { page: 1, pageSize: RECENT }, { silent: true })
    .then(
      (res) => {
        if (mine !== seq) return
        recent.value = res.items
        recentLoaded.value = true
      },
      () => {},
    )
}
// (no load of its own on show: the tab bar's show loads the counts, one request per show)
watch(
  () => counts.tick,
  () => shown && loadRecent(),
)

const tone = (userId: number) => TONES[userId % TONES.length]!
const initial = (name: string | null) => [...(name ?? '')][0]?.toUpperCase() ?? ''
/** "Li Na started · Director approval" */
const sub = (row: WfTaskItemVo) =>
  `${t('approval.startedBy', { name: row.instance.initiator.name ?? '' })} · ${tx(row.nodeName)}`

// the user and perms of this session (a rejected session goes to sign-in: the request layer)
onShow(() => {
  shown = true
  if (!auth.me) auth.fetchMe().catch(() => {})
})
onHide(() => (shown = false))
</script>

<style>
.qw-home__brand {
  font-size: var(--qw-fs-title);
  font-weight: 600;
  letter-spacing: 0.06em;
}

/*
 * Left of the hero art at every width: it starts at 339rpx (QwPageHeader: 422rpx wide, 11rpx past the right
 * edge), the column at the header's padding. A long name and the org line wrap to two lines each, then end in …
 */
.qw-home__hello {
  position: relative;
  display: flex;
  flex-direction: column;
  max-width: calc(339rpx - var(--qw-space-4));
  margin-top: 12rpx;
}

.qw-home__name,
.qw-home__hello .qw-hdr__sub {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.qw-home__sheet {
  padding-bottom: var(--qw-space-4);
}

/* three counters in one raised card, split by short lines */
.qw-home__stats {
  display: flex;
  padding: 12rpx 0;
  box-shadow: var(--qw-shadow-1);
}

.qw-home__stat {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 12rpx;
  min-width: 0;
  padding: 22rpx 0 22rpx 34rpx;
}

.qw-home__stat + .qw-home__stat::before {
  content: '';
  position: absolute;
  top: 34rpx;
  bottom: 34rpx;
  left: 0;
  width: 1px;
  background: var(--qw-border);
}

.qw-home__label {
  display: flex;
  align-items: center;
  gap: 12rpx;
  font-size: var(--qw-fs-caption);
  color: var(--qw-text-2);
  white-space: nowrap;
}

.qw-home__tone--brand {
  color: var(--qw-brand-text);
}

.qw-home__tone--warning {
  color: var(--qw-warning);
}

.qw-home__tone--success {
  color: var(--qw-success);
}

.qw-home__value {
  font-size: var(--qw-fs-display);
  font-weight: 650;
  line-height: 1.05;
  letter-spacing: -0.01em;
  color: var(--qw-text);
  font-variant-numeric: tabular-nums;
}

.qw-home__grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  row-gap: 30rpx;
  padding: 30rpx 8rpx 26rpx;
}

.qw-home__shortcut {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16rpx;
  font-size: var(--qw-fs-caption);
  color: var(--qw-text);
}

.qw-home__icon {
  width: 90rpx;
  height: 90rpx;
}

.qw-home__none {
  display: block;
  padding: 32rpx;
  font-size: var(--qw-fs-body);
  text-align: center;
  color: var(--qw-text-3);
}
</style>
