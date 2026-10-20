<script setup lang="ts">
import {
  computed,
  nextTick,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  ref,
  shallowRef,
  watch,
} from 'vue'
import { useI18n } from 'vue-i18n'
import { useIntervalFn } from '@vueuse/core'
import dayjs from 'dayjs'
import {
  PAGE_SIZE_MAX,
  RT,
  wxoaPerms,
  type WxoaFanVo,
  type WxoaMessageVo,
  type WxoaSendWindowVo,
} from '@qiwu/shared'
import { wxoaMessageApi } from '@/api/platform/wxoa/message'
import DictTag from '@/core/components/DictTag.vue'
import EmptyState from '@/core/components/EmptyState.vue'
import { toastRest } from '@/core/composables/use-crud'
import { usePerm } from '@/core/permission'
import { onRealtime } from '@/core/realtime/socket'
import AccountSwitch from '../components/AccountSwitch.vue'
import WxoaMessageBody from '../components/MessageBody.vue'
import { useWxoaAccount } from '../components/use-wxoa-account'
import WxoaChatComposer from './composer.vue'

/**
 * Conversations of an official account (see docs/design-notes.md#wxoa): the fans by their last message
 * on the left, one fan's messages (plain text) with its two send windows on the right, and the
 * customer-service composer. The page holds sending; reading needs the message log's view permission
 * too. A new inbound message (`wxoa:message`) reloads what is shown once, 1.5 s after the first push.
 */
// keep-alive name = the seeded menu's component_name
defineOptions({ name: 'WxoaChat' })

const { t } = useI18n()
const perm = usePerm()
const canRead = computed(() => perm.has(wxoaPerms.message.browse))
const canSend = computed(() => perm.has(wxoaPerms.message.send))
const { accountId } = useWxoaAccount()
const time = (iso: string | null) => (iso ? dayjs(iso).format('MM-DD HH:mm:ss') : '')

// recent conversations: the first ones, more on request (up to one page of the largest size)
const CONVERSATIONS_STEP = 50
const conversationSize = ref(CONVERSATIONS_STEP)
const fans = shallowRef<WxoaFanVo[]>([])
const fanTotal = ref(0)
const fansLoading = ref(false)
let fanSeq = 0
async function loadConversations() {
  const id = accountId.value
  const mine = ++fanSeq
  if (id == null || !canRead.value) return
  fansLoading.value = true
  try {
    const page = await wxoaMessageApi.conversations({
      accountId: id,
      page: 1,
      pageSize: conversationSize.value,
      sort: '-lastInboundAt',
    })
    if (mine !== fanSeq) return
    fans.value = page.items
    fanTotal.value = page.total
    const open = page.items.find((f) => f.id === fan.value?.id)
    if (open) fan.value = open
  } catch (e) {
    if (mine === fanSeq) toastRest(e)
  } finally {
    if (mine === fanSeq) fansLoading.value = false
  }
}
const canLoadMore = computed(
  () => fans.value.length < fanTotal.value && conversationSize.value < PAGE_SIZE_MAX,
)
function loadMore() {
  conversationSize.value = Math.min(PAGE_SIZE_MAX, conversationSize.value + CONVERSATIONS_STEP)
  void loadConversations()
}
const fanName = (f: WxoaFanVo) => f.remark || f.openId

// the open conversation: its messages oldest first, earlier ones on request
const MESSAGES_LIMIT = 50
const fan = shallowRef<WxoaFanVo | null>(null)
const messages = shallowRef<WxoaMessageVo[]>([])
const hasEarlier = ref(false)
const messagesLoading = ref(false)
const sendWindow = shallowRef<WxoaSendWindowVo | null>(null)
let messageSeq = 0

const streamRef = ref<HTMLElement>()
const atBottom = () => {
  const el = streamRef.value
  return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 40
}
async function toBottom() {
  await nextTick()
  const el = streamRef.value
  if (el) el.scrollTop = el.scrollHeight
}

