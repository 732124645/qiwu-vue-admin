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
    <template #top>
      <QwPageHeader :title="t('common.tab.approval')" :sub="summary" />
      <view class="qw-sheet qw-approval__sheet">
        <view class="qw-seg" role="tablist">
          <view
            v-for="name in APPROVAL_LISTS"
            :key="name"
            :class="`qw-seg__item${name === list ? ' is-on' : ''}`"
            role="tab"
            :aria-selected="name === list"
            @click="list = name"
          >
            <text class="qw-seg__label">{{ t(`approval.list.${name}`) }}</text>
            <!-- prettier-ignore -->
            <text v-if="name === 'todo' && counts.todo" class="qw-seg__n">{{ counts.todo > 99 ? '99+' : counts.todo }}</text>
          </view>
        </view>
      </view>
    </template>
    <view class="qw-approval__list">
      <view
        v-for="x in items"
        :key="x.row.id"
        :class="`qw-card qw-row qw-approval__item${x.row.unread ? ' is-unread' : ''}`"
        role="link"
        @click="open(x.row)"
      >
        <view :class="`qw-av qw-av--${x.face.tone}`" aria-hidden="true">{{ x.face.text }}</view>
        <view class="qw-row__main">
          <view class="qw-row__line">
            <text class="qw-row__title">{{ x.title }}</text>
            <view v-if="x.row.unread" class="qw-dot" role="img" :aria-label="t('message.unread')" />
            <text class="qw-row__time">{{ x.time }}</text>
          </view>
          <text class="qw-row__sub">{{ x.sub }}</text>
          <!-- my result or the process's state as a pill; done: where the process stands, as text -->
          <view v-if="x.tag" class="qw-row__line qw-approval__tags">
            <text :class="`qw-tag qw-tag--${x.tag.type}`">{{ x.tag.label }}</text>
            <text v-if="x.process" class="qw-row__meta">{{ x.process }}</text>
          </view>
          <text v-if="x.row.note" class="qw-approval__note">{{ x.row.note }}</text>
        </view>
      </view>
    </view>
    <template #empty="{ isLoadFailed }">
      <QwEmpty v-if="isLoadFailed" :title="t('common.error.network')" />
      <QwEmpty
        v-else-if="list === 'todo'"
        :title="t('approval.emptyTodo')"
        :desc="t('approval.emptyTodoHint')"
        :action="t('approval.viewDone')"
        @action="list = 'done'"
      />
      <QwEmpty v-else :title="t('approval.empty')" />
    </template>
    <template #bottom>
      <QwTabBar current="approval" />
    </template>
  </z-paging>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX, type DictPayload } from '@qiwu/shared'
import {
  APPROVAL_LISTS,
  avatar,
  loadApprovals,
  readCc,
  stateTag,
  type ApprovalList,
  type ApprovalRow,
  type StateDict,
} from '@/core/approvals'
import QwEmpty from '@/core/components/QwEmpty.vue'
import QwPageHeader from '@/core/components/QwPageHeader.vue'
import QwTabBar from '@/core/components/QwTabBar.vue'
import { formatShort } from '@/core/format'
import { t, tx } from '@/core/i18n'
import { useCountsStore } from '@/core/stores/counts'
import { loadDict } from '@/core/pickers'
import { pagingTheme } from '@/core/theme'

/**
 * Approval tab: my to-dos, the tasks I handled, the processes I started and the copies sent to me, one
 * list at a time, paged by z-paging (pull to refresh, load on scroll). The to-do list's answers
 * update the count the workbench and the tab badge share. A row opens its instance (pages-wf); an unread
 * copy is marked read first. Sign-in-only APIs over the caller's own rows (see docs/design-notes.md#workflow).
 * The navy header with the to-do summary, a segmented filter, rows with the initiator's avatar, the
 * model's name and a short time; empty to-dos point to the done list. z-paging's own pull and "no more"
 * marks follow the theme (its white set in dark; the footer's text and lines in our tokens).
 */
const counts = useCountsStore()
const paging = ref<ZPagingRef<ApprovalRow>>()
const rows = ref<ApprovalRow[]>([])
const list = ref<ApprovalList>('todo')
/** a no-break space until the count is known: the header keeps its height */
const summary = computed(() =>
  counts.todo === null
    ? ' '
    : counts.todo
      ? t('approval.summary', { n: counts.todo })
      : t('approval.summaryNone'),
)

const dicts = reactive<Partial<Record<StateDict, DictPayload>>>({})
for (const code of ['wf.task_state', 'wf.instance_state'] as const)
  loadDict(code).then(
    (d) => (dicts[code] = d),
    () => {}, // shown by the request layer; tags show their codes
  )
/**
 * What a row shows: the initiator's avatar, the model, a short time, "initiator started · step" (to-dos,
 * done) or "· sender" (copies; none: a process step); the first state as a pill, a second (done: where the
 * process stands) as text.
 */
const items = computed(() =>
  rows.value.map((row) => {
    const [tag, process] = row.tags.map((x) => stateTag(dicts[x.dict], x.value))
    return {
      row,
      face: avatar(row.initiator, row.initiatorId),
      title: tx(row.modelName),
      time: row.at ? formatShort(row.at) : '',
      sub: [
        t('approval.startedBy', { name: row.initiator ?? '' }),
        row.node && tx(row.node),
        row.from === null ? t('approval.fromStep') : row.from,
      ]
        .filter(Boolean)
        .join(' · '),
      tag,
      process: process && `${t('approval.process')} · ${process.label}`,
    }
  }),
)

// only the latest request's answer shows: a list switched meanwhile drops the earlier one's
let seq = 0
function query(page: number, pageSize: number) {
  const mine = ++seq
  loadApprovals(list.value, page, pageSize).then(
    (res) => void (mine === seq && paging.value?.completeByTotal(res.items, res.total)),
    () => void (mine === seq && paging.value?.complete(false)),
  )
}
watch(list, () => void paging.value?.reload())

let opening = false
async function open(row: ApprovalRow) {
  if (opening) return
  opening = true
  try {
    if (row.unread) {
      await readCc(row.id)
      row.unread = false
    }
  } catch {
    // shown by the request layer (a copy gone meanwhile: 404); the list shows what is left
    opening = false
    return void paging.value?.reload()
  }
  uni.navigateTo({
    url: `/pages-wf/detail/index?id=${row.instanceId}`,
    complete: () => (opening = false),
  })
}

// z-paging loads the first page itself; showing again (back from an instance, another tab, the
// background) reloads the loaded pages in one request, within the API's page size limit
let shown = false
onShow(() => {
  if (shown && paging.value)
    void (rows.value.length >= PAGE_SIZE_MAX ? paging.value.reload() : paging.value.refresh())
  shown = true
})
</script>

<style>
.qw-approval__sheet {
  padding-bottom: var(--qw-space-3);
}

/* §12.4: the segmented filter; each part 44 high (the hit area), the thumb drawn 3px inside it */
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

/* the to-do count: a calm brand pill, not the red badge */
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

.qw-approval__list {
  display: flex;
  flex-direction: column;
  gap: var(--qw-space-2);
  padding: 0 var(--qw-space-4) var(--qw-space-4);
}

.qw-approval__tags {
  margin-top: 8rpx;
}

/* done: my comment; copies: the sender's note */
.qw-approval__note {
  margin-top: 4rpx;
  padding: 16rpx 24rpx;
  border-radius: var(--qw-radius);
  font-size: var(--qw-fs-body);
  line-height: 1.5;
  color: var(--qw-text-2);
  background: var(--qw-surface-2);
  word-break: break-word;
}
</style>
