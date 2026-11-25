<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useEventListener } from '@vueuse/core'
import type { ImEntryRecord, ImOutboxRecord, ImRoomRecord } from '@qiwu/shared/im-client'
import IconButton from '@/core/components/IconButton.vue'
import { useImStore } from '@/core/im/im-store'
import { useAuthStore } from '@/core/stores/auth'
import Composer from './Composer.vue'
import CallButtons from './CallButtons.vue'
import EntryItem from './EntryItem.vue'
import GroupDrawer from './GroupDrawer.vue'
import { isSilentEvent, roomTitle, usersById } from './im-view'

/**
 * 消息面板：打开即从本地缓存显示最新的 N 条（不等网络），向上滚动先多显示本地行，本地用完才向服务端要更早的；
 * 不引入虚拟列表，靠分批加入控制 DOM 数量。只有渲染出来且在可视区里的消息才上报已读（防抖在引擎里）。
 */
defineOptions({ name: 'ImMessagePane' })
const props = defineProps<{ room: ImRoomRecord }>()
const emit = defineEmits<{ left: [] }>()
const PAGE = 50
const { t } = useI18n()
const im = useImStore()
const auth = useAuthStore()
const users = computed(() => usersById(im.directory))
const title = computed(() => roomTitle(props.room, users.value))
const isGroup = computed(() => props.room.detail?.kind === 'group')
const meId = computed(() => auth.me?.user.id)

const scroller = ref<HTMLElement>()
const rows = shallowRef<ImEntryRecord[]>([])
const outbox = shallowRef<ImOutboxRecord[]>([])
const shown = ref(PAGE)
const loadingOlder = ref(false)
const noMore = ref(false)
const drawer = ref(false)
const previewUrl = ref('')
let loadSeq = 0

/** 从本地缓存读最新的 `shown` 条与本会话的发件箱（编辑/撤回事件不单独显示）。 */
async function load() {
  const c = im.cache()
  if (!c) return
  const mine = ++loadSeq
  const [list, pending] = await Promise.all([
    c.getEntries(props.room.roomId, { order: 'desc', limit: shown.value }),
    c.listOutbox(props.room.roomId),
  ])
  if (mine !== loadSeq) return
  rows.value = list.reverse().filter((e) => !isSilentEvent(e))
  outbox.value = pending
}

const nearBottom = () => {
  const el = scroller.value
  return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80
}
const toBottom = () => {
  const el = scroller.value
  if (el) el.scrollTop = el.scrollHeight
}

/** 向上翻：本地还有就多显示一批；本地用完才 `beforeSeq` 拉。保持当前可见位置不跳。 */
async function older() {
  if (loadingOlder.value || noMore.value) return
  const c = im.cache()
  const engine = im.engine()
  if (!c || !engine) return
  loadingOlder.value = true
  const el = scroller.value
  const before = el ? el.scrollHeight - el.scrollTop : 0
  try {
    const local = await c.countEntries(props.room.roomId)
    if (local <= shown.value) {
      const more = await engine.loadOlder(props.room.roomId)
      const after = await c.countEntries(props.room.roomId)
      if (!more && after <= shown.value) noMore.value = true
    }
    shown.value += PAGE
    await load()
    await nextTick()
    if (el) el.scrollTop = el.scrollHeight - before
  } catch {
    // 离线：保持现状，下次滚动再试
  } finally {
    loadingOlder.value = false
  }
}

function onScroll() {
  if ((scroller.value?.scrollTop ?? 1) < 40) void older()
}

// ---------- 已读：渲染且可见 ----------

const visibleSeqs = new Set<number>()
let observer: IntersectionObserver | null = null

function reportRead() {
  if (document.visibilityState !== 'visible' || !visibleSeqs.size) return
  const top = Math.max(...visibleSeqs)
  if (top > props.room.readSeq) im.engine()?.markRead(props.room.roomId, top)
}

function observe() {
  const el = scroller.value
  if (!el || typeof IntersectionObserver === 'undefined') return
  observer ??= new IntersectionObserver(
    (records) => {
      for (const r of records) {
        const seq = Number((r.target as HTMLElement).dataset.seq)
        if (r.isIntersecting) visibleSeqs.add(seq)
        else visibleSeqs.delete(seq)
      }
      reportRead()
    },
    { root: el, threshold: 0.6 },
  )
  for (const node of el.querySelectorAll<HTMLElement>('[data-seq]')) observer.observe(node)
}
useEventListener(document, 'visibilitychange', reportRead)

watch(
  () => im.entryRev.get(props.room.roomId),
  async () => {
    const stick = nearBottom()
    await load()
    await nextTick()
    if (stick) toBottom()
    observe()
  },
)

