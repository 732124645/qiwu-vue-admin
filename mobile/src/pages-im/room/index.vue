<template>
  <view class="qw-im-room-page">
    <view v-if="group" class="qw-im-bar" role="link" @click="openGroup">
      <text class="qw-im-bar__text">
        {{ t('im.group.members', { n: room?.detail?.memberCount ?? 0 }) }}
      </text>
      <text v-if="closed" class="qw-tag qw-tag--info is-plain">{{ t('im.group.closed') }}</text>
      <QwIcon class="qw-im-bar__chev" name="chevron-right" size="30rpx" />
    </view>
    <!-- #ifndef MP-WEIXIN -->
    <view v-if="imCalls.media.state === 'disconnecting'" class="qw-im-media-bar">
      <text>{{ t('imMedia.call.cleanup') }}</text>
      <button
        class="qw-im-media-button"
        role="button"
        :tabindex="imCallCleanupBusy ? -1 : 0"
        :aria-disabled="imCallCleanupBusy"
        @keydown="activateImMediaButton($event, imCallCleanupBusy, retryImCallDisconnect)"
        size="mini"
        :loading="imCallCleanupBusy"
        :disabled="imCallCleanupBusy"
        @click="retryImCallDisconnect"
      >
        {{ t('imMedia.call.retryDisconnect') }}
      </button>
    </view>
    <view v-if="activeCall" class="qw-im-media-bar">
      <text
        >{{ t('imMedia.call.' + activeCall.mode) }} ·
        {{ t('imMedia.call.state.' + activeCall.state) }}</text
      >
      <button
        class="qw-im-media-button"
        role="button"
        :tabindex="0"
        :aria-disabled="false"
        @keydown="
          activateImMediaButton($event, false, () => activeCall && openImCallPage(activeCall.id))
        "
        size="mini"
        @click="openImCallPage(activeCall.id)"
      >
        {{ t('imMedia.call.open') }}
      </button>
    </view>
    <text v-if="mediaNotice" class="qw-im-media-error" role="alert">{{ mediaNotice }}</text>
    <!-- #endif -->
    <scroll-view
      class="qw-im-scroll"
      scroll-y
      :scroll-into-view="anchor"
      :upper-threshold="80"
      :lower-threshold="BOTTOM_SLACK"
      @scrolltoupper="older"
      @scrolltolower="reachBottom"
      @scroll="onScroll"
    >
      <view v-if="loadingOlder" class="qw-im-more"><wd-loading size="32rpx" /></view>
      <view
        v-for="e in entries"
        :id="`e${e.seq}`"
        :key="e.seq"
        :class="`qw-im-entry${e.kind === 'event' ? ' qw-im-entry--event' : ''}${mine(e) ? ' qw-im-entry--mine' : ''}`"
      >
        <text v-if="e.kind === 'event'" class="qw-im-event">
          {{ e.event ? eventText(e.event, directory) : '' }}
        </text>
        <template v-else>
          <view
            v-if="!mine(e)"
            :class="`qw-av qw-av--${avatarTone(e.authorId ?? 0)} qw-im-entry__av`"
            aria-hidden="true"
          >
            {{ initial(author(e)) }}
          </view>
          <view class="qw-im-entry__main">
            <text v-if="group && !mine(e)" class="qw-im-entry__who">{{ author(e) }}</text>
            <view
              v-if="e.recalledAt"
              class="qw-im-bubble qw-im-bubble--muted"
              @longpress="actions(e)"
            >
              <text>{{ t('im.recalled') }}</text>
            </view>
            <view
              v-else-if="e.kind === 'text'"
              class="qw-im-bubble qw-im-text"
              @longpress="actions(e)"
            >
              <!-- plain text (never HTML); <text> keeps line breaks and lets it be selected -->
              <text :user-select="true">{{ e.text }}</text>
              <text v-if="e.editedAt" class="qw-im-edited">{{ t('im.edited') }}</text>
            </view>
            <image
              v-else-if="e.kind === 'sticker' && e.stickerCode"
              class="qw-im-sticker"
              :src="builtinStickerSrc(e.stickerCode)"
              :aria-label="t(`im.sticker.${e.stickerCode}`)"
              @longpress="actions(e)"
            />
            <image
              v-else-if="(e.kind === 'image' || e.kind === 'sticker') && e.attachment"
              :class="e.kind === 'sticker' ? 'qw-im-sticker' : 'qw-im-image'"
              :src="urls[e.seq] || ''"
              mode="aspectFit"
              :style="e.kind === 'image' ? imageBox(e) : ''"
              :aria-label="t(e.kind === 'image' ? 'im.preview.image' : 'im.preview.sticker')"
              @click="openImage(e)"
              @longpress="actions(e)"
            />
            <view
              v-else-if="e.kind === 'voice' && e.attachment"
              class="qw-im-bubble qw-im-voice qw-im-media-button"
              :tabindex="mediaBusy ? -1 : 0"
              :aria-disabled="mediaBusy"
              :aria-pressed="voicePlaying(e)"
              @keydown="activateImMediaButton($event, mediaBusy, () => playImVoice(roomId, e))"
              role="button"
              :aria-label="t(voicePlaying(e) ? 'imMedia.voice.stop' : 'imMedia.voice.play')"
              @click="playImVoice(roomId, e)"
              @longpress="actions(e)"
            >
              <wd-loading v-if="voiceLoading(e)" size="30rpx" />
              <text>{{
                t(
                  voiceLoading(e)
                    ? 'imMedia.voice.loading'
                    : voicePlaying(e)
                      ? 'imMedia.voice.stop'
                      : 'imMedia.voice.play',
                )
              }}</text>
              <text>{{
                t('imMedia.voice.duration', { n: Math.ceil((e.attachment.durationMs ?? 0) / 1000) })
              }}</text>
            </view>
            <view
              v-else-if="e.kind === 'file' && e.attachment"
              class="qw-im-bubble qw-im-file"
              role="link"
              @click="openFile(e)"
              @longpress="actions(e)"
            >
              <QwIcon name="doc" size="44rpx" />
              <view class="qw-im-file__text">
                <text class="qw-im-file__name">{{ e.attachment.name }}</text>
                <text class="qw-im-file__size">{{ formatSize(e.attachment.size) }}</text>
              </view>
            </view>
          </view>
        </template>
      </view>
      <view
        v-for="o in outbox"
        :id="`o${o.clientEntryId}`"
        :key="o.clientEntryId"
        class="qw-im-entry qw-im-entry--mine qw-im-pending"
      >
        <view class="qw-im-entry__main">
          <view class="qw-im-bubble" @click="outboxActions(o)">
            <text>{{ outboxText(o) }}</text>
          </view>
          <text :class="`qw-im-state${o.state === 'failed' ? ' is-failed' : ''}`">
            {{ t(o.state === 'failed' ? 'im.failed' : 'im.sending') }}
          </text>
        </view>
      </view>
      <view id="qw-im-end" class="qw-im-end" />
    </scroll-view>

    <view v-if="closed" class="qw-im-closed">{{ t('im.group.closedHint') }}</view>
    <view v-else class="qw-im-composer">
      <!-- #ifndef MP-WEIXIN -->
      <view v-if="imVoice.roomId === roomId && imVoice.state !== 'idle'" class="qw-im-recording">
        <text>{{ recordingLabel }}</text>
        <button
          class="qw-im-media-button"
          role="button"
          :tabindex="0"
          :aria-disabled="false"
          @keydown="activateImMediaButton($event, false, finishImVoice)"
          v-if="imVoice.state === 'recording'"
          size="mini"
          @click="finishImVoice"
        >
          {{ t('imMedia.voice.finish') }}
        </button>
        <button
          class="qw-im-media-button"
          role="button"
          :tabindex="imVoice.state === 'stopping' ? -1 : 0"
          :aria-disabled="imVoice.state === 'stopping'"
          @keydown="activateImMediaButton($event, imVoice.state === 'stopping', cancelRecording)"
          size="mini"
          :loading="imVoice.state === 'stopping'"
          :disabled="imVoice.state === 'stopping'"
          @click="cancelRecording"
        >
          {{ t('imMedia.voice.cancel') }}
        </button>
      </view>
      <!-- #endif -->
      <view class="qw-im-composer__row">
        <textarea
          v-model="draft"
          class="qw-im-input"
          :placeholder="t('im.placeholder')"
          :maxlength="-1"
          auto-height
          :show-confirm-bar="false"
          :adjust-position="true"
          :aria-label="t('im.placeholder')"
          @focus="panel = ''"
        />
        <view
          :class="`qw-im-tool qw-im-tool--emoji${panel === 'emoji' ? ' is-on' : ''}`"
          role="button"
          :aria-label="t('im.emojiPanel')"
          @click="toggle('emoji')"
        >
          <text aria-hidden="true">{{ EMOJI_ICON }}</text>
        </view>
        <view
          :class="`qw-im-tool qw-im-tool--sticker${panel === 'sticker' ? ' is-on' : ''}`"
          role="button"
          :aria-label="t('im.stickers')"
          @click="toggle('sticker')"
        >
          <image class="qw-im-tool__img" :src="builtinStickerSrc('smile')" aria-hidden="true" />
        </view>
        <view
          v-if="draft.trim()"
          class="qw-im-send"
          role="button"
          :aria-label="t('im.send')"
          @click="sendText"
        >
          <QwIcon name="send" size="40rpx" />
        </view>
        <view
          v-else
          :class="`qw-im-tool qw-im-tool--more qw-im-media-button${panel === 'more' ? ' is-on' : ''}`"
          role="button"
          :aria-label="t('im.more')"
          tabindex="0"
          aria-disabled="false"
          @keydown="activateImMediaButton($event, false, () => toggle('more'))"
          @click="toggle('more')"
        >
          <QwIcon name="more" size="40rpx" />
        </view>
      </view>
      <scroll-view v-if="panel === 'emoji'" class="qw-im-panel" scroll-y>
        <view v-for="cat in IM_EMOJI_CATEGORIES" :key="cat.category" class="qw-im-panel__group">
          <text class="qw-im-panel__title">{{ t(`im.emoji.${cat.category}`) }}</text>
          <view class="qw-im-emoji-grid">
            <text
              v-for="ch in cat.items"
              :key="ch"
              class="qw-im-emoji"
              role="button"
              @click="draft += ch"
              >{{ ch }}</text
            >
          </view>
        </view>
      </scroll-view>
      <scroll-view v-else-if="panel === 'sticker'" class="qw-im-panel" scroll-y>
        <text class="qw-im-panel__title">{{ t('im.builtin') }}</text>
        <view class="qw-im-sticker-grid">
          <image
            v-for="code in IM_STICKER_CODES"
            :key="code"
            class="qw-im-sticker-item"
            :src="builtinStickerSrc(code)"
            role="button"
            :aria-label="t(`im.sticker.${code}`)"
            @click="sendSticker({ kind: 'sticker', stickerCode: code })"
          />
        </view>
        <view class="qw-sec qw-im-panel__sec">
          <text class="qw-im-panel__title">{{ t('im.mine') }}</text>
          <text class="qw-sec__link" role="link" @click="openStickers">{{ t('im.manage') }}</text>
        </view>
        <view class="qw-im-sticker-grid">
          <image
            v-for="s in myStickers"
            :key="s.id"
            class="qw-im-sticker-item"
            :src="stickerUrls[s.id] || ''"
            mode="aspectFit"
            role="button"
            :aria-label="t('im.preview.sticker')"
            @click="sendSticker({ kind: 'sticker', stickerId: s.id })"
          />
        </view>
        <text v-if="!myStickers.length" class="qw-im-panel__empty">{{ t('im.noStickers') }}</text>
      </scroll-view>
      <view v-else-if="panel === 'more'" class="qw-im-panel qw-im-more-panel">
        <!-- #ifndef MP-WEIXIN -->
        <button
          role="button"
          :tabindex="mediaBusy ? -1 : 0"
          :aria-disabled="mediaBusy"
          @keydown="activateImMediaButton($event, mediaBusy, recordVoice)"
          v-if="imOptions?.voiceEnabled"
          class="qw-im-media-button qw-im-media-action"
          :disabled="mediaBusy"
          :loading="imVoice.state === 'requesting' || imVoice.state === 'saving'"
          @click="recordVoice"
        >
          {{ t('imMedia.voice.record') }}
        </button>
        <button
          class="qw-im-media-button qw-im-media-action"
          role="button"
          :tabindex="mediaBusy || membersBusy ? -1 : 0"
          :aria-disabled="mediaBusy || membersBusy"
          @keydown="
            activateImMediaButton($event, mediaBusy || membersBusy, () => prepareCall('audio'))
          "
          v-if="imOptions?.callEnabled"
          :disabled="mediaBusy || membersBusy"
          :loading="membersBusy || imCalls.busy"
          @click="prepareCall('audio')"
        >
          {{ t('imMedia.call.startAudio') }}
        </button>
        <button
          class="qw-im-media-button qw-im-media-action"
          role="button"
          :tabindex="mediaBusy || membersBusy ? -1 : 0"
          :aria-disabled="mediaBusy || membersBusy"
          @keydown="
            activateImMediaButton($event, mediaBusy || membersBusy, () => prepareCall('video'))
          "
          v-if="imOptions?.callEnabled"
          :disabled="mediaBusy || membersBusy"
          :loading="membersBusy || imCalls.busy"
          @click="prepareCall('video')"
        >
          {{ t('imMedia.call.startVideo') }}
        </button>
        <!-- #endif -->
        <view class="qw-im-action qw-im-tool--image" role="button" @click="pickImage">
          <view class="qw-tile qw-tile--brand"><QwIcon name="card" size="40rpx" /></view>
          <text>{{ t('im.image') }}</text>
        </view>
        <view class="qw-im-action qw-im-tool--file" role="button" @click="pickFile">
          <view class="qw-tile qw-tile--brand"><QwIcon name="doc" size="40rpx" /></view>
          <text>{{ t('im.file') }}</text>
        </view>
      </view>
      <!-- #ifndef MP-WEIXIN -->
      <view v-if="callMode" class="qw-im-invite">
        <text class="qw-im-panel__title">{{ t('imMedia.call.select') }}</text>
        <text class="qw-im-panel__title">{{ t('imMedia.call.selectHint') }}</text>
        <scroll-view class="qw-im-invite-list" scroll-y>
          <view
            v-for="member in callMembers"
            :key="member.userId"
            class="qw-im-invite-member"
            role="checkbox"
            :aria-checked="selectedMembers.includes(member.userId)"
            @click="toggleCallMember(member.userId)"
          >
            <checkbox :checked="selectedMembers.includes(member.userId)" :disabled="imCalls.busy" />
            <text>{{ member.displayName }}</text>
          </view>
        </scroll-view>
        <text>{{ t('imMedia.call.selection', { n: selectedMembers.length }) }}</text>
        <button
          class="qw-im-media-button"
          role="button"
          :tabindex="imCalls.busy || !selectedMembers.length ? -1 : 0"
          :aria-disabled="imCalls.busy || !selectedMembers.length"
          @keydown="
            activateImMediaButton($event, imCalls.busy || !selectedMembers.length, inviteCall)
          "
          :loading="imCalls.busy"
          :disabled="imCalls.busy || !selectedMembers.length"
          @click="inviteCall"
        >
          {{ t('imMedia.call.invite') }}
        </button>
        <button
          class="qw-im-media-button"
          role="button"
          :tabindex="imCalls.busy ? -1 : 0"
          :aria-disabled="imCalls.busy"
          @keydown="activateImMediaButton($event, imCalls.busy, () => (callMode = null))"
          :disabled="imCalls.busy"
          @click="callMode = null"
        >
          {{ t('common.action.cancel') }}
        </button>
      </view>
      <!-- #endif -->
    </view>
  </view>
