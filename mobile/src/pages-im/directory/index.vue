<template>
  <view class="qw-im-dir">
    <view class="qw-im-dir__search">
      <input
        v-model="keyword"
        class="qw-im-dir__input"
        :placeholder="t('im.search')"
        :aria-label="t('im.search')"
        confirm-type="search"
      />
    </view>
    <view v-if="path.length" class="qw-im-dir__path">
      <text class="qw-sec__link" role="link" @click="path = []">{{ t('im.allDepts') }}</text>
      <text v-for="(d, i) in path" :key="d.id" role="link" @click="path = path.slice(0, i + 1)">
        › {{ deptName(d) }}
      </text>
    </view>
    <view v-if="mode === 'group'" class="qw-im-dir__label">
      <input
        v-model="label"
        class="qw-im-dir__input"
        :maxlength="IM_LIMITS.labelMax"
        :placeholder="t('im.group.labelPlaceholder')"
        :aria-label="t('im.group.label')"
      />
    </view>
    <view class="qw-group qw-im-dir__list">
      <template v-if="!keyword.trim()">
        <view v-for="d in subDepts" :key="`d${d.id}`" class="qw-row" role="link" @click="path = [...path, d]">
          <view class="qw-tile qw-tile--neutral" aria-hidden="true">
            <QwIcon name="briefcase" size="36rpx" />
          </view>
          <view class="qw-row__main">
            <text class="qw-row__title">{{ deptName(d) }}</text>
          </view>
          <QwIcon class="qw-im-dir__chev" name="chevron-right" size="30rpx" />
        </view>
      </template>
      <view
        v-for="u in users"
        :key="`u${u.id}`"
        :class="`qw-row qw-im-user${picked.has(u.id) ? ' is-picked' : ''}`"
        role="button"
        :aria-pressed="multi ? picked.has(u.id) : undefined"
        @click="choose(u)"
      >
        <view :class="`qw-av qw-av--${avatarTone(u.id)}`" aria-hidden="true">
          {{ initial(u.displayName) }}
        </view>
        <view class="qw-row__main">
          <text class="qw-row__title">{{ u.displayName }}</text>
          <text v-if="u.deptId" class="qw-row__meta">{{ deptNameOf(u.deptId) }}</text>
        </view>
        <QwIcon v-if="multi && picked.has(u.id)" class="qw-im-dir__check" name="check" size="36rpx" />
      </view>
    </view>
    <QwEmpty v-if="loaded && !users.length && !subDepts.length" :title="t('im.noUsers')" />
    <view v-if="!multi" class="qw-im-dir__foot">
      <view class="qw-btn qw-btn--soft qw-im-dir__group" role="button" @click="startGroup">
        {{ t('im.group.create') }}
      </view>
    </view>
    <view v-else class="qw-im-dir__foot">
      <wd-button
        custom-class="qw-btn qw-btn--primary qw-im-dir__confirm"
        block
        :loading="saving"
        :disabled="saving || !picked.size || (mode === 'group' && !label.trim())"
        @click="confirm"
      >
        {{ t(mode === 'group' ? 'im.group.create' : 'im.group.add') }} ({{ picked.size }})
      </wd-button>
    </view>
  </view>
</template>

<script setup lang="ts">
import { computed, reactive, ref, shallowRef, watch } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import {
  IM_LIMITS,
  type ImDirectory,
  type ImDirectoryDept,
  type ImDirectoryUser,
  type ImRoomDetail,
} from '@qiwu/shared'
import QwEmpty from '@/core/components/QwEmpty.vue'
import QwIcon from '@/core/components/QwIcon.vue'
import { locale, t, tx } from '@/core/i18n'
import { imCurrent, imStart, imState } from '@/core/im/client'
import { avatarTone, initial } from '@/core/im/view'
import { api, errorText } from '@/core/request'
import { useAuthStore } from '@/core/stores/auth'

/**
 * The staff directory (subpackage pages-im) from the local snapshot: drill through the dept tree, search names
 * locally (within the dept drilled into). Default: tap a person to open the direct chat. `?mode=group`: pick
 * people and a name to start a group; `?mode=add&room=<id>`: add people to a group. The snapshot loads on the
 * first chat page and revalidates with its ETag; nothing here asks the server but the create calls.
 */
type Mode = 'direct' | 'group' | 'add'
const auth = useAuthStore()
const mode = ref<Mode>('direct')
const roomId = ref(0)
const dir = shallowRef<ImDirectory>({ depts: [], users: [] })
const loaded = ref(false)
const keyword = ref('')
const label = ref('')
const path = ref<ImDirectoryDept[]>([])
const picked = reactive(new Set<number>())
const saving = ref(false)
const multi = computed(() => mode.value !== 'direct')

// 通讯录与选择草稿同样不能留在已锁定或退出的页面里。
watch(imState, () => {
  if (imCurrent()) return
  dir.value = { depts: [], users: [] }
  path.value = []
  picked.clear()
  keyword.value = label.value = ''
  loaded.value = false
}, { flush: 'sync' })

const deptName = (d: ImDirectoryDept) => d.nameI18n?.[locale()] || tx(d.name)
const deptNameOf = (id: number) => {
  const d = dir.value.depts.find((x) => x.id === id)
  return d ? deptName(d) : ''
}
const current = () => path.value.at(-1)
const sorted = (list: ImDirectoryDept[]) => [...list].sort((a, b) => a.sortNo - b.sortNo || a.id - b.id)

/** 当前部门的下级部门（根：没有上级或上级不在通讯录里的部门）。 */
const subDepts = computed(() => {
  const ids = new Set(dir.value.depts.map((d) => d.id))
  const here = current()
  return sorted(
    dir.value.depts.filter((d) => (here ? d.parentId === here.id : !ids.has(d.parentId))),
  )
})