onMounted(async () => {
  await load()
  await nextTick()
  toBottom()
  observe()
  await im.engine()?.openRoom(props.room.roomId)
  // 本地行不够一屏（新会话、只有自己刚发的）：向上补一批
  if (rows.value.length < 20) void older()
})
onBeforeUnmount(() => {
  im.engine()?.closeRoom(props.room.roomId)
  observer?.disconnect()
})

const retry = (id: string) => void im.engine()?.retry(id)
const discard = (id: string) => void im.engine()?.discard(id)
const percent = (o: ImOutboxRecord) =>
  o.file ? Math.round((im.progress.get(o.file.localRef) ?? 0) * 100) : 0
const failureText = (o: ImOutboxRecord) =>
  o.failure === 'expired' ? t('im.message.expired') : t('im.message.failed')
</script>

<template>
  <section class="im-pane" :aria-label="title">
    <header class="im-pane__head">
      <CallButtons :room="room" />
      <h2 class="im-pane__title">{{ title }}</h2>
      <span v-if="isGroup" class="im-pane__count">{{
        t('im.group.memberCount', { count: room.detail?.memberCount ?? 0 })
      }}</span>
      <IconButton
        v-if="isGroup"
        class="im-pane__settings"
        icon="lucide:settings-2"
        :label="t('im.group.title')"
        @click="drawer = true"
      />
    </header>
    <div
      ref="scroller"
      class="im-pane__scroll"
      role="log"
      :aria-label="t('im.pane.label')"
      @scroll.passive="onScroll"
    >
      <div class="im-pane__older">
        <el-button v-if="!noMore" link :loading="loadingOlder" @click="older">{{
          t('im.pane.loadOlder')
        }}</el-button>
        <span v-else>{{ t('im.pane.noMore') }}</span>
      </div>
      <EntryItem
        v-for="e in rows"
        :key="e.seq"
        :entry="e"
        :room="room"
        :users="users"
        :mine="e.authorId === meId"
        @preview="(url) => (previewUrl = url)"
      />
      <div
        v-for="o in outbox"
        :key="o.clientEntryId"
        class="im-pane__pending"
        :class="{ 'im-pane__pending--failed': o.state === 'failed' }"
        :data-outbox="o.clientEntryId"
      >
        <span class="im-pane__pending-body">
          <template v-if="o.kind === 'text'">{{ o.text }}</template>
          <template v-else-if="o.kind === 'sticker' && o.stickerCode">{{
            `[${t(`im.sticker.${o.stickerCode}`)}]`
          }}</template>
          <template v-else-if="o.kind === 'sticker'">{{ t('im.preview.sticker') }}</template>
          <template v-else-if="o.kind === 'voice'">{{ t('im.preview.voice') }}</template>
          <template v-else>{{ o.file?.name }}</template>
        </span>
        <span class="im-pane__pending-state">
          <template v-if="o.state === 'pending'">
            {{
              o.file && o.objectId === undefined && im.progress.has(o.file.localRef)
                ? t('im.message.uploading', { percent: percent(o) })
                : t('im.message.pending')
            }}
          </template>
          <template v-else>
            {{ failureText(o) }}
            <el-button link type="primary" @click="retry(o.clientEntryId)">{{
              t('im.message.retry')
            }}</el-button>
            <el-button link type="danger" @click="discard(o.clientEntryId)">{{
              t('im.message.discard')
            }}</el-button>
          </template>
        </span>
      </div>
    </div>
    <Composer :room="room" />
    <GroupDrawer v-if="isGroup" v-model="drawer" :room="room" @left="emit('left')" />
    <el-image-viewer
      v-if="previewUrl"
      :url-list="[previewUrl]"
      teleported
      @close="previewUrl = ''"
    />
  </section>
</template>

<style scoped>
.im-pane {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.im-pane__head {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--qw-border);
}
.im-pane__title {
  margin: 0;
  overflow: hidden;
  font-size: 16px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.im-pane__count {
  font-size: 12px;
  color: var(--qw-text-3);
}
.im-pane__settings {
  margin-left: auto;
}
.im-pane__scroll {
  flex: 1;
  min-height: 0;
  padding: 8px 16px;
  overflow-y: auto;
}
.im-pane__older {
  padding: 4px 0 8px;
  font-size: 12px;
  color: var(--qw-text-3);
  text-align: center;
}
.im-pane__pending {
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-items: flex-end;
  padding: 6px 0;
}
.im-pane__pending-body {
  max-width: 70%;
  padding: 8px 12px;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  background: var(--qw-brand-weak);
  border-radius: var(--qw-radius);
  opacity: 0.7;
}
.im-pane__pending--failed .im-pane__pending-body {
  background: var(--qw-danger-weak);
  opacity: 1;
}
.im-pane__pending-state {
  font-size: 12px;
  color: var(--qw-text-3);
}
.im-pane__pending--failed .im-pane__pending-state {
  color: var(--qw-danger);
}
</style>