</template>

<script setup lang="ts">
import { activateImMediaButton } from '../../core/im/media-button'
import { computed, nextTick, onUnmounted, reactive, ref, shallowRef, watch } from 'vue'
import { onHide, onLoad, onReady, onShow, onUnload } from '@dcloudio/uni-app'
import {
  IM_EMOJI_CATEGORIES,
  IM_LIMITS,
  IM_STICKER_CODES,
  imCodePoints,
  imTextOk,
  type ImDirectory,
  type ImCallMode,
  type ImMember,
  type ImSticker,
} from '@qiwu/shared'
import type { ImDraft, ImEntryRecord, ImOutboxRecord, ImRoomRecord } from '@qiwu/shared/im-client'
import QwIcon from '@/core/components/QwIcon.vue'
import { formatSize } from '@/core/format'
import { t } from '@/core/i18n'
import { blobUrl, entryBlobUrl } from '@/core/im/blob-app'
import { stickerFileUrl } from '@/core/im/api'
import { imCurrent, imOpenChat, imOptions, imStart, imState, onImChange } from '@/core/im/client'
import {
  checkPick,
  chooseImFile,
  guessMime,
  keepPickedImage,
  outboxDiscardOnly,
  safeFileName,
} from '@/core/im/file-pick'
import {
  avatarTone,
  builtinStickerSrc,
  eventText,
  initial,
  kindText,
  roomTitle,
  userName,
} from '@/core/im/view'
import { chooseUploadFiles } from '@/core/pickers'
import { api, errorText } from '@/core/request'
import { useAuthStore } from '@/core/stores/auth'
import {
  imCallCleanupBusy,
  imCalls,
  openImCallPage,
  retryImCallDisconnect,
  startImCall,
} from '@/core/im/calls'
import { imMediaReserved } from '@/core/im/media'
import {
  cancelImVoice,
  finishImVoice,
  imVoice,
  imVoicePlaying,
  imVoiceRoomHide,
  imVoiceRoomShow,
  playImVoice,
  startImVoice,
} from '@/core/im/voice'