/** 部门子树的编号（含自己）。 */
function subtree(rootId: number): Set<number> {
  const out = new Set([rootId])
  let grew = true
  while (grew) {
    grew = false
    for (const d of dir.value.depts)
      if (out.has(d.parentId) && !out.has(d.id)) {
        out.add(d.id)
        grew = true
      }
  }
  return out
}

/** 列出的人：有关键字时在当前子树里按姓名子串搜；否则只列当前部门直属（根：无部门的人）。不含自己。 */
const users = computed<ImDirectoryUser[]>(() => {
  const me = auth.me?.user.id
  const kw = keyword.value.trim().toLowerCase()
  const here = current()
  const scope = here ? subtree(here.id) : null
  return dir.value.users.filter((u) => {
    if (u.id === me) return false
    if (kw)
      return u.displayName.toLowerCase().includes(kw) && (!scope || (u.deptId !== null && scope.has(u.deptId)))
    return here ? u.deptId === here.id : u.deptId === null
  })
})

const toast = (title: string) => uni.showToast({ title, icon: 'none' })

/** 接口直接返回的详情写进本地（不再全量同步），再进会话（会话页从缓存显示）。 */
async function enter(detail: ImRoomDetail, replace = true) {
  const ctx = imCurrent()
  if (!ctx) return
  await ctx.engine.applyDetail(detail).catch(() => {})
  if (ctx !== imCurrent()) return
  const url = `/pages-im/room/index?id=${detail.roomId}`
  if (replace) uni.redirectTo({ url })
  else uni.navigateTo({ url })
}

async function choose(u: ImDirectoryUser) {
  const ctx = imCurrent()
  if (!ctx) return
  if (multi.value) {
    if (picked.has(u.id)) picked.delete(u.id)
    else picked.add(u.id)
    return
  }
  if (saving.value) return
  saving.value = true
  try {
    const detail = await api.post<ImRoomDetail>('/im/rooms/directs', { peerId: u.id }, { silent: true })
    if (ctx === imCurrent()) await enter(detail)
  } catch (e) {
    toast(errorText(e))
  } finally {
    saving.value = false
  }
}

const startGroup = () => uni.navigateTo({ url: '/pages-im/directory/index?mode=group' })

async function confirm() {
  const ctx = imCurrent()
  if (!ctx || saving.value || !picked.size) return
  saving.value = true
  try {
    if (mode.value === 'group') {
      const detail = await api.post<ImRoomDetail>(
        '/im/rooms/groups',
        { label: label.value.trim(), userIds: [...picked] },
        { silent: true },
      )
      if (ctx === imCurrent()) await enter(detail)
    } else {
      const detail = await api.post<ImRoomDetail>(
        `/im/rooms/${roomId.value}/members`,
        { userIds: [...picked] },
        { silent: true },
      )
      if (ctx !== imCurrent()) return
      await ctx.engine.applyDetail(detail).catch(() => {})
      if (ctx === imCurrent()) uni.navigateBack()
    }
  } catch (e) {
    toast(errorText(e))
  } finally {
    saving.value = false
  }
}

onLoad(async (query) => {
  mode.value = query?.mode === 'group' || query?.mode === 'add' ? query.mode : 'direct'
  roomId.value = Number(query?.room) || 0
  uni.setNavigationBarTitle({
    title: t(mode.value === 'direct' ? 'im.newChat' : mode.value === 'group' ? 'im.group.create' : 'im.group.add'),
  })
  await imStart()
  const ctx = imCurrent()
  if (!ctx) return
  const cached = await ctx.cache.getDirectory()
  if (ctx !== imCurrent()) return
  if (cached) dir.value = cached.data
  await ctx.engine.loadDirectory().catch(() => {})
  if (ctx !== imCurrent()) return
  const refreshed = await ctx.cache.getDirectory()
  if (ctx !== imCurrent()) return
  dir.value = refreshed?.data ?? dir.value
  loaded.value = true
})
</script>

<style>
.qw-im-dir {
  min-height: 100vh;
  padding-bottom: calc(160rpx + env(safe-area-inset-bottom));
  background: var(--qw-canvas);
}

.qw-im-dir__search,
.qw-im-dir__label {
  padding: var(--qw-space-2) var(--qw-space-4);
}

.qw-im-dir__input {
  box-sizing: border-box;
  height: 44px;
  padding: 0 var(--qw-space-3);
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius-lg);
  font-size: var(--qw-fs-body-lg);
  color: var(--qw-text);
  background: var(--qw-surface);
}

.qw-im-dir__path {
  display: flex;
  flex-wrap: wrap;
  gap: 8rpx;
  padding: 0 var(--qw-space-4) var(--qw-space-2);
  font-size: var(--qw-fs-caption);
  color: var(--qw-text-2);
}

.qw-im-dir__list {
  margin: 0 var(--qw-space-4);
}

.qw-im-dir__chev {
  align-self: center;
  color: var(--qw-text-3);
}

.qw-im-dir__check {
  align-self: center;
  color: var(--qw-brand-text);
}

.qw-im-user.is-picked {
  background: var(--qw-brand-weak);
}

.qw-im-dir__foot {
  position: fixed;
  right: 0;
  bottom: 0;
  left: 0;
  padding: var(--qw-space-2) var(--qw-space-4) calc(var(--qw-space-2) + env(safe-area-inset-bottom));
  border-top: 1px solid var(--qw-border);
  background: var(--qw-surface);
}

.qw-im-dir__group {
  display: flex;
}
</style>
