<template>
  <view class="qw-im-grp">
    <view class="qw-card qw-im-grp__head">
      <text class="qw-im-grp__label">{{ detail?.label || t('im.group.untitled') }}</text>
      <text v-if="detail?.closedAt" class="qw-tag qw-tag--info">{{ t('im.group.closed') }}</text>
      <text
        v-if="canManage"
        class="qw-sec__link qw-im-grp__rename"
        role="button"
        @click="rename"
      >
        {{ t('im.group.rename') }}
      </text>
    </view>
    <view class="qw-sec">
      <text class="qw-sec__title">{{ t('im.group.members', { n: members.length }) }}</text>
      <text v-if="canManage" class="qw-sec__link" role="button" @click="addMembers">
        {{ t('im.group.add') }}
      </text>
    </view>
    <view class="qw-group qw-im-grp__list">
      <view
        v-for="m in members"
        :key="m.userId"
        class="qw-row qw-im-member"
        role="button"
        @click="memberActions(m)"
      >
        <view :class="`qw-av qw-av--${avatarTone(m.userId)}`" aria-hidden="true">
          {{ initial(m.displayName) }}
        </view>
        <view class="qw-row__main">
          <text class="qw-row__title">{{ m.displayName }}</text>
          <text class="qw-row__meta">
            {{ t(`im.role.${m.role}`) }}{{ m.enabled ? '' : ` · ${t('im.group.disabled')}` }}
          </text>
        </view>
      </view>
    </view>
    <QwEmpty v-if="error" :title="error" />
    <view class="qw-im-grp__foot">
      <wd-button
        v-if="role === 'owner' && !detail?.closedAt"
        custom-class="qw-btn qw-im-grp__danger"
        block
        :loading="busy"
        @click="closeGroup"
      >
        {{ t('im.group.close') }}
      </wd-button>
      <wd-button
        custom-class="qw-btn qw-im-grp__danger"
        block
        :loading="busy"
        @click="leave"
      >
        {{ t('im.group.leave') }}
      </wd-button>
    </view>
  </view>
</template>

<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { onLoad, onShow } from '@dcloudio/uni-app'
import { IM_LIMITS, type ImMember, type ImRoomDetail } from '@qiwu/shared'
import QwEmpty from '@/core/components/QwEmpty.vue'
import { t } from '@/core/i18n'
import { imCurrent, imStart, imState } from '@/core/im/client'
import { avatarTone, initial } from '@/core/im/view'
import { api, errorText } from '@/core/request'
import { useAuthStore } from '@/core/stores/auth'

/**
 * A group's settings (subpackage pages-im): members and roles (asked fresh: a management page, not cached),
 * rename, add / remove, set or unset moderator, transfer ownership, close, leave. The buttons follow my current
 * role (owner: everything; moderator: rename, add, remove participants); the server checks every call. After
 * each change the chat engine syncs, so the room and its system message show at once.
 */
const auth = useAuthStore()
const roomId = ref(0)
const detail = shallowRef<ImRoomDetail | null>(null)
const members = shallowRef<ImMember[]>([])
const error = ref('')
const busy = ref(false)
const role = computed(() => detail.value?.role)
const open = computed(() => !detail.value?.closedAt)
const canManage = computed(() => open.value && (role.value === 'owner' || role.value === 'moderator'))

watch(imState, () => {
  if (imCurrent()) return
  detail.value = null
  members.value = []
  error.value = ''
}, { flush: 'sync' })

const toast = (title: string) => uni.showToast({ title, icon: 'none' })
const base = () => `/im/rooms/${roomId.value}`

async function load() {
  const ctx = imCurrent()
  if (!ctx) return
  const room = await ctx.cache.getRoom(roomId.value)
  if (ctx !== imCurrent()) return
  detail.value = room?.detail ?? null
  try {
    const rows = await api.get<ImMember[]>(`${base()}/members`, undefined, { silent: true })
    if (ctx !== imCurrent()) return
    members.value = rows
    error.value = ''
  } catch (e) {
    if (ctx === imCurrent()) error.value = errorText(e)
  }
}

/**
 * 执行一个群管理动作：接口直接返回的详情写进本地（不再全量同步）后重读；`leaving` 时本地删掉该会话并回到
 * 会话列表。动作返回 false（确认框取消）时什么都不做。
 */
