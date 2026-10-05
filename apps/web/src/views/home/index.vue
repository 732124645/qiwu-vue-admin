<script setup lang="ts">
import { computed, onActivated, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter, type RouteLocationRaw } from 'vue-router'
import dayjs from 'dayjs'
import { useIntervalFn, useNow } from '@vueuse/core'
import type { MenuNode } from '@qiwu/shared'
import { wfCenterApi } from '@/api/workflow/center'
import EmptyState from '@/core/components/EmptyState.vue'
import { localized, tx } from '@/core/i18n'
import { Icon } from '@/core/icons'
import { shown } from '@/core/layout/SideMenuItem.vue'
import { useTodoCount } from '@/core/layout/todo-count'
import { joinPath } from '@/core/router/build-routes'
import { useAuthStore } from '@/core/stores/auth'
import { useMenuStore } from '@/core/stores/menu'
import { useNotifyStore } from '@/core/stores/notify'

defineOptions({ name: 'HomeView' })

const { t, locale } = useI18n()
const auth = useAuthStore()
const menu = useMenuStore()
const user = computed(() => auth.me?.user)
// this page's own menu entry (the view can back more than one menu page)
const selfId = useRoute().meta.menuId

const now = useNow({ scheduler: (tick) => useIntervalFn(tick, 60_000) })
const greeting = computed(() => {
  const hour = now.value.getHours()
  const name = user.value?.displayName ?? ''
  if (hour >= 5 && hour < 12) return t('common.home.greeting.morning', { name })
  if (hour >= 12 && hour < 18) return t('common.home.greeting.afternoon', { name })
  return t('common.home.greeting.evening', { name })
})
const today = computed(() =>
  new Intl.DateTimeFormat(locale.value, { dateStyle: 'full' }).format(now.value),
)
/** avatar fallback: the first letter of the display name (as in the header) */
const initial = computed(() => [...(user.value?.displayName ?? '')][0]?.toUpperCase() ?? '')
/** the previous sign-in (/me); none before the first */
const lastSignIn = computed(() => {
  const at = auth.me?.lastSignInAt
  return at ? dayjs(at).format('YYYY-MM-DD HH:mm') : ''
})

// Work counters: the approval center's (sign-in only APIs, shown with its pages granted) and the
// inbox's (every signed-in user; the header bell keeps the count live).
const router = useRouter()
const notify = useNotifyStore()
const todo = router.hasRoute('wf-todo') ? useTodoCount() : null
const hasMine = router.hasRoute('wf-mine')
/** my instances still running */
const running = ref<number | null>(null)
async function loadRunning() {
  try {
    running.value = (await wfCenterApi.mine({ page: 1, pageSize: 1, state: 'running' })).total
  } catch {
    // the request layer shows the error
  }
}
if (hasMine) void loadRunning()
// kept alive: processes move on meanwhile, count again when shown
let activated = false
onActivated(() => {
  if (activated && hasMine) void loadRunning()
  activated = true
})

interface Stat {
  key: string
  label: string
  icon: string
  to: RouteLocationRaw
  /** null until loaded */
  value: number | null
}
const stats = computed(() => {
  const list: Stat[] = []
  if (todo)
    list.push({
      key: 'todo',
      label: t('common.home.stats.todo'),
      icon: 'lucide:list-todo',
      to: { name: 'wf-todo' },
      value: todo.value,
    })
  if (hasMine)
    list.push({
      key: 'mine',
      label: t('common.home.stats.mine'),
      icon: 'lucide:file-clock',
      to: { name: 'wf-mine' },
      value: running.value,
    })
  list.push({
    key: 'unread',
    label: t('common.home.stats.unread'),
    icon: 'lucide:inbox',
    to: { name: 'my-inbox' },
    value: notify.inboxUnread,
  })
  return list
})

interface Entry {
  id: number
  title: string
  /** the groups above it, e.g. "System settings" */
  group: string
  icon: string
  to: string
  external: boolean
}