/**
 * One conversation (subpackage pages-im), rendered from the local cache at once: the newest rows first, older
 * ones as the user scrolls up (local first, then the server). The engine fetches only what is missing
 * (`afterSeq` when the room's last seq is past the local window) and reports changes; this page re-reads the
 * cache on each. Sending writes the outbox first (shown as pending), so nothing typed is lost offline. Plain
 * text only (never HTML); images and stickers show their cached thumbnails; files open with the system viewer.
 * Long press: copy, edit, recall, save as my sticker (the server decides; buttons are a convenience).
 */
type Panel = '' | 'emoji' | 'sticker' | 'more'
/** the emoji panel's button face: an emoji character, not an icon font */
const EMOJI_ICON = '\u{1F642}'
const PAGE = IM_LIMITS.entriesDefault

const auth = useAuthStore()
const roomId = ref(0)
const room = shallowRef<ImRoomRecord>()
const entries = shallowRef<ImEntryRecord[]>([])
const outbox = shallowRef<ImOutboxRecord[]>([])
const directory = shallowRef<ImDirectory>()
const myStickers = shallowRef<ImSticker[]>([])
const urls = reactive<Record<number, string>>({})
const stickerUrls = reactive<Record<number, string>>({})
const draft = ref('')
const panel = ref<Panel>('')
const anchor = ref('')
const loadingOlder = ref(false)
const callMode = ref<ImCallMode | null>(null)
const callMembers = shallowRef<ImMember[]>([])
const selectedMembers = ref<number[]>([])
const membersBusy = ref(false)
const clock = ref(Date.now())
const mediaBusy = computed(
  () => imMediaReserved.value || imCalls.value.busy || imVoice.value.state !== 'idle',
)
const activeCall = computed(() =>
  imCalls.value.calls.find((call) => call.roomId === roomId.value && call.state !== 'ended'),
)
const mediaNotice = computed(
  () =>
    imVoice.value.error ||
    (imCalls.value.error
      ? t(
          imCalls.value.error.code === 'UNCONFIGURED'
            ? 'imMedia.call.unconfigured'
            : imCalls.value.error.code === 'SDK_UNAVAILABLE'
              ? 'imMedia.call.unavailable'
              : 'imMedia.call.failed',
        )
      : ''),
)
const recordingLabel = computed(() =>
  imVoice.value.state === 'recording'
    ? t('imMedia.voice.recording', {
        n: Math.max(0, Math.floor((clock.value - imVoice.value.startedAt) / 1000)),
        max: imOptions.value?.voiceMaxSeconds ?? 60,
      })
    : t(`imMedia.voice.${imVoice.value.state}`),
)
const voicePlaying = (entry: ImEntryRecord) =>
  imVoicePlaying.value?.roomId === roomId.value &&
  imVoicePlaying.value.seq === entry.seq &&
  imVoicePlaying.value.playing
