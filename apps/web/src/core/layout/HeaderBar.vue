<script setup lang="ts">
import { computed, h } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useFullscreen } from '@vueuse/core'
import { localized } from '@/core/i18n'
import IconButton from '@/core/components/IconButton.vue'
import LocaleSwitch from '@/core/components/LocaleSwitch.vue'
import { Icon } from '@/core/icons'
import { useAppStore, type ComponentSize, type LayoutMode } from '@/core/stores/app'
import { useAuthStore } from '@/core/stores/auth'
import { useMenuStore } from '@/core/stores/menu'
import { useTagsStore } from '@/core/stores/tags'
import AppLogo from './AppLogo.vue'
import MenuSearch from './MenuSearch.vue'
import NotifyBell from './NotifyBell.vue'
import SideMenu from './SideMenu.vue'

/**
 * side: collapse toggle + breadcrumb; top: logo + horizontal menu; mix: logo + top-level entries (the
 * aside holds the rest). `aside`: there is a side menu (or drawer) to toggle.
 */
const {
  mode = 'side',
  aside = true,
  collapsed = false,
} = defineProps<{ mode?: LayoutMode; aside?: boolean; collapsed?: boolean }>()
const emit = defineEmits<{ toggle: []; settings: [] }>()

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const app = useAppStore()
const auth = useAuthStore()
const menu = useMenuStore()
const tags = useTagsStore()
// the native Fullscreen API (no screenfull; see docs/design-notes.md#layering)
const fullscreen = useFullscreen()
const SIZES: ComponentSize[] = ['large', 'default', 'small']
const Chevron = () => h(Icon, { icon: 'lucide:chevron-right' })
const user = computed(() => auth.me?.user)
/** avatar fallback: the first letter of the display name */
const initial = computed(() => [...(user.value?.displayName ?? '')][0]?.toUpperCase() ?? '')

/** Menu path of the current page; ancestor pages link back, groups and the current page don't. */
const crumbs = computed(() => {
  const trail = route.meta.menuId ? menu.trail(route.meta.menuId) : []
  if (!trail.length)
    return [
      {
        key: route.path,
        title: localized(route.meta.titleI18n, route.meta.title ?? ''),
        to: undefined,
      },
    ]
  return trail.map(({ node, path }, i) => ({
    key: String(node.id),
    title: localized(node.nameI18n, node.name),
    to: node.kind === 'page' && i < trail.length - 1 ? path : undefined,
  }))
})

async function onUser(command: string) {
  if (command === 'profile') await router.push({ name: 'profile' })
  else if (command === 'lock') {
    auth.lock(route.fullPath)
    await router.push({ name: 'lock' })
  } else if (command === 'password')
    await router.push({ name: 'password-change', query: { redirect: route.fullPath } })
  else if (command === 'logout') {
    await auth.logout()
    tags.reset()
    await router.replace('/login')
  }
}
</script>