async function run(call: () => Promise<ImRoomDetail | null | false>, leaving = false) {
  const ctx = imCurrent()
  if (!ctx || busy.value) return
  busy.value = true
  try {
    const d = await call()
    if (ctx !== imCurrent()) return
    const engine = ctx.engine
    if (leaving) {
      await engine?.forgetRoom(roomId.value)
      if (ctx === imCurrent()) uni.navigateBack({ delta: 2 })
    } else if (d) {
      await engine?.applyDetail(d)
      if (ctx === imCurrent()) await load()
    }
  } catch (e) {
    toast(errorText(e))
  } finally {
    busy.value = false
  }
}

const confirm = (content: string) =>
  new Promise<boolean>((resolve) =>
    uni.showModal({ content, success: (r) => resolve(r.confirm), fail: () => resolve(false) }),
  )

function rename() {
  uni.showModal({
    title: t('im.group.rename'),
    editable: true,
    content: detail.value?.label ?? '',
    success: ({ confirm: ok, content }) => {
      const label = (content ?? '').trim().slice(0, IM_LIMITS.labelMax)
      if (ok && label)
        void run(() => api.put<ImRoomDetail>(`${base()}/label`, { label }, { silent: true }))
    },
  })
}

const addMembers = () =>
  uni.navigateTo({ url: `/pages-im/directory/index?mode=add&room=${roomId.value}` })

/** 成员的操作：按我的角色给出可做的（服务端仍是权威）。 */
function memberActions(m: ImMember) {
  const me = auth.me?.user.id
  if (!open.value || m.userId === me) return
  const items: { label: string; run: () => Promise<ImRoomDetail | false> }[] = []
  const owner = role.value === 'owner'
  if (owner && m.role !== 'owner') {
    const next = m.role === 'moderator' ? 'participant' : 'moderator'
    items.push({
      label: t(next === 'moderator' ? 'im.group.setModerator' : 'im.group.unsetModerator'),
      run: () =>
        api.put<ImRoomDetail>(`${base()}/members/${m.userId}/role`, { role: next }, { silent: true }),
    })
    items.push({
      label: t('im.group.transfer'),
      run: async () =>
        (await confirm(t('im.group.transferConfirm', { name: m.displayName }))) &&
        api.put<ImRoomDetail>(`${base()}/owner`, { userId: m.userId }, { silent: true }),
    })
  }
  if (owner || (role.value === 'moderator' && m.role === 'participant'))
    items.push({
      label: t('im.group.remove'),
      run: async () =>
        (await confirm(t('im.group.removeConfirm', { name: m.displayName }))) &&
        api.delete<ImRoomDetail>(`${base()}/members/${m.userId}`, { silent: true }),
    })
  if (!items.length) return
  uni.showActionSheet({
    itemList: items.map((i) => i.label),
    success: ({ tapIndex }) => void run(() => items[tapIndex]!.run()),
  })
}

async function closeGroup() {
  if (await confirm(t('im.group.closeConfirm')))
    void run(() => api.post<ImRoomDetail>(`${base()}/close`, undefined, { silent: true }))
}

async function leave() {
  if (await confirm(t('im.group.leaveConfirm')))
    void run(() => api.post<null>(`${base()}/leave`, undefined, { silent: true }), true)
}

onLoad(async (query) => {
  roomId.value = Number(query?.id) || 0
  uni.setNavigationBarTitle({ title: t('im.group.settings') })
  await imStart()
})
onShow(() => void load())
</script>

<style>
.qw-im-grp {
  min-height: 100vh;
  padding-bottom: calc(260rpx + env(safe-area-inset-bottom));
  background: var(--qw-canvas);
}

.qw-im-grp__head {
  display: flex;
  align-items: center;
  gap: var(--qw-space-2);
  margin: var(--qw-space-4);
  padding: var(--qw-space-3) var(--qw-space-4);
}

.qw-im-grp__label {
  flex: 1;
  min-width: 0;
  font-size: var(--qw-fs-title);
  font-weight: 600;
  color: var(--qw-text);
  word-break: break-word;
}

.qw-im-grp__list {
  margin: 0 var(--qw-space-4);
}

.qw-im-grp__foot {
  display: flex;
  flex-direction: column;
  gap: var(--qw-space-2);
  padding: var(--qw-space-4);
}

/* the danger secondary button of visual-system §12.4 */
.qw-im-grp__danger {
  border: 1px solid var(--qw-danger) !important;
  color: var(--qw-danger) !important;
  background: var(--qw-surface) !important;
}
</style>