const voiceLoading = (entry: ImEntryRecord) =>
  imVoicePlaying.value?.roomId === roomId.value &&
  imVoicePlaying.value.seq === entry.seq &&
  imVoicePlaying.value.loading
let clockTimer: ReturnType<typeof setInterval> | undefined
watch(
  () => imVoice.value.state,
  (state) => {
    if (clockTimer) clearInterval(clockTimer)
    clockTimer = undefined
    if (state === 'recording') {
      clock.value = Date.now()
      clockTimer = setInterval(() => {
        clock.value = Date.now()
      }, 1000)
    }
  },
)
onUnmounted(() => {
  if (clockTimer) clearInterval(clockTimer)
})
/** how many of the newest local rows render (grows as the user scrolls up) */
let shown = PAGE
/** the page is in front (between onShow and onHide): only then does what it renders count as read */
let inFront = false
/** the list is scrolled to (near) its end: older rows the user scrolled up to are not the newest */
let atBottom = true
/** px from the end that still count as the end */
const BOTTOM_SLACK = 80
let viewHeight = 0

const group = computed(() => room.value?.detail?.kind === 'group')
const closed = computed(() => !!room.value?.detail?.closedAt)
const myId = () => auth.me?.user.id ?? 0
const mine = (e: ImEntryRecord) => e.authorId !== null && e.authorId === myId()
const author = (e: ImEntryRecord) => userName(directory.value, e.authorId, e.authorLabel)

/** 锁定或退出时同步清掉页面持有的正文与对象地址，迟到响应不能把它们恢复。 */
function clearRoom() {
  room.value = undefined
  entries.value = []
  outbox.value = []
  directory.value = undefined
  myStickers.value = []
  draft.value = ''
  panel.value = ''
  callMode.value = null
  callMembers.value = []
  selectedMembers.value = []
  membersBusy.value = false
  anchor.value = ''
  loadingOlder.value = false
  shown = PAGE
  stickersLoaded = false
  for (const key of Object.keys(urls)) delete urls[Number(key)]
  for (const key of Object.keys(stickerUrls)) delete stickerUrls[Number(key)]
}
watch(
  imState,
  () => {
    if (!imCurrent()) clearRoom()
  },
  { flush: 'sync' },
)

