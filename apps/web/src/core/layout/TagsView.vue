<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { localized } from '@/core/i18n'
import { Icon } from '@/core/icons'
import { LAYOUT } from '@/core/router'
import { useMenuStore } from '@/core/stores/menu'
import { useTagsStore, type Tag } from '@/core/stores/tags'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const menu = useMenuStore()
const tags = useTagsStore()
const list = ref<HTMLElement>()

/** A layout page other than /redirect (error pages live outside the layout). */
const isPage = (to: { matched: { name?: unknown }[]; name?: unknown }) =>
  to.matched[0]?.name === LAYOUT && to.name !== 'redirect'

tags.init(router.resolve(menu.homePath || '/'), (tag) => isPage(router.resolve(tag.fullPath)))

watch(
  () => route.fullPath,
  async () => {
    if (!isPage(route)) return
    tags.open(route)
    // back from /redirect: cache the remounted page again
    if (tags.refreshing.length) tags.refreshing = []
    await nextTick()
    list.value?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  },
  { immediate: true },
)

type Command = 'refresh' | 'close' | 'others' | 'left' | 'right' | 'all'
const PICK: Record<
  Exclude<Command, 'refresh'>,
  (tag: Tag, at: number) => (t: Tag, i: number) => boolean
> = {
  close: (tag) => (t) => t.path === tag.path,
  others: (tag) => (t) => t.path !== tag.path,
  left: (_, at) => (_t, i) => i < at,
  right: (_, at) => (_t, i) => i > at,
  all: () => () => true,
}

async function run(command: Command, tag: Tag, at: number) {
  if (command === 'refresh') return refresh(tag)
  tags.close(PICK[command](tag, at))
  // the current page lost its tag: go to the clicked tag if it stayed, else its left neighbour
  if (!tags.tags.some((t) => t.path === route.path)) {
    const next = tags.tags.find((t) => t.path === tag.path) ?? tags.tags[at - 1] ?? tags.tags.at(-1)
    await router.push(next?.fullPath ?? '/')
  }
}

/** Drops the cached instance, then re-enters the page through /redirect so it mounts anew. */
async function refresh(tag: Tag) {
  if (tag.cacheName) tags.refreshing = [tag.cacheName]
  await nextTick()
  await router.replace(`/redirect${tag.fullPath}`)
}

const closable = (tag: Tag) => !tags.affix(tag)
const anyClosable = (pick: (t: Tag, i: number) => boolean) =>
  tags.tags.some((t, i) => closable(t) && pick(t, i))
</script>

<template>
  <div class="tags-view" :class="`tags-view--${tags.style}`">
    <el-scrollbar class="tags-view__scroll">
      <nav ref="list" class="tags-view__list" :aria-label="t('common.tags.label')">
        <el-dropdown
          v-for="(tag, i) in tags.tags"
          :key="tag.path"
          trigger="contextmenu"
          @command="(c: Command) => run(c, tag, i)"
        >
          <div
            class="tags-view__tag"
            :class="{ 'is-active': tag.path === route.path }"
            :data-path="tag.path"
          >
            <router-link
              :to="tag.fullPath"
              class="tags-view__link"
              :aria-current="tag.path === route.path ? 'page' : undefined"
            >
              <Icon v-if="tag.icon" :icon="tag.icon" class="tags-view__icon" />
              <span>{{ localized(tag.titleI18n, tag.title) }}</span>
            </router-link>
            <button
              v-if="closable(tag)"
              type="button"
              class="tags-view__close"
              :aria-label="t('common.tags.close')"
              @click="run('close', tag, i)"
            >
              <Icon icon="lucide:x" />
            </button>
          </div>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="refresh">
                <el-icon><Icon icon="lucide:refresh-cw" /></el-icon>{{ t('common.tags.refresh') }}
              </el-dropdown-item>
              <el-dropdown-item command="close" :disabled="!closable(tag)">
                <el-icon><Icon icon="lucide:x" /></el-icon>{{ t('common.tags.close') }}
              </el-dropdown-item>
              <el-dropdown-item command="others" :disabled="!anyClosable(PICK.others(tag, i))">
                <el-icon><Icon icon="lucide:arrow-left-right" /></el-icon
                >{{ t('common.tags.closeOthers') }}
              </el-dropdown-item>
              <el-dropdown-item command="left" :disabled="!anyClosable(PICK.left(tag, i))">
                <el-icon><Icon icon="lucide:arrow-left-to-line" /></el-icon
                >{{ t('common.tags.closeLeft') }}
              </el-dropdown-item>
              <el-dropdown-item command="right" :disabled="!anyClosable(PICK.right(tag, i))">
                <el-icon><Icon icon="lucide:arrow-right-to-line" /></el-icon
                >{{ t('common.tags.closeRight') }}
              </el-dropdown-item>
              <el-dropdown-item command="all" :disabled="!anyClosable(PICK.all(tag, i))">
                <el-icon><Icon icon="lucide:circle-x" /></el-icon>{{ t('common.tags.closeAll') }}
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </nav>
    </el-scrollbar>
  </div>