function mergeById(...lists: WxoaMessageVo[][]) {
  const byId = new Map<number, WxoaMessageVo>()
  for (const list of lists) for (const m of list) byId.set(m.id, m)
  return [...byId.values()].sort((a, b) => a.id - b.id)
}

/** the newest messages, merged into those shown (rows shown again come updated, e.g. a send state) */
async function loadLatest(scroll = false) {
  const id = fan.value?.id
  if (id == null) return
  const mine = messageSeq
  // only the first load covers the stream; a reload must not end the spinner of loading earlier ones
  const showLoading = !messages.value.length
  if (showLoading) messagesLoading.value = true
  const follow = scroll || atBottom()
  try {
    const newest = (await wxoaMessageApi.fanMessages(id, { limit: MESSAGES_LIMIT })).reverse()
    if (mine !== messageSeq) return
    // merged into what is shown now: other loads may have finished meanwhile
    const shown = messages.value
    // a full page newer than all shown: there may be a gap, so start over from it
    const gap =
      newest.length === MESSAGES_LIMIT && shown.length > 0 && newest[0]!.id > shown.at(-1)!.id
    if (gap || !shown.length) hasEarlier.value = newest.length === MESSAGES_LIMIT
    messages.value = gap ? newest : mergeById(shown, newest)
    if (follow) await toBottom()
  } catch (e) {
    if (mine === messageSeq) toastRest(e)
  } finally {
    if (showLoading && mine === messageSeq) messagesLoading.value = false
  }
}
async function loadEarlier() {
  const id = fan.value?.id
  const first = messages.value[0]
  if (id == null || !first || messagesLoading.value) return
  const mine = messageSeq
  messagesLoading.value = true
  try {
    const earlier = await wxoaMessageApi.fanMessages(id, {
      beforeId: first.id,
      limit: MESSAGES_LIMIT,
    })
    if (mine !== messageSeq) return
    // 记下距底部的高度，插入更早的消息后恢复，正在看的那条不被顶走
    const el = streamRef.value
    const fromBottom = el ? el.scrollHeight - el.scrollTop : 0
    messages.value = mergeById(earlier, messages.value)
    hasEarlier.value = earlier.length === MESSAGES_LIMIT
    await nextTick()
    if (el) el.scrollTop = el.scrollHeight - fromBottom
  } catch (e) {
    if (mine === messageSeq) toastRest(e)
  } finally {
    if (mine === messageSeq) messagesLoading.value = false
  }
}
async function loadWindow() {
  const id = fan.value?.id
  if (id == null) return
  const mine = messageSeq
  try {
    const w = await wxoaMessageApi.window(id)
    if (mine === messageSeq) sendWindow.value = w
  } catch (e) {
    if (mine === messageSeq) toastRest(e)
  }
}
function openFan(f: WxoaFanVo | null) {
  if (f?.id === fan.value?.id) return
  messageSeq++
  fan.value = f
  messages.value = []
  hasEarlier.value = false
  messagesLoading.value = false
  sendWindow.value = null
  if (!f) return
  void loadLatest(true)
  void loadWindow()
}

// the two customer-service windows: deadline and messages used (WeChat counts, the server checks times)
const WINDOWS = ['inbound', 'event'] as const
const now = shallowRef(Date.now())
useIntervalFn(() => (now.value = Date.now()), 15_000)
const isOpen = (until: string | null) => until != null && dayjs(until).isAfter(now.value)
function windowText(key: (typeof WINDOWS)[number]) {
  const w = sendWindow.value?.[key]
  if (!w) return ''
  if (w.until == null) return t('wxoa.chat.window.never')
  const params = { time: time(w.until), used: w.used, max: w.max }
  return isOpen(w.until) ? t('wxoa.chat.window.open', params) : t('wxoa.chat.window.closed', params)
}
const windowsClosed = computed(() => {
  const w = sendWindow.value
  return w != null && WINDOWS.every((k) => !isOpen(w[k].until))
})

// inbound image and voice copies may be sent again (to this fan or, after switching, another one)
const composerRef = ref<InstanceType<typeof WxoaChatComposer>>()
const forwardable = (m: WxoaMessageVo) =>
  canSend.value &&
  m.direction === 'in' &&
  m.objectId != null &&
  (m.msgKind === 'image' || m.msgKind === 'voice')