/** 从本地缓存重读本会话（行、发件箱、会话记录与通讯录快照），并补齐缩略图。 */
async function reload(scroll = false) {
  const ctx = imCurrent()
  if (!ctx || !roomId.value) return clearRoom()
  const id = roomId.value
  const [r, rows, out, dir] = await Promise.all([
    ctx.cache.getRoom(id),
    ctx.cache.getEntries(id, { order: 'desc', limit: shown }),
    ctx.cache.listOutbox(id),
    ctx.cache.getDirectory(),
  ])
  if (ctx !== imCurrent() || id !== roomId.value) return
  const grew = rows.length && rows[0]!.seq !== entries.value.at(-1)?.seq
  room.value = r
  entries.value = rows.reverse()
  outbox.value = out
  directory.value = dir?.data
  if (r) uni.setNavigationBarTitle({ title: roomTitle(r, dir?.data) })
  for (const e of entries.value)
    if (
      !urls[e.seq] &&
      e.attachment &&
      !e.recalledAt &&
      (e.kind === 'image' || e.kind === 'sticker')
    )
      entryBlobUrl(ctx.cache, id, e.seq, e.kind, e.attachment, true).then(
        (u) => {
          if (ctx === imCurrent() && id === roomId.value) urls[e.seq] = u
        },
        () => {},
      )
  // 新消息只在本来就在底部时跟到底；向上翻看旧消息时不打断，回到底部再报已读
  if (scroll || (grew && atBottom) || out.length) {
    await nextTick()
    if (ctx !== imCurrent()) return
    anchor.value = ''
    await nextTick()
    if (ctx !== imCurrent()) return
    anchor.value = 'qw-im-end'
    atBottom = true
  }
  markSeen()
}

/**
 * 上报已读：只在本页在前台、列表在底部（新消息真被看到）时，报已渲染的最大 seq（引擎防抖）；后台或向上翻
 * 看旧消息时不报，不因自己发消息把没渲染的标已读。
 */
function markSeen() {
  const last = entries.value.at(-1)
  if (last && inFront && atBottom) imCurrent()?.engine.markRead(roomId.value, last.seq)
}

function reachBottom() {
  atBottom = true
  markSeen()
}

/** 滚动时按离底部的距离判断是否在底部（回到底部由 scrolltolower 补报已读）。 */
function onScroll(e: { detail: { scrollTop: number; scrollHeight: number } }) {
  if (!viewHeight) return
  atBottom = e.detail.scrollHeight - e.detail.scrollTop - viewHeight <= BOTTOM_SLACK
}

/** 向上翻：本地还有就多渲染一批，没有再让引擎按 beforeSeq 取。 */
async function older() {
  const ctx = imCurrent()
  if (!ctx || loadingOlder.value) return
  loadingOlder.value = true
  try {
    if ((await ctx.cache.countEntries(roomId.value)) <= shown)
      await ctx.engine.loadOlder(roomId.value)
    if (ctx !== imCurrent()) return
    shown += PAGE
    const keep = entries.value[0]
    await reload()
    if (ctx === imCurrent() && keep) anchor.value = `e${keep.seq}`
  } catch {
    // 断网：保持现有
  } finally {
    loadingOlder.value = false
  }
}

/** 我的表情：读本地快照（打开聊天时已取过并带 ETag 复验；面板本身零请求）。 */
async function loadMyStickers() {
  const ctx = imCurrent()
  if (!ctx) return
  const snap = await ctx.cache.getStickers()
  if (ctx !== imCurrent()) return
  myStickers.value = snap?.data ?? []
  for (const s of myStickers.value)
    if (!stickerUrls[s.id])
      blobUrl(ctx.cache, `s:${s.sha256}`, null, stickerFileUrl(s.id)).then(
        (u) => {
          if (ctx === imCurrent()) stickerUrls[s.id] = u
        },
        () => {},
      )
}

let stickersLoaded = false
function toggle(p: Panel) {
  panel.value = panel.value === p ? '' : p
  // 内置表情是分包里的图片；我的表情读本地快照
  if (p === 'sticker' && !stickersLoaded) {
    stickersLoaded = true
    void loadMyStickers()
  }
}

const toast = (title: string) => uni.showToast({ title, icon: 'none' })

/** 录音和通话入口都在用户点击时再次复核，不能仅依赖按钮禁用。 */
function recordVoice() {
  if (mediaBusy.value || closed.value || !inFront) return
  panel.value = ''
  void startImVoice(roomId.value)
}
function cancelRecording() {
  void cancelImVoice().catch(() => {})
}