/** Every page the side menu shows, in menu order (the granted menus; see docs/design-notes.md#permissions). */
function entriesOf(nodes: MenuNode[], base = '', groups: string[] = []): Entry[] {
  return nodes.filter(shown).flatMap((n) => {
    const path = joinPath(base, n.routePath)
    const title = localized(n.nameI18n, n.name)
    if (n.kind === 'group') return entriesOf(n.children, path, [...groups, title])
    const external = n.linkType === 'external'
    const to = external ? (n.linkUrl ?? '') : path
    return [{ id: n.id, title, group: groups.join(' / '), icon: n.icon || '', to, external }]
  })
}
const entries = computed(() => entriesOf(menu.tree).filter((e) => e.id !== selfId))
</script>

<template>
  <div class="qw-page home">
    <section class="home-banner">
      <span class="home-banner__avatar" aria-hidden="true">
        <img v-if="user?.avatarUrl" :src="user.avatarUrl" alt="" />
        <template v-else>{{ initial }}</template>
      </span>
      <div class="home-banner__text">
        <p class="home-banner__date">{{ today }}</p>
        <h1 class="home-banner__title">{{ greeting }}</h1>
        <!-- seeded dept/role names are i18n keys (seed.*), admin-created ones plain text -->
        <dl
          v-if="user?.deptName || user?.roleNames.length || lastSignIn"
          class="home-banner__facts"
        >
          <div v-if="user?.deptName" class="home-banner__fact">
            <dt class="home-banner__label">
              <Icon icon="lucide:building-2" aria-hidden="true" />
              <span class="home-banner__sr">{{ t('common.home.dept') }}</span>
            </dt>
            <dd>{{ tx(user.deptName) }}</dd>
          </div>
          <div v-if="user?.roleNames.length" class="home-banner__fact">
            <dt class="home-banner__label">
              <Icon icon="lucide:user-round-check" aria-hidden="true" />
              <span class="home-banner__sr">{{ t('common.home.roles') }}</span>
            </dt>
            <dd class="home-banner__roles">
              <span v-for="r in user.roleNames" :key="r" class="home-banner__role">{{
                tx(r)
              }}</span>
            </dd>
          </div>
          <div v-if="lastSignIn" class="home-banner__fact">
            <dt class="home-banner__label">
              <Icon icon="lucide:history" aria-hidden="true" />
              <span class="home-banner__label-text">{{ t('common.home.lastSignIn') }}</span>
            </dt>
            <dd>
              <time :datetime="auth.me?.lastSignInAt ?? undefined">{{ lastSignIn }}</time>
            </dd>
          </div>
        </dl>
      </div>
    </section>

    <ul class="home-stats" :aria-label="t('common.home.stats.label')">
      <li v-for="s in stats" :key="s.key">
        <router-link :to="s.to" class="home-stat">
          <span class="home-stat__icon"><Icon :icon="s.icon" /></span>
          <span class="home-stat__text">
            <span class="home-stat__label">{{ s.label }}</span>
            <span class="home-stat__value">{{ s.value ?? '–' }}</span>
          </span>
        </router-link>
      </li>
    </ul>

    <section class="home-entries" aria-labelledby="home-entries-title">
      <header class="home-entries__head">
        <h2 id="home-entries-title" class="home-entries__title">
          {{ t('common.home.entries') }}
        </h2>
        <p class="home-entries__hint">{{ t('common.home.entriesHint') }}</p>
      </header>
      <ul v-if="entries.length" class="home-entries__grid">
        <li v-for="e in entries" :key="e.id">
          <a
            v-if="e.external"
            :href="e.to"
            target="_blank"
            rel="noopener noreferrer"
            class="home-entry"
          >
            <span class="home-entry__icon"><Icon :icon="e.icon || 'lucide:globe'" /></span>
            <span class="home-entry__text">
              <span class="home-entry__title">{{ e.title }}</span>
              <span v-if="e.group" class="home-entry__group" :title="e.group">{{ e.group }}</span>
            </span>
            <Icon icon="lucide:arrow-up-right" class="home-entry__go" aria-hidden="true" />
          </a>
          <router-link v-else :to="e.to" class="home-entry">
            <span class="home-entry__icon"><Icon :icon="e.icon || 'lucide:app-window'" /></span>
            <span class="home-entry__text">
              <span class="home-entry__title">{{ e.title }}</span>
              <span v-if="e.group" class="home-entry__group" :title="e.group">{{ e.group }}</span>
            </span>
            <Icon icon="lucide:arrow-right" class="home-entry__go" aria-hidden="true" />
          </router-link>
        </li>
      </ul>
      <div v-else class="home-entries__empty">
        <EmptyState :title="t('common.home.noPages')" :description="t('common.home.noPagesHint')" />
      </div>
    </section>
  </div>
