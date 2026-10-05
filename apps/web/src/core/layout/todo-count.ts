import { ref, watch } from 'vue'
import {
  createSharedComposable,
  useDocumentVisibility,
  useEventListener,
  useIntervalFn,
} from '@vueuse/core'
import { RT } from '@qiwu/shared'
import { wfCenterApi } from '@/api/workflow/center'
import { onRealtime, realtimeUp } from '@/core/realtime/socket'

const POLL_MS = 60_000

/**
 * The caller's pending-task count (see docs/design-notes.md#workflow): the side menu's 我的待办 badge and the home page
 * share one instance. It reloads on every `wf:task` push (the caller's to-dos changed), when the socket
 * comes back, on window focus, and every minute while the socket is down (tab visible), as the header
 * bell does (docs/realtime.md). null until the first answer.
 */
export const useTodoCount = createSharedComposable(() => {
  const count = ref<number | null>(null)
  let seq = 0

  async function load() {
    const mine = ++seq
    try {
      const page = await wfCenterApi.todo({ page: 1, pageSize: 1 }, { silent: true })
      if (mine === seq) count.value = page.total
    } catch {
      // silent: the next push, focus or poll retries
    }
  }

  void load()
  onRealtime(RT.wfTask, () => void load())
  watch(realtimeUp, (up) => up && void load())
  useEventListener(window, 'focus', () => void load())
  const visibility = useDocumentVisibility()
  useIntervalFn(() => {
    if (!realtimeUp.value && visibility.value === 'visible') void load()
  }, POLL_MS)
  return count
})