function forward(m: WxoaMessageVo) {
  if (m.objectId != null && (m.msgKind === 'image' || m.msgKind === 'voice'))
    composerRef.value?.forward(m.objectId, m.msgKind)
}
function onSent() {
  void loadLatest(true)
  void loadWindow()
}

// every new inbound message of every account is pushed to every admin: the first push of this
// account waits 1.5 s and takes the pushes meanwhile along, then what is shown reloads once
const REFRESH_DELAY_MS = 1500
let active = true
let stale = false
let refreshTimer: ReturnType<typeof setTimeout> | undefined
function refreshShown() {
  refreshTimer = undefined
  if (!active) {
    stale = true
    return
  }
  void loadConversations()
  void loadLatest()
  void loadWindow()
}
onRealtime(RT.wxoaMessage, (pushed) => {
  if (!canRead.value || pushed.accountId !== accountId.value || refreshTimer) return
  refreshTimer = setTimeout(refreshShown, REFRESH_DELAY_MS)
})
// kept alive: nothing reloads while hidden, once shown again if a push came meanwhile
onDeactivated(() => (active = false))
onActivated(() => {
  active = true
  if (!stale) return
  stale = false
  refreshShown()
})
onBeforeUnmount(() => clearTimeout(refreshTimer))

watch(accountId, () => {
  // nothing of the previous account stays on screen
  fans.value = []
  fanTotal.value = 0
  conversationSize.value = CONVERSATIONS_STEP
  openFan(null)
  void loadConversations()
})
void loadConversations()
</script>

<template>
  <div class="qw-page">
    <el-alert v-if="!canRead" type="warning" :closable="false" show-icon>
      <template #title>{{ t('wxoa.chat.needsBrowse') }}</template>
    </el-alert>
    <template v-else>
      <AccountSwitch />
      <div v-if="accountId != null" class="wxoa-chat">
        <aside class="wxoa-chat__fans" :aria-label="t('wxoa.chat.conversations')">
          <div class="wxoa-chat__title">{{ t('wxoa.chat.conversations') }}</div>
          <ul v-loading="fansLoading" class="wxoa-chat__list">
            <li v-for="f in fans" :key="f.id">
              <button
                type="button"
                class="wxoa-chat__fan"
                :class="{ 'is-active': f.id === fan?.id }"
                :aria-pressed="f.id === fan?.id"
                @click="openFan(f)"
              >
                <span class="wxoa-chat__name">{{ fanName(f) }}</span>
                <span class="wxoa-chat__sub">
                  {{ time(f.lastInboundAt) }}
                  <el-tag v-if="!f.subscribed" size="small" type="info">
                    {{ t('wxoa.chat.unsubscribed') }}
                  </el-tag>
                  <el-tag v-if="f.blocked" size="small" type="danger">
                    {{ t('wxoa.chat.blocked') }}
                  </el-tag>
                </span>
              </button>
            </li>
          </ul>
          <EmptyState v-if="!fansLoading && !fans.length" :title="t('wxoa.chat.noConversations')" />
          <el-button v-if="canLoadMore" link type="primary" @click="loadMore">
            {{ t('wxoa.chat.more') }}
          </el-button>
        </aside>

        <section class="wxoa-chat__main">
          <EmptyState v-if="!fan" :title="t('wxoa.chat.pick')" />
          <template v-else>
            <header class="wxoa-chat__head">
              <span class="wxoa-chat__name">{{ fanName(fan) }}</span>
              <span v-if="fan.remark" class="wxoa-chat__sub">{{ fan.openId }}</span>
            </header>
            <dl v-if="sendWindow" class="wxoa-chat__windows">
              <template v-for="k in WINDOWS" :key="k">
                <dt>{{ t(`wxoa.chat.window.${k}`) }}</dt>
                <dd>{{ windowText(k) }}</dd>
              </template>
            </dl>
            <el-alert
              v-if="windowsClosed"
              type="warning"
              :closable="false"
              :title="t('wxoa.chat.window.allClosed')"
            />
            <div ref="streamRef" v-loading="messagesLoading" class="wxoa-chat__stream" role="log">
              <el-button v-if="hasEarlier" link type="primary" @click="loadEarlier">
                {{ t('wxoa.chat.earlier') }}
              </el-button>
              <div
                v-for="m in messages"
                :key="m.id"
                class="wxoa-chat__item"
                :class="`is-${m.direction}`"
              >
                <div class="wxoa-chat__bubble"><WxoaMessageBody :message="m" /></div>
                <div class="wxoa-chat__meta">
                  <span>{{ time(m.occurredAt) }}</span>
                  <DictTag v-if="m.direction === 'out'" code="wxoa.channel" :value="m.channel" />
                  <DictTag v-if="m.sendState" code="wxoa.send_state" :value="m.sendState" />
                  <el-button
                    v-if="forwardable(m)"
                    link
                    type="primary"
                    size="small"
                    @click="forward(m)"
                  >
                    {{ t('wxoa.chat.forward') }}
                  </el-button>
                </div>
              </div>
              <EmptyState
                v-if="!messagesLoading && !messages.length"
                :title="t('wxoa.chat.noMessages')"
              />
            </div>
            <WxoaChatComposer
              v-if="canSend"
              ref="composerRef"
              :account-id="accountId"
              :fan-id="fan.id"
              @sent="onSent"
            />
          </template>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.wxoa-chat {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}
