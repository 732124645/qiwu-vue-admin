<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { breakpointsElement, useBreakpoints } from '@vueuse/core'
import { shownFrame } from '@/core/router/build-routes'
import { useAppStore } from '@/core/stores/app'
import { useAuthStore } from '@/core/stores/auth'
import { useMenuStore } from '@/core/stores/menu'
import { useTagsStore } from '@/core/stores/tags'
import IframeView from '@/views/iframe/IframeView.vue'
import AppLogo from './AppLogo.vue'
import HeaderBar from './HeaderBar.vue'
import SettingsDrawer from './SettingsDrawer.vue'
import SideMenu from './SideMenu.vue'
import { shown } from './SideMenuItem.vue'
import TagsView from './TagsView.vue'

defineOptions({ name: 'AppLayout' })

const { t } = useI18n()
const route = useRoute()
const app = useAppStore()
const auth = useAuthStore()
const watermarkFont = ref({ color: '' })
watch(
  () => app.dark,
  () => {
    // useDark applies html.dark in post-flush; read the canvas colour after its watcher.
    watermarkFont.value = {
      color: getComputedStyle(document.documentElement).getPropertyValue('--qw-border').trim(),
    }
  },
  { immediate: true, flush: 'post' },
)
const menu = useMenuStore()
const tags = useTagsStore()
// side / top / mix; below 992px every mode is side with the menu in a drawer
const mobile = useBreakpoints(breakpointsElement).smaller('md')
const drawer = ref(false)
const settingsOpen = ref(false)
const mode = computed(() => (mobile.value ? 'side' : app.settings.layout))
/** mix: the aside lists the top-level group the current page lives under */
const mixRoot = computed(() => {
  const top = menu.trail(route.meta.menuId ?? 0)[0]
  return top?.node.kind === 'group' ? top : undefined
})
const hasAside = computed(
  () =>
    mode.value === 'side' || (mode.value === 'mix' && !!mixRoot.value?.node.children.some(shown)),
)
const collapsed = computed(() => app.settings.sideCollapsed)
const folded = computed(() => (mobile.value ? !drawer.value : collapsed.value))

function toggle() {
  if (mobile.value) drawer.value = !drawer.value
  else app.settings.sideCollapsed = !collapsed.value
}
watch(
  () => route.path,
  () => (drawer.value = false),
)
const year = new Date().getFullYear()
/**
 * Frames of iframe pages (IframePage): the one on screen, and those kept alive with an open tag, hidden
 * while another page shows. Outside `<keep-alive>`, which would detach and so reload them.
 */
const frames = computed(() =>
  menu.routes.flatMap(({ path, meta = {} }) =>
    meta.linkUrl &&
    (path === shownFrame.value || tags.cacheInclude.includes(meta.componentName ?? ''))
      ? [{ path, src: meta.linkUrl, title: meta.title ?? '', titleI18n: meta.titleI18n }]
      : [],
  ),
)
</script>