/** 群聊显式选取至多七位同事；私聊沿用服务器的对端成员关系。 */
async function prepareCall(mode: ImCallMode) {
  if (mediaBusy.value || membersBusy.value || closed.value || !inFront) return
  if (!imOptions.value?.callConfigured) {
    toast(t('imMedia.call.unconfigured'))
    return
  }
  panel.value = ''
  if (!group.value) {
    await startImCall(roomId.value, mode)
    return
  }
  const ctx = imCurrent(),
    id = roomId.value
  membersBusy.value = true
  try {
    const rows = await api.get<ImMember[]>(`/im/rooms/${id}/members`, undefined, { silent: true })
    if (!ctx || ctx !== imCurrent() || id !== roomId.value || !inFront) return
    callMembers.value = rows.filter((member) => member.enabled && member.userId !== myId())
    selectedMembers.value = []
    callMode.value = mode
  } catch {
    if (ctx === imCurrent() && inFront) toast(t('imMedia.call.memberFailed'))
  } finally {
    if (ctx === imCurrent() && id === roomId.value) membersBusy.value = false
  }
}
function toggleCallMember(id: number) {
  if (imCalls.value.busy) return
  if (selectedMembers.value.includes(id))
    selectedMembers.value = selectedMembers.value.filter((value) => value !== id)
  else if (selectedMembers.value.length < 7) selectedMembers.value = [...selectedMembers.value, id]
  else toast(t('imMedia.call.tooMany'))
}
async function inviteCall() {
  const mode = callMode.value
  if (!mode || mediaBusy.value || !inFront || closed.value) return
  const ids = [...new Set(selectedMembers.value)].filter((id) =>
    callMembers.value.some((member) => member.userId === id && member.enabled && id !== myId()),
  )
  if (!ids.length || ids.length > 7) {
    toast(t('imMedia.call.noneSelected'))
    return
  }
  callMode.value = null
  await startImCall(roomId.value, mode, ids)
}

async function send(d: ImDraft) {
  const ctx = imCurrent()
  if (!ctx) return
  try {
    await ctx.engine.send(roomId.value, d)
  } catch (e) {
    toast(errorText(e))
  }
}

function sendText() {
  const text = draft.value
  const max = imOptions.value?.textMaxChars ?? IM_LIMITS.textCharsMax
  if (!imTextOk(text)) return toast(t('im.textInvalid'))
  if (imCodePoints(text.trim()) > max) return toast(t('im.textTooLong', { n: max }))
  draft.value = ''
  void send({ kind: 'text', text: text.trim() })
}

function sendSticker(d: ImDraft) {
  panel.value = ''
  void send(d)
}

/** 检查不过的提示。 */
const reject = (why: string) =>
  toast(
    why === 'size'
      ? t('im.tooLarge', { n: imOptions.value?.fileMaxMb ?? 0 })
      : why === 'empty'
        ? t('im.emptyFile')
        : t('im.badType'),
  )

async function pickImage() {
  panel.value = ''
  const options = imOptions.value
  if (!options) return
  const [file] = await chooseUploadFiles(1, true)
  if (!file) return
  const name = safeFileName(file.name ?? file.path.split('/').pop() ?? 'image.jpg')
  const size =
    file.size ??
    (await new Promise<number>((resolve) =>
      uni.getFileInfo({
        filePath: file.path,
        success: (r) => resolve(r.size),
        fail: () => resolve(0),
      }),
    ))
  const bad = checkPick({ name, size }, { ...options, fileExts: [] })
  if (bad) return reject(bad)
  let localRef: string
  try {
    localRef = await keepPickedImage(file.path, name)
  } catch {
    return toast(t('im.pickFailed'))
  }
  void send({ kind: 'image', file: { name, size, mime: guessMime(name), localRef } })
}

async function pickFile() {
  panel.value = ''
  const options = imOptions.value
  if (!options) return
  const picked = await chooseImFile(options)
  if (!picked) return
  if (typeof picked === 'string') return reject(picked)
  const kind = options.imageExts.includes(picked.name.split('.').pop()?.toLowerCase() ?? '')
    ? 'image'
    : 'file'
  void send({ kind, file: picked })
}

async function openImage(e: ImEntryRecord) {
  const ctx = imCurrent()
  if (!ctx || !e.attachment) return
  try {
    const u = await entryBlobUrl(ctx.cache, roomId.value, e.seq, e.kind, e.attachment, false)
    if (ctx !== imCurrent()) return
    uni.previewImage({ urls: [u], current: u })
  } catch (err) {
    toast(errorText(err))
  }
}

/** 文件：App 下载到缓存后用系统打开（超过同源代理上限请到电脑端）；H5 存为本地文件。 */
async function openFile(e: ImEntryRecord) {
  const ctx = imCurrent()
  const att = e.attachment
  if (!ctx || !att) return
  if (att.size > IM_LIMITS.proxyMaxBytes) return toast(t('im.openOnDesktop'))
  try {
    const u = await entryBlobUrl(ctx.cache, roomId.value, e.seq, e.kind, att, false)
    if (ctx !== imCurrent()) return
    if (process.env.UNI_PLATFORM === 'h5') {
      const link = document.createElement('a')
      link.href = u
      link.download = att.name
      link.rel = 'noopener noreferrer'
      document.body.appendChild(link)
      link.click()
      link.remove()
    } else
      uni.openDocument({
        filePath: u,
        fileType: att.name.split('.').pop()?.toLowerCase(),
        showMenu: true,
        fail: () => toast(t('im.openFailed')),
      })
  } catch (err) {
    toast(errorText(err))
  }
}

/** 长按：复制、编辑（本人文字）、撤回、存为我的表情；服务端按角色与时间窗最终判定。 */
function actions(e: ImEntryRecord) {
  const ctx = imCurrent()
  if (!ctx || e.kind === 'event') return
  const role = room.value?.detail?.role
  const items: { label: string; run: () => unknown }[] = []
  if (!e.recalledAt) {
    if (e.kind === 'text' && e.text)
      items.push({ label: t('im.copy'), run: () => uni.setClipboardData({ data: e.text! }) })
    if (e.kind === 'text' && mine(e)) items.push({ label: t('im.edit'), run: () => edit(e) })
    if (mine(e) || (group.value && (role === 'owner' || role === 'moderator')))
      items.push({
        label: t('im.recall'),
        run: () =>
          ctx.engine.recall(roomId.value, e.seq).catch((err: unknown) => toast(errorText(err))),
      })
    if ((e.kind === 'image' || e.kind === 'sticker') && e.attachment)
      items.push({ label: t('im.saveSticker'), run: () => saveSticker(e) })
  }
  if (!items.length) return
  uni.showActionSheet({
    itemList: items.map((i) => i.label),
    success: ({ tapIndex }) => void items[tapIndex]?.run(),
  })
}