<template>
  <div class="header-bar" :class="{ 'header-bar--nav': mode !== 'side' }">
    <IconButton
      v-if="aside"
      :icon="collapsed ? 'lucide:panel-left-open' : 'lucide:panel-left-close'"
      :label="t(collapsed ? 'common.layout.expand' : 'common.layout.collapse')"
      @click="emit('toggle')"
    />
    <el-breadcrumb
      v-if="mode === 'side'"
      class="header-bar__crumbs"
      :separator-icon="Chevron"
      :aria-label="t('common.layout.breadcrumb')"
    >
      <el-breadcrumb-item v-for="c in crumbs" :key="c.key" :to="c.to">{{
        c.title
      }}</el-breadcrumb-item>
    </el-breadcrumb>
    <template v-else>
      <AppLogo v-if="app.settings.showLogo" class="header-bar__logo" />
      <SideMenu horizontal :roots="mode === 'mix'" />
    </template>
    <div class="header-bar__actions">
      <MenuSearch />
      <IconButton
        v-if="fullscreen.isSupported.value"
        class="header-bar__wide"
        :icon="fullscreen.isFullscreen.value ? 'lucide:minimize' : 'lucide:maximize'"
        :label="
          t(fullscreen.isFullscreen.value ? 'layout.fullscreen.exit' : 'layout.fullscreen.enter')
        "
        :aria-pressed="fullscreen.isFullscreen.value"
        @click="fullscreen.toggle()"
      />
      <el-dropdown trigger="click" @command="(s: ComponentSize) => (app.settings.size = s)">
        <IconButton class="header-bar__wide" icon="lucide:rows-3" :label="t('layout.size.label')" />
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item
              v-for="s in SIZES"
              :key="s"
              :command="s"
              :disabled="s === app.settings.size"
            >
              {{ t(`layout.size.${s}`) }}
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <NotifyBell />
      <LocaleSwitch icon />
      <IconButton
        icon="lucide:settings"
        :label="t('layout.settings.title')"
        @click="emit('settings')"
      />
      <span class="header-bar__divider" aria-hidden="true" />
      <el-dropdown trigger="click" @command="onUser">
        <button type="button" class="header-bar__user" :aria-label="t('common.layout.userMenu')">
          <span class="header-bar__avatar">
            <img v-if="user?.avatarUrl" :src="user.avatarUrl" alt="" />
            <template v-else>{{ initial }}</template>
          </span>
          <span class="header-bar__name">{{ user?.displayName }}</span>
          <Icon icon="lucide:chevron-down" class="header-bar__caret" />
        </button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="profile">
              <el-icon><Icon icon="lucide:user-round" /></el-icon>{{ t('profile.title') }}
            </el-dropdown-item>
            <el-dropdown-item command="lock">
              <el-icon><Icon icon="lucide:lock-keyhole" /></el-icon>{{ t('layout.lock.action') }}
            </el-dropdown-item>
            <el-dropdown-item command="password">
              <el-icon><Icon icon="lucide:key-round" /></el-icon
              >{{ t('common.layout.changePassword') }}
            </el-dropdown-item>
            <el-dropdown-item command="logout" divided>
              <el-icon><Icon icon="lucide:log-out" /></el-icon>{{ t('common.action.signOut') }}
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
  </div>
</template>

<style scoped>
.header-bar {
  display: flex;
  gap: 12px;
  align-items: center;
  height: 100%;
}
/* top / mix layouts: the bar is navy like the side bar; the header's tokens follow */
.header-bar--nav {
  --qw-surface: var(--qw-side-bg);
  --qw-surface-2: var(--qw-side-hover);
  --qw-border: color-mix(in srgb, var(--qw-side-text) 18%, transparent);
  --qw-text: var(--qw-side-active-text);
  --qw-text-2: var(--qw-side-text);
  --qw-text-3: var(--qw-side-text-3);
  gap: 8px;
}
.header-bar__logo {
  padding: 0 12px 0 4px;
}
.header-bar__crumbs {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}
.header-bar__actions {
  display: flex;
  flex: 0 1 auto;
  gap: 4px;
  align-items: center;
  min-width: 0;
  margin-left: auto;
}
.header-bar__actions > :first-child {
  margin-right: 8px;
}
.header-bar__divider {
  flex: none;
  width: 1px;
  height: 20px;
  margin: 0 8px;
  background: var(--qw-border);
}
.header-bar__user {
  display: flex;
  flex: none;
  gap: 8px;
  align-items: center;
  height: 36px;
  padding: 0 8px 0 4px;
  font: inherit;
  font-weight: 600;
  color: var(--qw-text);
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 999px;
  transition: background-color 0.15s;
}
.header-bar__user:hover,
.header-bar__user[aria-expanded='true'] {
  background: var(--qw-surface-2);
}
.header-bar__avatar {
  display: grid;
  flex: none;
  place-items: center;
  width: 28px;
  height: 28px;
  overflow: hidden;
  font-size: 12px;
  font-weight: 650;
  color: var(--qw-brand-text);
  background: var(--qw-brand-weak);
  border-radius: 50%;
}
.header-bar--nav .header-bar__avatar {
  color: var(--qw-on-brand);
  background: var(--qw-brand);
}
.header-bar__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.header-bar__name {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.header-bar__caret {
  width: 14px;
  height: 14px;
  color: var(--qw-text-3);
}
@media (max-width: 767px) {
  .header-bar__crumbs,
  .header-bar__wide,
  .header-bar__divider,
  .header-bar__name,
  .header-bar__caret {
    display: none;
  }
}
</style>
