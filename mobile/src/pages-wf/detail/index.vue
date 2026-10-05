<template>
  <view class="qw-detail qw-stack" :class="{ 'has-bar': acts.length > 0 }">
    <template v-if="inst">
      <!-- head: the model, its state, who started it when; my turn -->
      <view class="qw-card qw-wf__head">
        <view class="qw-wf__top">
          <view class="qw-tile qw-tile--brand qw-wf__icon" aria-hidden="true">
            <QwIcon :name="icon" size="40rpx" />
          </view>
          <view class="qw-wf__main">
            <view class="qw-wf__line">
              <text class="qw-wf__title" role="heading">{{ tx(inst.modelName) }}</text>
              <text :class="`qw-tag qw-tag--${state.type} qw-wf__state`">{{ state.label }}</text>
            </view>
            <text class="qw-wf__meta">{{ startedBy }}</text>
          </view>
        </view>
        <view v-if="turn" class="qw-wf__turn">
          <QwIcon name="clock" size="34rpx" />
          <text>{{ t('approval.yourTurn', { node: tx(turn.nodeName) }) }}</text>
        </view>
      </view>
      <!-- a dynamic form: its fields, my step's `edit` ones as inputs -->
      <view v-if="pf" class="qw-card qw-wf__box qw-wf__dynamic">
        <view class="qw-wf__box-head">
          <text class="qw-wf__box-title">{{ t('approval.form') }}</text>
        </view>
        <QwProcessForm v-model="values" :form="pf" :access="inst.access" :errors="formErrors" />
      </view>
      <!-- a custom form: its key fields (the view registry's summary) and the way to all of it -->
      <view v-else-if="summary" class="qw-card qw-wf__box qw-wf__summary">
        <view class="qw-wf__box-head">
          <text class="qw-wf__box-title">{{ summary.title }}</text>
          <view class="qw-sec__link qw-wf__full" role="link" @click="openForm">
            <text>{{ t('approval.fullForm') }}</text>
            <QwIcon name="chevron-right" size="32rpx" />
          </view>
        </view>
        <view v-for="r in summary.rows" :key="r.label" class="qw-kv">
          <text class="qw-kv__k">{{ r.label }}</text>
          <text class="qw-kv__v">{{ r.value }}</text>
        </view>
      </view>
      <!-- none: one row, to the form's page or "view it on a computer" -->
      <view
        v-else-if="summary === null"
        class="qw-card qw-wf__form"
        :role="form ? 'link' : undefined"
        @click="openForm"
      >
        <text class="qw-wf__form-name">{{ t('approval.form') }}</text>
        <text class="qw-wf__form-value">
          {{ form ? t('approval.viewForm') : t('approval.desktopOnly') }}
        </text>
        <QwIcon v-if="form" name="chevron-right" size="32rpx" />
      </view>
      <view class="qw-card qw-wf__box qw-wf__timeline">
        <view class="qw-wf__box-head">
          <text class="qw-wf__box-title qw-wf__heading">{{ t('approval.timeline') }}</text>
        </view>
        <view class="qw-tl">
          <view v-for="e in events" :key="e.id" class="qw-tl__item">
            <view class="qw-tl__node" aria-hidden="true">
              <view :class="`qw-av qw-av--${e.face.tone} qw-tl__av`">{{ e.face.text }}</view>
              <view v-if="e.mark" :class="`qw-tl__mark qw-tl__mark--${e.mark.tone}`">
                <QwIcon :name="e.mark.icon" size="18rpx" />
              </view>
            </view>
            <view class="qw-tl__body">
              <view class="qw-tl__line">
                <text class="qw-tl__who">{{ e.who }}</text>
                <text :class="`qw-tag is-plain qw-tag--${e.tag.type}`">{{ e.tag.label }}</text>
                <text class="qw-tl__time">{{ e.time }}</text>
              </view>
              <text v-if="e.node" class="qw-tl__step">{{ e.node }}</text>
              <text v-if="e.targets" class="qw-tl__step">→ {{ e.targets }}</text>
              <text v-if="e.comment" class="qw-tl__comment">{{ e.comment }}</text>
            </view>
          </view>
          <!-- my turn (from my tasks; others' pending steps are not in the API) -->
          <view v-if="turn" class="qw-tl__item is-pending">
            <view class="qw-tl__node" aria-hidden="true">
              <view class="qw-av qw-tl__av">{{ myFace.text }}</view>
            </view>
            <view class="qw-tl__body">
              <view class="qw-tl__line">
                <text class="qw-tl__who">{{ myName }}</text>
                <text class="qw-tag is-plain qw-tag--primary">{{ t('approval.pending') }}</text>
              </view>
              <text class="qw-tl__step">{{ tx(turn.nodeName) }}</text>
            </view>
          </view>
        </view>
      </view>
    </template>
    <QwEmpty v-else-if="error" :title="error" />
    <!-- at hand: approve and reject of my review task, else the last two (the initiator's urge, cancel) -->
    <view v-if="acts.length" :class="`qw-decide-bar${more.length ? ' has-more' : ''}`">
      <view v-if="more.length" class="qw-decide-bar__more" role="button" @click="moreOpen = true">
        <QwIcon name="more" size="44rpx" />
        <text>{{ t('approval.decide.more') }}</text>
      </view>
      <wd-button
        v-for="(x, i) in shown"
        :key="x.action"
        :custom-class="`qw-btn qw-decide-bar__${x.action}${
          shown.length > 1 && i === shown.length - 1 ? ' qw-decide-bar__main' : ''
        }${SOLID.has(x.action) ? ' qw-btn--primary' : ''}`"
        :type="DANGER.has(x.action) ? 'danger' : 'primary'"
        :variant="SOLID.has(x.action) ? 'base' : DANGER.has(x.action) ? 'plain' : 'soft'"
        :loading="x.action === 'urge' && urging"
        :disabled="x.action === 'urge' && urging"
        @click="act(x)"
      >
        {{ t(`approval.decide.${x.action}`) }}
      </wd-button>
    </view>
    <wd-action-sheet
      v-model="moreOpen"
      :actions="more"
      :cancel-text="t('common.action.cancel')"
      @select="pickMore"
    />
    <DecideSheet ref="sheet" :signs="signs" @done="decided" />
  </view>
</template>
<script setup lang="ts">
import { computed, reactive, ref, shallowRef, watch } from 'vue'
import { onLoad, onShow } from '@dcloudio/uni-app'
import type { DictPayload, FormSchema, WfInstanceDetailVo } from '@qiwu/shared'
import {
  avatar,
  detailActions,
  editPage,
  formPage,
  loadInstance,
  loadSummary,
  modelIcon,
  mySigns,
  stateTag,
  targetNames,
  urge,
  type FormSummary,
  type WfAction,
  type WfOn,
} from '@/core/approvals'
import QwEmpty from '@/core/components/QwEmpty.vue'
import QwIcon, { type IconName } from '@/core/components/QwIcon.vue'
import { formatTime } from '@/core/format'
import { t, tx } from '@/core/i18n'
import { loadDict } from '@/core/pickers'
import { ApiError, errorText } from '@/core/request'
import { useAuthStore } from '@/core/stores/auth'
import DecideSheet from './DecideSheet.vue'
import QwProcessForm from '../form/QwProcessForm.vue'
import {
  checkValues,
  editableValues,
  formDicts,
  formText,
  formTitles,
  processForm,
} from '../form/process-form'

/**
 * 审批详情 (subpackage pages-wf): an instance the caller may see (`?id=`; the API answers 404
 * otherwise, shown here with its message). Its head (model, state, initiator and start, my turn), its form
 * (a dynamic form's fields through QwProcessForm, my step's `edit` ones editable; a custom form's
 * business page through the mobile view registry, with its key fields when the registry has a summary; else
 * 请在电脑端查看) and its timeline (seeded step names are keys, `tx()`), my pending step last. What I may do on
 * it (detailActions) in a bar at the bottom, the rest under 更多, each through DecideSheet but
 * urge; approve and resubmit check and send the `edit` fields first; done, the instance reloads. Sent back to
 * me, the initiator (发起): resubmit, a mapped custom form's through its edit page (core/views.ts), which
 * resubmits and comes back here: the page reloads when shown back from it.
 */
const inst = shallowRef<WfInstanceDetailVo>()
const error = shallowRef('')
/** undefined while it loads (nothing shows), null: none (the one form row shows) */
const summary = shallowRef<FormSummary | null>()
const auth = useAuthStore()

type Dict = 'wf.instance_state' | 'wf.action'
const dicts = reactive<Partial<Record<Dict, DictPayload>>>({})
for (const code of ['wf.instance_state', 'wf.action'] as const)
  loadDict(code).then(
    (d) => (dicts[code] = d),
    () => {}, // shown by the request layer; tags show their codes
  )
/** a dict state as a pill */
const pill = (dict: Dict, code: string) => stateTag(dicts[dict], code)
const state = computed(() => pill('wf.instance_state', inst.value?.state ?? ''))
const icon = computed(() => (inst.value ? modelIcon(inst.value) : 'doc'))
const startedBy = computed(() =>
  inst.value
    ? t('approval.startedByAt', {
        name: inst.value.initiator.name ?? '',
        time: formatTime(inst.value.startedAt),
      })
    : '',
)
/** my oldest pending task: the head's "your turn" and the timeline's last node */
const turn = computed(() => inst.value?.myTasks[0])
const myName = computed(() => auth.me?.user.displayName ?? '')
const myFace = computed(() => avatar(myName.value, auth.me?.user.id ?? null))

/** §12.4: an action's corner mark on the actor's avatar (the rest: none) */
const MARKS: Partial<Record<string, { icon: IconName; tone: string }>> = {
  begin: { icon: 'send', tone: 'brand' },
  resubmit: { icon: 'send', tone: 'brand' },
  approve: { icon: 'check', tone: 'success' },
  reject: { icon: 'close', tone: 'danger' },
  send_back: { icon: 'undo', tone: 'warning' },
}
const events = computed(() =>
  (inst.value?.timeline ?? []).map((e) => {
    const who = e.actor?.name ?? t('approval.system')
    return {
      id: e.id,
      who,
      face: avatar(who, e.actor ? e.actor.id : null),
      mark: MARKS[e.action],
      tag: pill('wf.action', e.action),
      time: formatTime(e.createdAt),
      node: e.nodeName ? tx(e.nodeName) : '',
      targets: e.targets.length ? targetNames(e) : '',
      comment: e.comment,
    }
  }),
)

const form = computed(() => (inst.value ? formPage(inst.value) : null))
/** a dynamic form, without my `hide` fields (null: none, or it does not pass the whitelist: 请在电脑端查看) */
const pf = computed<FormSchema | null>(() =>
  inst.value?.formKind === 'dynamic' && inst.value.schema
    ? processForm(inst.value.schema, inst.value.access)
    : null,
)
const values = ref<Record<string, unknown>>({})
const formErrors = shallowRef<Record<string, string>>({})
let formDictsLoaded: Awaited<ReturnType<typeof formDicts>> = new Map()
/** my `edit` fields checked (the server's rules), field → message; their values when they pass */
function checkEdits(): Record<string, unknown> | null {
  const f = pf.value
  const i = inst.value
  if (!f || !i) return {}
  const fields = Object.fromEntries(Object.entries(i.fields).filter(([k]) => i.access[k] === 'edit'))
  const edits = editableValues(values.value, i.access)
  formErrors.value = checkValues(fields, f, edits, formDictsLoaded, formTitles(f, formText(f)))
  return Object.keys(formErrors.value).length ? null : edits
}
// once shown, the messages follow the input
watch(values, () => {
  if (Object.keys(formErrors.value).length) checkEdits()
})
const openForm = () => void (form.value && uni.navigateTo({ url: form.value }))

const acts = computed(() => (inst.value ? detailActions(inst.value) : []))
const signs = computed(() => (inst.value ? mySigns(inst.value) : []))
/** in the bar, the main one last: approve and reject of my review task, else the last two */
const shown = computed(() => {
  const main = acts.value.filter((x) => x.action === 'approve' || x.action === 'reject')
  return (main.length ? main : acts.value.slice(-2)).reverse()
})
const more = computed(() =>
  acts.value
    .filter((x) => !shown.value.includes(x))
    .map((value) => ({ name: t(`approval.decide.${value.action}`), value })),
)
const moreOpen = ref(false)
const sheet = ref<InstanceType<typeof DecideSheet>>()
/** solid: the main one (approve, the initiator's urge or resubmit); red outline: reject, cancel; the rest soft */
const SOLID = new Set<WfAction>(['approve', 'urge', 'resubmit'])
const DANGER = new Set<WfAction>(['reject', 'cancel'])
function act(on: WfOn) {
  const edit = on.action === 'resubmit' && inst.value && editPage(inst.value, on.id)
  if (edit) {
    reloadOnShow = true
    uni.navigateTo({ url: edit })
  } else if (on.action === 'urge') void doUrge()
  else if ((on.action === 'approve' || on.action === 'resubmit') && pf.value) void withEdits(on)
  else sheet.value?.open(on)
}
/** approve, resubmit of a dynamic form: my `edit` fields pass first, then go with the action */
async function withEdits(on: WfOn) {
  if (Object.values(inst.value!.access).includes('edit'))
    try {
      formDictsLoaded = await formDicts(pf.value!)
    } catch {
      return // shown by the request layer
    }
  const edits = checkEdits()
  if (edits) sheet.value?.open(on, Object.keys(edits).length ? edits : undefined)
}
const pickMore = ({ item }: { item: { value: WfOn } }) => act(item.value)

/** 催办 (the initiator): once an hour, the server's 429 said as "try again later" */
const urging = ref(false)
async function doUrge() {
  if (urging.value) return
  urging.value = true
  try {
    await urge(id)
    uni.showToast({ title: t('approval.decide.urged'), icon: 'none' })
    await load()
  } catch (e) {
    const later = e instanceof ApiError && e.status === 429
    uni.showToast({ title: later ? t('approval.decide.urgeLater') : errorText(e), icon: 'none' })
  } finally {
    urging.value = false
  }
}

let id = 0
async function load() {
  try {
    inst.value = await loadInstance(id)
  } catch (e) {
    error.value = errorText(e)
    return
  }
  values.value = { ...inst.value.formValues }
  formErrors.value = {}
  summary.value = await loadSummary(inst.value)
}

onLoad((query) => {
  uni.setNavigationBarTitle({ title: t('approval.detail') })
  id = Number(query?.id)
  // the perms editPage asks and my name (opened straight, e.g. an H5 reload)
  if (!auth.me) auth.fetchMe().catch(() => {})
})
/**
 * Shown first, and back from a page that acted on it (the edit page's resubmit): reload. Not on any other
 * show: a file or photo picker (mp-weixin's chooseMessageFile, App's album and camera) shows the page again
 * when it returns, and a reload would drop the `edit` fields changed and the files just uploaded.
 */
let reloadOnShow = true
onShow(() => {
  if (!reloadOnShow) return
  reloadOnShow = false
  void load()
})

async function decided() {
  uni.showToast({ title: t('approval.decide.done'), icon: 'none' })
  await load()
}
</script>

<style>
/* room for the decision bar */
.qw-detail.has-bar {
  padding-bottom: calc(68px + var(--qw-space-4) + env(safe-area-inset-bottom));
}

/* head: 44 model tile, the model 34rpx/650 and its state, who started it when; my turn as a brand strip */
.qw-wf__head {
  padding: 32rpx;
}

.qw-wf__top {
  display: flex;
  align-items: flex-start;
  gap: 24rpx;
}

.qw-wf__icon {
  width: 82rpx;
  height: 82rpx;
}

.qw-wf__main {
  flex: 1;
  min-width: 0;
}

.qw-wf__line {
  display: flex;
  align-items: center;
  gap: var(--qw-space-2);
}

.qw-wf__title {
  flex: 1;
  min-width: 0;
  font-size: var(--qw-fs-title);
  font-weight: 650;
  line-height: 1.3;
  color: var(--qw-text);
}

.qw-wf__meta {
  display: block;
  margin-top: 6rpx;
  font-size: var(--qw-fs-caption);
  color: var(--qw-text-3);
  font-variant-numeric: tabular-nums;
}

.qw-wf__turn {
  display: flex;
  align-items: center;
  gap: var(--qw-space-2);
  margin-top: 26rpx;
  padding: 20rpx 24rpx;
  border-radius: var(--qw-radius);
  font-size: var(--qw-fs-body);
  font-weight: 500;
  color: var(--qw-brand-text);
  background: var(--qw-brand-weak);
}

/* a card with a 48 high title row (the form summary, the timeline) */
.qw-wf__box {
  padding: 8rpx 32rpx 12rpx;
}

.qw-wf__box-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 90rpx;
}

.qw-wf__box-title {
  font-size: var(--qw-fs-body-lg);
  font-weight: 600;
  color: var(--qw-text);
}

/* no summary: one row, "form" and where to see it */
.qw-wf__form {
  display: flex;
  align-items: center;
  gap: var(--qw-space-2);
  min-height: 100rpx;
  padding: 0 24rpx 0 32rpx;
  font-size: var(--qw-fs-body-lg);
  color: var(--qw-text-3);
}

.qw-wf__form-name {
  flex: 1;
  color: var(--qw-text);
}

/* the timeline (§12.4): 36 avatars with an action mark, a 2px line between them */
.qw-tl {
  display: flex;
  flex-direction: column;
  padding: 8rpx 0 20rpx;
}

.qw-tl__item {
  position: relative;
  display: flex;
  gap: 24rpx;
  padding-bottom: 34rpx;
}

.qw-tl__item:not(:last-child)::before {
  content: '';
  position: absolute;
  top: 76rpx;
  bottom: 8rpx;
  left: 33rpx;
  width: 2px;
  border-radius: 1px;
  background: var(--qw-border);
}

.qw-tl__node {
  position: relative;
  flex: none;
  align-self: flex-start;
}

.qw-tl__av {
  width: 68rpx;
  height: 68rpx;
  font-size: var(--qw-fs-body);
}

/* my turn: a ring in the brand colour on the surface */
.qw-tl__item.is-pending .qw-tl__av {
  color: var(--qw-brand-text);
  background: var(--qw-surface);
  box-shadow: inset 0 0 0 1.5px var(--qw-brand);
}

/* solid semantic marks: the semantic text colour as ground, the surface colour as icon and ring (§12.6) */
.qw-tl__mark {
  position: absolute;
  right: -6rpx;
  bottom: -6rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30rpx;
  height: 30rpx;
  border-radius: 50%;
  color: var(--qw-surface);
  box-shadow: 0 0 0 2px var(--qw-surface);
}

.qw-tl__mark--brand {
  background: var(--qw-brand-text);
}

.qw-tl__mark--success {
  background: var(--qw-success);
}

.qw-tl__mark--danger {
  background: var(--qw-danger);
}

.qw-tl__mark--warning {
  background: var(--qw-warning);
}

.qw-tl__body {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  padding-top: 2rpx;
}

.qw-tl__line {
  display: flex;
  align-items: center;
  gap: var(--qw-space-2);
}

.qw-tl__who {
  overflow: hidden;
  font-size: var(--qw-fs-body-lg);
  font-weight: 600;
  color: var(--qw-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.qw-tl__time {
  flex: none;
  margin-left: auto;
  font-size: var(--qw-fs-caption);
  color: var(--qw-text-3);
  font-variant-numeric: tabular-nums;
}

.qw-tl__step {
  margin-top: 4rpx;
  font-size: var(--qw-fs-caption);
  color: var(--qw-text-2);
}

.qw-tl__comment {
  margin-top: var(--qw-space-2);
  padding: 16rpx 24rpx;
  border-radius: var(--qw-radius);
  font-size: var(--qw-fs-body);
  line-height: 1.5;
  color: var(--qw-text-2);
  white-space: pre-line;
  word-break: break-word;
  background: var(--qw-surface-2);
}

/* the bar (§12.4): surface, the upward shadow (dark: the border line), [more][secondary 1][main 1.5]; a
   soft button's text in the brand text colour (wot-ui's fill colour is under 4.5:1 on the weak ground) */
.qw-decide-bar {
  --wot-button-primary-color: var(--qw-brand-text);
  position: fixed;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 20rpx;
  padding: 20rpx var(--qw-space-4) calc(20rpx + env(safe-area-inset-bottom));
  border-top: 1px solid var(--qw-border);
  background: var(--qw-surface);
  box-shadow: var(--qw-shadow-up);
}

.qw-decide-bar.has-more {
  padding-left: 16rpx;
}

.qw-decide-bar .wd-button {
  flex: 1;
  min-width: 0;
}

.qw-decide-bar .wd-button.qw-decide-bar__main {
  flex: 1.5;
}

/* "more": the icon over its name, 52 wide */
.qw-decide-bar__more {
  display: flex;
  flex: none;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4rpx;
  width: 97rpx;
  height: 90rpx;
  font-size: var(--qw-fs-micro);
  font-weight: 500;
  color: var(--qw-text-2);
}
</style>