function edit(e: ImEntryRecord) {
  uni.showModal({
    title: t('im.edit'),
    editable: true,
    content: e.text ?? '',
    success: ({ confirm, content }) => {
      const text = (content ?? '').trim()
      if (!confirm || !text || text === e.text) return
      if (!imTextOk(text)) return toast(t('im.textInvalid'))
      imCurrent()
        ?.engine.edit(roomId.value, e.seq, text, e.rev)
        .catch((err: unknown) => toast(errorText(err)))
    },
  })
}

async function saveSticker(e: ImEntryRecord) {
  try {
    await api.post(
      '/im/stickers/from-entry',
      { roomId: roomId.value, seq: e.seq },
      { silent: true },
    )
    toast(t('im.saved'))
    if (stickersLoaded) void loadMyStickers()
  } catch (err) {
    toast(errorText(err))
  }
}

const outboxText = (o: ImOutboxRecord) =>
  o.kind === 'voice'
    ? t('imMedia.voice.preview')
    : o.file
      ? o.file.name
      : kindText(o.kind, o.text ?? null, o.stickerCode ?? null)

function outboxActions(o: ImOutboxRecord) {
  const ctx = imCurrent()
  if (!ctx || o.state !== 'failed') return
  // 本地文件已不在或已过期（副本已删）：重发也只会再失败，只给丢弃
  const items = outboxDiscardOnly(o)
    ? [{ label: t('im.discard'), run: () => ctx.engine.discard(o.clientEntryId) }]
    : [
        { label: t('im.retry'), run: () => ctx.engine.retry(o.clientEntryId) },
        { label: t('im.discard'), run: () => ctx.engine.discard(o.clientEntryId) },
      ]
  uni.showActionSheet({
    itemList: items.map((i) => i.label),
    success: ({ tapIndex }) => void items[tapIndex]?.run(),
  })
}

/** 图片按服务端给的宽高等比放进 360rpx 方框，加载前不跳动。 */
function imageBox(e: ImEntryRecord) {
  const w = e.attachment?.width || 1
  const h = e.attachment?.height || 1
  const k = Math.min(360 / w, 360 / h, 1)
  return `width:${Math.max(120, Math.round(w * k))}rpx;height:${Math.max(120, Math.round(h * k))}rpx`
}

const openGroup = () => uni.navigateTo({ url: `/pages-im/group/index?id=${roomId.value}` })
const openStickers = () => uni.navigateTo({ url: '/pages-im/stickers/index' })

const stop = onImChange((c) => {
  if (c.type === 'cleared') return clearRoom()
  if ((c.type === 'entries' || c.type === 'outbox') && c.roomId === roomId.value) void reload()
  else if (c.type === 'rooms' || c.type === 'directory' || c.type === 'state') void reload()
  else if (c.type === 'stickers' && stickersLoaded) void loadMyStickers()
})
onUnmounted(stop)

onLoad(async (query) => {
  roomId.value = Number(query?.id) || 0
  await imStart()
  const ctx = imCurrent()
  if (!ctx) return
  imOpenChat()
  await reload(true)
  void ctx.engine.openRoom(roomId.value).catch(() => {})
})
onUnload(() => {
  imVoiceRoomHide(roomId.value)
  imCurrent()?.engine.closeRoom(roomId.value)
})
onShow(() => {
  inFront = true
  imVoiceRoomShow(roomId.value)
  markSeen()
})
onHide(() => {
  inFront = false
  imVoiceRoomHide(roomId.value)
  callMode.value = null
  callMembers.value = []
  selectedMembers.value = []
})
onReady(() =>
  uni
    .createSelectorQuery()
    .select('.qw-im-scroll')
    .boundingClientRect((r) => {
      viewHeight = (r as UniApp.NodeInfo | null)?.height ?? 0
    })
    .exec(),
)
</script>

<style>
.qw-im-room-page {
  display: flex;
  flex-direction: column;
  height: calc(100vh - var(--window-top, 0px));
  background: var(--qw-canvas);
}

.qw-im-bar {
  display: flex;
  align-items: center;
  gap: var(--qw-space-2);
  min-height: 44px;
  padding: 0 var(--qw-space-4);
  border-bottom: 1px solid var(--qw-border);
  background: var(--qw-surface);
}

.qw-im-bar__text {
  flex: 1;
  font-size: var(--qw-fs-body);
  color: var(--qw-text-2);
}

.qw-im-bar__chev {
  color: var(--qw-text-3);
}

.qw-im-scroll {
  flex: 1;
  min-height: 0;
}

.qw-im-more {
  display: flex;
  justify-content: center;
  padding: var(--qw-space-2);
}

.qw-im-entry {
  display: flex;
  gap: var(--qw-space-2);
  padding: var(--qw-space-1) var(--qw-space-4);
}

.qw-im-entry--mine {
  flex-direction: row-reverse;
}

.qw-im-entry--event {
  justify-content: center;
}

.qw-im-event {
  max-width: 80%;
  padding: 6rpx 20rpx;
  border-radius: var(--qw-radius);
  font-size: var(--qw-fs-caption);
  text-align: center;
  color: var(--qw-text-3);
  background: var(--qw-neutral-weak);
}

.qw-im-entry__av {
  width: 64rpx;
  height: 64rpx;
  font-size: var(--qw-fs-body);
}

.qw-im-entry__main {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6rpx;
  max-width: 72%;
}