</template>

<style scoped>
.tags-view {
  display: flex;
  flex: none;
  align-items: center;
  height: 40px;
  /* in line with the page content (AppLayout main) */
  padding: 0 24px;
  background: var(--qw-surface);
  border-bottom: 1px solid var(--qw-border);
}
.tags-view__scroll {
  flex: 1;
  min-width: 0;
}
.tags-view__list {
  display: flex;
  gap: 6px;
  align-items: center;
  height: 40px;
  white-space: nowrap;
}
.tags-view__tag {
  display: flex;
  gap: 2px;
  align-items: center;
  height: 26px;
  padding: 0 12px;
  font-size: 12px;
  color: var(--qw-text-2);
  cursor: pointer;
  transition:
    color 0.15s,
    background-color 0.15s,
    border-color 0.15s;
}
.tags-view__link {
  display: flex;
  gap: 6px;
  align-items: center;
  height: 100%;
  color: inherit;
  text-decoration: none;
  border-radius: inherit;
}
.tags-view__link:focus-visible,
.tags-view__close:focus-visible {
  outline-offset: 1px;
}
.tags-view__icon {
  width: 14px;
  height: 14px;
}
.tags-view__close {
  display: inline-grid;
  place-items: center;
  width: 16px;
  height: 16px;
  padding: 0;
  margin-right: -6px;
  color: inherit;
  cursor: pointer;
  background: none;
  border: 0;
  border-radius: 50%;
  opacity: 0.7;
}
.tags-view__close svg {
  width: 12px;
  height: 12px;
}
.tags-view__close:hover {
  opacity: 1;
  background: color-mix(in srgb, currentColor 14%, transparent);
}
@media (max-width: 767px) {
  .tags-view {
    padding: 0 16px;
  }
}

/* card (default): pills; the current page on the brand tint */
.tags-view--card .tags-view__tag {
  background: var(--qw-surface);
  border: 1px solid var(--qw-border);
  border-radius: 999px;
}
.tags-view--card .tags-view__tag:not(.is-active):hover {
  color: var(--qw-text);
  border-color: color-mix(in srgb, var(--qw-text-3) 45%, var(--qw-border));
}
.tags-view--card .tags-view__tag.is-active {
  font-weight: 600;
  color: var(--qw-brand-text);
  background: var(--qw-brand-weak);
  border-color: transparent;
}

/* chrome: tabs with rounded tops; the current one merges into the canvas below */
.tags-view--chrome .tags-view__list {
  align-items: flex-end;
}
.tags-view--chrome .tags-view__tag {
  position: relative;
  height: 32px;
  padding: 0 14px;
  border-radius: var(--qw-radius-sm) var(--qw-radius-sm) 0 0;
}
.tags-view--chrome .tags-view__tag:not(.is-active):hover {
  color: var(--qw-text);
  background: var(--qw-surface-2);
}
.tags-view--chrome .tags-view__tag.is-active {
  font-weight: 600;
  color: var(--qw-brand-text);
  background: var(--qw-canvas);
}
.tags-view--chrome .el-dropdown:not(:first-child) .tags-view__tag:not(.is-active)::before {
  position: absolute;
  top: 9px;
  left: -4px;
  width: 1px;
  height: 14px;
  content: '';
  background: var(--qw-border);
}
</style>
