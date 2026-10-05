import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { InboxUnreadVo, Page } from '@qiwu/shared'
import { api } from '@/core/request'

/**
 * While a tab page shows and no socket is connected, the counts reload this often (the
 * realtime pushes reload them, core/realtime `pollCounts`).
 */
export const POLL_MS = 60_000

/**
 * My pending approvals, my processes still running (the workbench's "in progress") and unread inbox
 * messages: the workbench and the tab bar badges share them. Sign-in-only APIs over the
 * caller's own data (see docs/design-notes.md#workflow), so no permission gates them. null until the first answer; a failed load
 * keeps the last value (silent: the next show or poll retries).
 */
export const useCountsStore = defineStore('counts', () => {
  const todo = ref<number | null>(null)
  const running = ref<number | null>(null)
  const unread = ref<number | null>(null)
  /** bumps on every to-do answer, changed or not: what shows to-dos reloads with it (the workbench) */
  const tick = ref(0)
  let seq = 0

  function load() {
    const mine = ++seq
    const silent = { silent: true }
    // answers on their own: one failing keeps the others
    api.get<Page<unknown>>('/wf/tasks/todo', { page: 1, pageSize: 1 }, silent).then(
      (page) => {
        if (mine !== seq) return
        todo.value = page.total
        tick.value++
      },
      () => {},
    )
    api
      .get<Page<unknown>>('/wf/instances/mine', { page: 1, pageSize: 1, state: 'running' }, silent)
      .then(
        (page) => mine === seq && (running.value = page.total),
        () => {},
      )
    api.get<InboxUnreadVo>('/messaging/inboxes/mine/unread', undefined, silent).then(
      (count) => mine === seq && (unread.value = count.unread),
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