.qw-im-entry--mine .qw-im-entry__main {
  align-items: flex-end;
}

.qw-im-entry__who {
  font-size: var(--qw-fs-micro);
  color: var(--qw-text-3);
}

.qw-im-bubble {
  padding: 18rpx 24rpx;
  border-radius: var(--qw-radius-lg);
  font-size: var(--qw-fs-body-lg);
  line-height: 1.45;
  color: var(--qw-text);
  background: var(--qw-surface);
  white-space: pre-wrap;
  word-break: break-word;
}

.qw-im-entry--mine .qw-im-bubble {
  color: var(--qw-on-brand);
  background: var(--qw-brand);
}

.qw-im-bubble--muted,
.qw-im-entry--mine .qw-im-bubble--muted {
  color: var(--qw-text-3);
  background: var(--qw-neutral-weak);
}

.qw-im-edited {
  margin-left: 8rpx;
  font-size: var(--qw-fs-micro);
  opacity: 0.7;
}

.qw-im-image {
  border-radius: var(--qw-radius-lg);
  background: var(--qw-neutral-weak);
}

.qw-im-sticker {
  width: 200rpx;
  height: 200rpx;
}

.qw-im-file {
  display: flex;
  align-items: center;
  gap: var(--qw-space-2);
}

.qw-im-file__text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.qw-im-file__name {
  overflow: hidden;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.qw-im-file__size {
  font-size: var(--qw-fs-caption);
  opacity: 0.8;
}

.qw-im-pending .qw-im-bubble {
  opacity: 0.7;
}

.qw-im-state {
  font-size: var(--qw-fs-micro);
  color: var(--qw-text-3);
}

.qw-im-state.is-failed {
  color: var(--qw-danger);
}

.qw-im-end {
  height: var(--qw-space-2);
}

.qw-im-closed {
  padding: var(--qw-space-3) var(--qw-space-4) calc(var(--qw-space-3) + env(safe-area-inset-bottom));
  font-size: var(--qw-fs-body);
  text-align: center;
  color: var(--qw-text-3);
  background: var(--qw-surface);
}

.qw-im-composer {
  padding-bottom: env(safe-area-inset-bottom);
  border-top: 1px solid var(--qw-border);
  background: var(--qw-surface);
}

.qw-im-composer__row {
  display: flex;
  align-items: flex-end;
  gap: var(--qw-space-1);
  padding: var(--qw-space-2) var(--qw-space-3);
}

.qw-im-input {
  flex: 1;
  box-sizing: border-box;
  min-height: 44px;
  max-height: 240rpx;
  padding: 18rpx 20rpx;
  border-radius: var(--qw-radius);
  font-size: var(--qw-fs-body-lg);
  color: var(--qw-text);
  background: var(--qw-surface-2);
}

.qw-im-tool,
.qw-im-send {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: var(--qw-radius);
  font-size: var(--qw-fs-title);
  color: var(--qw-text-2);
}

.qw-im-tool.is-on {
  background: var(--qw-brand-weak);
}

.qw-im-tool__img {
  width: 56rpx;
  height: 56rpx;
}

.qw-im-send {
  color: var(--qw-on-brand);
  background: var(--qw-brand);
}

.qw-im-panel {
  box-sizing: border-box;
  height: 480rpx;
  padding: 0 var(--qw-space-3) var(--qw-space-2);
}

.qw-im-panel__title {
  display: block;
  padding: var(--qw-space-2) 0 var(--qw-space-1);
  font-size: var(--qw-fs-caption);
  color: var(--qw-text-3);
}

.qw-im-panel__sec {
  padding: 0;
}

.qw-im-panel__empty {
  font-size: var(--qw-fs-caption);
  color: var(--qw-text-3);
}

.qw-im-emoji-grid,
.qw-im-sticker-grid {
  display: flex;
  flex-wrap: wrap;
}

.qw-im-emoji {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 12.5%;
  height: 44px;
  font-size: var(--qw-fs-title-lg);
}

.qw-im-sticker-item {
  box-sizing: border-box;
  width: 25%;
  height: 160rpx;
  padding: 12rpx;
}

.qw-im-more-panel {
  display: flex;
  gap: var(--qw-space-5);
  height: auto;
  padding: var(--qw-space-3) var(--qw-space-4) var(--qw-space-4);
}

.qw-im-action {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--qw-space-1);
  font-size: var(--qw-fs-caption);
  color: var(--qw-text-2);
}

.qw-im-media-bar,
.qw-im-recording {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--qw-space-2);
  padding: var(--qw-space-2) var(--qw-space-3);
  font-size: var(--qw-fs-caption);
  color: var(--qw-text-2);
  background: var(--qw-surface);
}
.qw-im-media-bar text {
  flex: 1;
}
.qw-im-media-error {
  display: block;
  padding: var(--qw-space-2) var(--qw-space-3);
  color: var(--qw-danger);
  font-size: var(--qw-fs-caption);
}
.qw-im-voice {
  display: flex;
  align-items: center;
  gap: var(--qw-space-2);
}
.qw-im-more-panel {
  flex-wrap: wrap;
}
.qw-im-media-action {
  margin: 0;
  font-size: var(--qw-fs-caption);
  color: var(--qw-text);
  background: var(--qw-surface-2);
  border-radius: var(--qw-radius);
}
.qw-im-invite {
  padding: var(--qw-space-3);
  color: var(--qw-text);
}
.qw-im-invite-list {
  max-height: 360rpx;
  height: 360rpx;
}
.qw-im-invite-member {
  display: flex;
  align-items: center;
  min-height: 44px;
  gap: var(--qw-space-2);
}

.qw-im-media-button:focus-visible {
  outline: 2px solid var(--qw-brand);
  outline-offset: 2px;
}
</style>
