import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { InboxUnreadVo, Page } from '@qiwu/shared'
import { FEATURE, hasFeature } from '@/core/features'
import { api, currentSessionVersion } from '@/core/request'
import { useAuthStore } from './auth'

/**
 * While a tab page shows and no socket is connected, the counts reload this often (the
 * realtime pushes reload them, core/realtime `pollCounts`).
 */
export const POLL_MS = 60_000

/**
 * My pending approvals, my processes still running (the workbench's "in progress") and unread inbox
 * messages: the workbench and the tab bar badges share them. Sign-in-only APIs over the
 * caller's own data (see docs/design-notes.md#workflow), so no permission gates them. null until the first answer; a failed load
 * keeps the last value (silent: the next show or poll retries). Without the workflow feature (the tenant's
 * package) the two approval counts are not asked for.
 */
export const useCountsStore = defineStore('counts', () => {
  const todo = ref<number | null>(null)
  const running = ref<number | null>(null)
  const unread = ref<number | null>(null)
  /** bumps on every to-do answer, changed or not: what shows to-dos reloads with it (the workbench) */
  const tick = ref(0)
  let seq = 0

  /** 套餐尚未知时先等身份，失败不猜测能力；首次成功后可靠加载本次页面的计数。 */
  function load() {
    const mine = ++seq
    const session = currentSessionVersion()
    const auth = useAuthStore()
    if (!auth.me) {
      void auth.fetchMe().then(
        () => {
          if (mine === seq && session === currentSessionVersion() && auth.me)
            loadKnown(mine, session)
        },
        () => {},
      )
      return
    }
    loadKnown(mine, session)
  }

  /** 已知身份后读取计数，序列与会话共同阻止迟到结果覆盖。 */
  function loadKnown(mine: number, session: number) {
    const flags = useAuthStore().me?.flags
    if (flags?.mustChangePassword || flags?.passwordExpired) return
    const fresh = () => mine === seq && session === currentSessionVersion()
    const silent = { silent: true }
    if (hasFeature(FEATURE.workflow)) {
      // answers on their own: one failing keeps the others
      api.get<Page<unknown>>('/wf/tasks/todo', { page: 1, pageSize: 1 }, silent).then(
        (page) => {
          if (!fresh()) return
          todo.value = page.total
          tick.value++
        },
        () => {},
      )
      api
        .get<Page<unknown>>(
          '/wf/instances/mine',
          { page: 1, pageSize: 1, state: 'running' },
          silent,
        )
        .then(
          (page) => fresh() && (running.value = page.total),
          () => {},
        )
    } else {
      todo.value = null
      running.value = null
    }
    api.get<InboxUnreadVo>('/messaging/inboxes/mine/unread', undefined, silent).then(
      (count) => fresh() && (unread.value = count.unread),
      () => {},
    )
  }

  /** Sign-in / sign-out: the previous user's counts go, answers still pending for them too. */
  function reset() {
    seq++
    todo.value = null
    running.value = null
    unread.value = null
    tick.value = 0
  }

  return { todo, running, unread, tick, load, reset }
})