<template>
  <!-- Keep this wrapper mounted when toggled, including the kept-alive iframes. The app watermark
       stays below the existing BPMN logo plate (99) and unmodified logo (100). -->
  <el-watermark
    class="app-layout"
    :class="{ 'app-layout--fixed': app.settings.fixedHeader }"
    :content="app.settings.watermark ? (auth.me?.user.username ?? '') : ''"
    :font="watermarkFont"
    :z-index="1"
  >
    <el-header
      v-if="mode !== 'side'"
      height="56px"
      class="app-layout__header app-layout__header--nav"
    >
      <HeaderBar
        :mode
        :aside="hasAside"
        :collapsed="folded"
        @toggle="toggle"
        @settings="settingsOpen = true"
      />
    </el-header>
    <div class="app-layout__row">
      <el-aside
        v-if="!mobile && hasAside"
        :width="collapsed ? '64px' : '220px'"
        class="app-layout__aside"
        :class="{ 'qw-side-light': app.settings.sideTheme === 'light' }"
      >
        <AppLogo v-if="mode === 'side' && app.settings.showLogo" :collapsed />
        <el-scrollbar class="app-layout__scroll">
          <SideMenu
            :collapsed
            :nodes="mode === 'mix' ? mixRoot?.node.children : undefined"
            :base="mode === 'mix' ? mixRoot?.path : undefined"
          />
        </el-scrollbar>
      </el-aside>
      <el-drawer
        v-if="mobile"
        v-model="drawer"
        direction="ltr"
        size="220px"
        :with-header="false"
        class="app-layout__drawer"
        :class="{ 'qw-side-light': app.settings.sideTheme === 'light' }"
      >
        <AppLogo v-if="app.settings.showLogo" />
        <SideMenu />
      </el-drawer>
      <div class="app-layout__body">
        <el-header v-if="mode === 'side'" height="56px" class="app-layout__header">
          <HeaderBar :collapsed="folded" @toggle="toggle" @settings="settingsOpen = true" />
        </el-header>
        <TagsView />
        <el-main class="app-layout__main">
          <router-view v-slot="{ Component, route: r }">
            <transition name="qw-route" mode="out-in">
              <keep-alive :include="tags.cacheInclude">
                <component :is="Component" :key="r.path" />
              </keep-alive>
            </transition>
          </router-view>
          <IframeView
            v-for="f in frames"
            v-show="f.path === shownFrame"
            :key="f.path"
            :src="f.src"
            :title="f.title"
            :title-i18n="f.titleI18n"
          />
        </el-main>
        <el-footer v-if="app.settings.showFooter" height="36px" class="app-layout__footer">
          {{ t('layout.footer', { year }) }}
        </el-footer>
      </div>
    </div>
    <SettingsDrawer v-model="settingsOpen" />
  </el-watermark>
</template>

<style scoped>
/* not fixed: the document scrolls, header and tags scroll away, the aside sticks */
.app-layout {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}
.app-layout__row {
  display: flex;
  flex: 1;
  min-height: 0;
}
.app-layout__aside {
  position: sticky;
  top: 0;
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  background: var(--qw-side-bg);
  transition: width 0.22s var(--qw-ease-enter);
}
.app-layout__scroll {
  flex: 1;
}
.app-layout__body {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}
.app-layout__header {
  padding: 0 16px 0 12px;
  background: var(--qw-surface);
  border-bottom: 1px solid var(--qw-border);
}
/* top / mix: the navigation bar takes the side bar's navy */
.app-layout__header--nav {
  padding: 0 16px 0 4px;
  background: var(--qw-side-bg);
  border-bottom: 0;
}
.app-layout__main {
  flex: 1;
  padding: 20px 24px 24px;
  background: var(--qw-canvas);
}
.app-layout__footer {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--qw-text-3);
  background: var(--qw-canvas);
  border-top: 1px solid var(--qw-border);
}
/* fixed header: the layout fills the viewport and only the page area scrolls */
.app-layout--fixed {
  height: 100vh;
}
.app-layout--fixed .app-layout__aside {
  position: static;
  height: auto;
}
.app-layout--fixed .app-layout__main {
  overflow: auto;
}
@media (max-width: 767px) {
  .app-layout__main {
    padding: 16px;
  }
}
/* printing (the instance detail's print): the page alone, no navigation, not clipped to one screen */
@media print {
  .app-layout__header,
  .app-layout__aside,
  .tags-view,
  .app-layout__footer {
    display: none;
  }
  .app-layout--fixed {
    height: auto;
  }
  .app-layout__main,
  .app-layout--fixed .app-layout__main {
    padding: 0;
    overflow: visible;
    background: none;
  }
}
/* §8: pages fade in rising 4px (180ms), leave faster; reduced motion drops it (App.vue) */
.qw-route-enter-active {
  transition:
    opacity 0.18s var(--qw-ease-enter),
    transform 0.18s var(--qw-ease-enter);
}
.qw-route-leave-active {
  transition: opacity 0.12s var(--qw-ease-exit);
}
.qw-route-enter-from {
  opacity: 0;
  transform: translateY(4px);
}
.qw-route-leave-to {
  opacity: 0;
}
</style>