.wxoa-chat__fans,
.wxoa-chat__main {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: var(--qw-surface);
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius);
  box-shadow: var(--qw-shadow-1);
}
.wxoa-chat__fans {
  flex: none;
  width: 280px;
}
.wxoa-chat__main {
  flex: 1;
  min-width: 0;
}
.wxoa-chat__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--qw-text);
}
.wxoa-chat__list {
  max-height: 70vh;
  min-height: 120px;
  padding: 0;
  margin: 0;
  overflow: auto;
  list-style: none;
}
.wxoa-chat__fan {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: 8px;
  font: inherit;
  color: var(--qw-text);
  text-align: left;
  cursor: pointer;
  background: none;
  border: 0;
  border-radius: var(--qw-radius-sm);
}
.wxoa-chat__fan:hover {
  background: var(--qw-surface-2);
}
.wxoa-chat__fan.is-active {
  color: var(--qw-brand-text);
  background: var(--qw-brand-weak);
}
.wxoa-chat__fan:focus-visible {
  outline: 2px solid var(--qw-brand);
}
.wxoa-chat__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wxoa-chat__sub {
  display: flex;
  gap: 4px;
  align-items: center;
  font-size: 12px;
  color: var(--qw-text-3);
}
.wxoa-chat__head {
  display: flex;
  gap: 8px;
  align-items: baseline;
  font-weight: 600;
}
.wxoa-chat__windows {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  margin: 0;
  font-size: 13px;
}
.wxoa-chat__windows dt {
  color: var(--qw-text-2);
}
.wxoa-chat__windows dd {
  margin: 0;
}
.wxoa-chat__stream {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 50vh;
  padding: 8px;
  overflow: auto;
  background: var(--qw-surface-2);
  border-radius: var(--qw-radius-sm);
}
.wxoa-chat__item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: flex-start;
  max-width: 75%;
}
.wxoa-chat__item.is-out {
  align-self: flex-end;
  align-items: flex-end;
}
.wxoa-chat__bubble {
  padding: 8px 12px;
  background: var(--qw-surface);
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius);
}
.is-out .wxoa-chat__bubble {
  background: var(--qw-brand-weak);
}
.wxoa-chat__meta {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 12px;
  color: var(--qw-text-3);
}
/* narrow screens: the conversation list stacks above the messages */
@media (max-width: 1100px) {
  .wxoa-chat {
    flex-direction: column;
    align-items: stretch;
  }
  .wxoa-chat__fans {
    width: auto;
  }
  .wxoa-chat__list {
    max-height: 240px;
  }
}
</style>
