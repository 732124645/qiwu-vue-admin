import { reactive, watchEffect } from 'vue'
import type { WfUserOption } from '@qiwu/shared'
import { userApi } from '@/api/platform/iam/user'
import { wfCenterApi } from '@/api/workflow/center'

/**
 * Display names of the user ids a designer control shows (saved earlier: no picked user to read them from),
 * loaded once there are ids; the caller adds the users it picks. Call in `setup`. `source` as UserPicker's:
 * `wf` reads every enabled user (GET /wf/users/options), not the caller's data scope.
 * Names come from the first PAGE_SIZE_MAX users of the source; others read `#<id>` until an ids
 * filter on the options exists
 */
export function useUserNames(ids: () => readonly number[], source: 'iam' | 'wf' = 'iam') {
  const names = reactive(new Map<number, string>())
  // a reused instance (a list re-keyed by index) can start empty
  let loaded = false
  watchEffect(() => {
    if (loaded || !ids().length) return
    loaded = true
    const load: Promise<WfUserOption[]> =
      source === 'wf' ? wfCenterApi.userOptions() : userApi.options()
    load.then((list) => list.forEach((u) => names.set(u.id, u.displayName))).catch(() => undefined) // the request layer showed it
  })
  return names
}
