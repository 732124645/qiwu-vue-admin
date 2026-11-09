<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ImRoomRecord } from '@qiwu/shared/im-client'
import { Icon } from '@/core/icons'
import { useImStore } from '@/core/im/im-store'
import { initialOf, previewText, roomTitle, shortTime, usersById } from './im-view'

/** 会话列表：本地缓存里的会话，按最近活动排序；未读与预览都来自本地，不发请求。 */
defineOptions({ name: 'ImRoomList' })
const { current } = defineProps<{ current: number | null }>()
const emit = defineEmits<{ select: [roomId: number] }>()
const { t } = useI18n()
const im = useImStore()
const users = computed(() => usersById(im.directory))

const items = computed(() =>
  im.rooms.map((r: ImRoomRecord) => {
    const title = roomTitle(r, users.value)
    const peer = r.detail?.peerId ? users.value.get(r.detail.peerId) : undefined
    return {
      id: r.roomId,
      title,
      group: r.detail?.kind === 'group',
      avatar: peer?.avatarUrl ?? null,
      initial: initialOf(title),
      preview: previewText(r.detail?.preview),
      time: shortTime(r.lastAt),
      unread: Math.min(r.unread, 100),
      closed: !!r.detail?.closedAt,
    }
  }),
)
</script>

<template>
  <ul class="im-rooms" :aria-label="t('im.rooms.label')">
    <li v-for="r in items" :key="r.id">
      <button
        type="button"
        class="im-rooms__item"
        :class="{ 'im-rooms__item--active': r.id === current }"
        :aria-current="r.id === current ? 'true' : undefined"
        :aria-label="
          r.unread ? t('im.rooms.itemUnread', { title: r.title, count: r.unread }) : r.title
        "
        @click="emit('select', r.id)"
      >
        <span class="im-rooms__avatar" aria-hidden="true">
          <img v-if="r.avatar" :src="r.avatar" alt="" />
          <Icon v-else-if="r.group" icon="lucide:users" />
          <template v-else>{{ r.initial }}</template>
        </span>
        <span class="im-rooms__main">
          <span class="im-rooms__row">
            <span class="im-rooms__title">{{ r.title }}</span>
            <span class="im-rooms__time">{{ r.time }}</span>
          </span>
          <span class="im-rooms__row">
            <span class="im-rooms__preview">
              <el-tag v-if="r.closed" size="small" type="info" class="im-rooms__tag">{{
                t('im.rooms.closed')
              }}</el-tag>
              {{ r.preview }}
            </span>
            <el-badge v-if="r.unread" :value="r.unread" :max="99" class="im-rooms__badge" />
          </span>
        </span>
      </button>
    </li>
    <li v-if="!items.length" class="im-rooms__empty">{{ t('im.rooms.empty') }}</li>
  </ul>
</template>

<style scoped>
.im-rooms {
  padding: 0;
  margin: 0;
  list-style: none;
}
.im-rooms__item {
  display: flex;
  gap: 10px;
  align-items: center;
  width: 100%;
  padding: 10px 12px;
  font: inherit;
  color: var(--qw-text);
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: var(--qw-radius-sm);
}
.im-rooms__item:hover {
  background: var(--qw-surface-2);
}
.im-rooms__item--active {
  background: var(--qw-brand-weak);
}
.im-rooms__avatar {
  display: grid;
  flex: none;
  place-items: center;
  width: 36px;
  height: 36px;
  overflow: hidden;
  font-weight: 650;
  color: var(--qw-brand-text);
  background: var(--qw-brand-weak);
  border-radius: 50%;
}
.im-rooms__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.im-rooms__main {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.im-rooms__row {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
}
.im-rooms__title,
.im-rooms__preview {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.im-rooms__title {
  font-weight: 600;
}
.im-rooms__preview,
.im-rooms__time {
  font-size: 12px;
  color: var(--qw-text-3);
}
.im-rooms__time {
  flex: none;
}
.im-rooms__tag {
  margin-right: 4px;
}
.im-rooms__badge :deep(.el-badge__content) {
  position: static;
  transform: none;
}
.im-rooms__empty {
  padding: 24px 12px;
  color: var(--qw-text-3);
  text-align: center;
}
</style>