</template>

<style scoped>
.home {
  gap: 24px;
}

/* ---------- welcome banner: a white card, the theme color's grid fading in at the right ---------- */
.home-banner {
  position: relative;
  display: flex;
  gap: 20px;
  align-items: center;
  padding: 28px 32px;
  overflow: hidden;
  background: var(--qw-surface);
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius);
  box-shadow: var(--qw-shadow-1);
  isolation: isolate;
}
.home-banner::before,
.home-banner::after {
  position: absolute;
  inset: 0;
  z-index: -1;
  content: '';
  pointer-events: none;
}
.home-banner::before {
  background: radial-gradient(
    40% 120% at 100% 0%,
    color-mix(in srgb, var(--qw-brand) 10%, transparent),
    transparent 70%
  );
}
.home-banner::after {
  background-image:
    linear-gradient(color-mix(in srgb, var(--qw-brand) 12%, transparent) 1px, transparent 1px),
    linear-gradient(
      90deg,
      color-mix(in srgb, var(--qw-brand) 12%, transparent) 1px,
      transparent 1px
    );
  background-position: right -1px top -1px;
  background-size: 28px 28px;
  /* a mask only reads alpha: any opaque token will do */
  mask-image: radial-gradient(45% 130% at 100% 0%, var(--qw-text), transparent);
}
.home-banner__avatar {
  display: grid;
  flex: none;
  place-items: center;
  width: 60px;
  height: 60px;
  overflow: hidden;
  font-size: 24px;
  font-weight: 650;
  color: var(--qw-brand-text);
  background: var(--qw-brand-weak);
  border-radius: 50%;
  box-shadow:
    0 0 0 4px var(--qw-surface),
    0 0 0 5px var(--qw-border);
}
.home-banner__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.home-banner__text {
  min-width: 0;
}
.home-banner__date {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--qw-text-3);
}
.home-banner__title {
  margin: 2px 0 0;
  overflow: hidden;
  font-size: 24px;
  font-weight: 650;
  line-height: 32px;
  color: var(--qw-text);
  letter-spacing: -0.02em;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.home-banner__facts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 20px;
  align-items: center;
  margin: 12px 0 0;
}
.home-banner__fact {
  display: flex;
  gap: 8px;
  align-items: center;
  min-width: 0;
  font-size: 13px;
  line-height: 22px;
  color: var(--qw-text-2);
}
.home-banner__fact dd {
  margin: 0;
}
.home-banner__label {
  display: flex;
  align-items: center;
  font-size: 16px;
  color: var(--qw-text-3);
}
.home-banner__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.home-banner__roles {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.home-banner__role {
  padding: 0 10px;
  font-size: 12px;
  font-weight: 600;
  line-height: 22px;
  color: var(--qw-brand-text);
  background: var(--qw-brand-weak);
  border-radius: 999px;
}

/* the last sign-in's label is shown: a bare time says nothing */
.home-banner__label-text {
  margin-left: 6px;
  font-size: 13px;
  color: var(--qw-text-3);
}

/* ---------- work counters: up to 3 tiles in a row, each opening its list ---------- */
.home-stats {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(max(220px, calc((100% - 32px) / 3)), 1fr));
  gap: 16px;
  padding: 0;
  margin: 0;
  list-style: none;
}
.home-stat {
  display: flex;
  gap: 16px;
  align-items: center;
  height: 100%;
  box-sizing: border-box;
  padding: 18px 20px;
  color: var(--qw-text);
  text-decoration: none;
  background: var(--qw-surface);
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius);
  transition:
    border-color 0.15s,
    box-shadow 0.15s,
    transform 0.15s var(--qw-ease-enter);
}
.home-stat:hover {
  border-color: color-mix(in srgb, var(--qw-brand) 40%, var(--qw-border));
  box-shadow: var(--qw-shadow-1);
  transform: translateY(-1px);
}
.home-stat__icon {
  display: grid;
  flex: none;
  place-items: center;
  width: 44px;
  height: 44px;
  font-size: 22px;
  color: var(--qw-brand-text);
  background: var(--qw-brand-weak);
  border-radius: var(--qw-radius-sm);
}
.home-stat__text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.home-stat__label {
  overflow: hidden;
  font-size: 13px;
  line-height: 20px;
  color: var(--qw-text-2);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.home-stat__value {
  font-size: 28px;
  font-weight: 650;
  line-height: 36px;
  color: var(--qw-text);
}

/* ---------- quick entries: one card per granted page ---------- */
.home-entries__head {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 12px;
  align-items: baseline;
  margin-bottom: 14px;
}
.home-entries__title {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
  line-height: 24px;
  color: var(--qw-text);
}
.home-entries__hint {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--qw-text-3);
}
.home-entries__grid {
  /* up to 4 columns, never narrower than 280px; empty tracks collapse so the cards reach the right edge */
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(max(280px, calc((100% - 48px) / 4)), 1fr));
  gap: 16px;
  padding: 0;
  margin: 0;
  list-style: none;
}
.home-entry {
  display: flex;
  gap: 14px;
  align-items: center;
  height: 100%;
  box-sizing: border-box;
  padding: 16px 18px 16px 16px;
  color: var(--qw-text);
  text-decoration: none;
  background: var(--qw-surface);
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius);
  transition:
    border-color 0.15s,
    box-shadow 0.15s,
    transform 0.15s var(--qw-ease-enter);
}
.home-entry:hover {
  border-color: color-mix(in srgb, var(--qw-brand) 40%, var(--qw-border));
  box-shadow: var(--qw-shadow-1);
  transform: translateY(-1px);
}
.home-entry__icon {
  display: grid;
  flex: none;
  place-items: center;
  width: 40px;
  height: 40px;
  font-size: 20px;
  color: var(--qw-brand-text);
  background: var(--qw-brand-weak);
  border-radius: var(--qw-radius-sm);
}
.home-entry__text {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}
.home-entry__title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.home-entry__group {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.home-entry__title {
  font-size: 14px;
  font-weight: 600;
  line-height: 22px;
}
.home-entry__group {
  font-size: 12px;
  line-height: 18px;
  color: var(--qw-text-3);
}
.home-entry__go {
  flex: none;
  font-size: 16px;
  color: var(--qw-text-3);
  transition:
    color 0.15s,
    transform 0.15s var(--qw-ease-enter);
}
.home-entry:hover .home-entry__go {
  color: var(--qw-brand-text);
  transform: translateX(2px);
}
.home-entries__empty {
  background: var(--qw-surface);
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius);
}

@media (max-width: 767px) {
  .home {
    gap: 20px;
  }
  .home-banner {
    gap: 16px;
    align-items: flex-start;
    padding: 20px;
  }
  .home-banner__avatar {
    width: 48px;
    height: 48px;
    font-size: 20px;
  }
  .home-banner__title {
    font-size: 20px;
    line-height: 28px;
    white-space: normal;
  }
}
</style>
