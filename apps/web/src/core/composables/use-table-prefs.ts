import { computed, ref, toValue, type MaybeRefOrGetter } from 'vue'
import { defineStore } from 'pinia'
import type { PrefVo, TableColumnsPref } from '@qiwu/shared'
import { api } from '@/core/request/http'

/**
 * One `QwTable` column (see docs/design-notes.md#crud-kit): `label` is an i18n key (unless `literal`), `sortable` = server-side sort
 * (`sortable="custom"`, the list's `onSortChange`); `prop` is also the key of the user's column settings.
 */
export interface QwColumn {
  prop: string
  label: string
  /** `label` is shown as it is (user text, e.g. a form field's title), never as an i18n key */
  literal?: boolean
  width?: number | string
  minWidth?: number | string
  sortable?: boolean
  align?: 'left' | 'center' | 'right'
  fixed?: 'left'
  showOverflowTooltip?: boolean
  /** hidden until the user shows it in the column settings (a wide table's less used columns) */
  hidden?: boolean
}

export type ColumnSetting = TableColumnsPref['columns'][number]

/**
 * The user's saved settings over the code's columns: known props in the saved order with the saved
 * visibility, then the columns added since (code order, visible unless in `hidden`); saved props the code
 * no longer has are dropped.
 */
export function mergeColumns(
  props: string[],
  saved: readonly ColumnSetting[] | null | undefined,
  hidden: readonly string[] = [],
): ColumnSetting[] {
  const out = new Map<string, ColumnSetting>()
  for (const s of saved ?? [])
    if (props.includes(s.prop) && !out.has(s.prop))
      out.set(s.prop, { prop: s.prop, visible: s.visible })
  for (const prop of props)
    if (!out.has(prop)) out.set(prop, { prop, visible: !hidden.includes(prop) })
  return [...out.values()]
}

const SAVE_DELAY = 500
const url = (tableId: string) => `/iam/profile/prefs/table.${tableId}`

/**
 * Column settings per table id, stored per user (`/api/iam/profile/prefs/table.<tableId>`): read once per
 * session (the auth store clears it on sign-in / sign-out), saved 500 ms after the last change. A table's
 * PUTs and DELETEs go out one after another, so a reset is never overwritten by a save still in flight.
 */
export const useTablePrefsStore = defineStore('tablePrefs', () => {
  /** tableId → saved columns; `null` = the code defaults (unset or unreadable); absent = not loaded yet */
  const saved = ref<Record<string, ColumnSetting[] | null>>({})
  const loading = new Set<string>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** tableId → its last write request (settled either way) */
  const writes = new Map<string, Promise<unknown>>()
  let session = 0

  /** Sends `request` once the table's previous write has settled. */
  function queue(tableId: string, request: () => Promise<unknown>): Promise<unknown> {
    const run = (writes.get(tableId) ?? Promise.resolve()).then(request)
    writes.set(
      tableId,
      run.catch(() => undefined),
    )
    return run
  }

  function load(tableId: string) {
    if (tableId in saved.value || loading.has(tableId)) return
    const mine = session
    loading.add(tableId)
    // silent: no toast or session dialog, a failed read just keeps the code defaults
    void api
      .get<PrefVo>(url(tableId), { silent: true })
      .then(
        (r) => r.value?.columns ?? null,
        () => null,
      )
      .then((columns) => {
        // a change made meanwhile wins over the stored value
        if (mine === session && !(tableId in saved.value)) saved.value[tableId] = columns
      })
      .finally(() => loading.delete(tableId))
  }

  function cancelSave(tableId: string) {
    clearTimeout(timers.get(tableId))
    timers.delete(tableId)
  }

  function save(tableId: string, columns: ColumnSetting[]) {
    saved.value[tableId] = columns
    cancelSave(tableId)
    timers.set(
      tableId,
      setTimeout(() => {
        timers.delete(tableId)
        // the request layer toasts 429/5xx; the change still applies to this session
        queue(tableId, () => api.put(url(tableId), { value: { v: 1, columns } })).catch(
          () => undefined,
        )
      }, SAVE_DELAY),
    )
  }

  /** Back to the code's columns at once; DELETE after any save in flight. */
  async function reset(tableId: string) {
    const mine = session
    const before = saved.value[tableId] ?? null
    const unsent = timers.has(tableId)
    cancelSave(tableId)
    saved.value[tableId] = null
    try {
      await queue(tableId, () => api.delete(url(tableId)))
    } catch {
      // toasted by the request layer: show what was there again (unless changed meanwhile), and
      // still save the change the reset had dropped
      if (mine !== session || saved.value[tableId] !== null) return
      if (unsent && before) save(tableId, before)
      else saved.value[tableId] = before
    }
  }

  function clear() {
    session++
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    writes.clear()
    loading.clear()
    saved.value = {}
  }

  return { saved, load, save, reset, clear }
})

/**
 * A table's column settings: `settings` = every column `{ prop, visible }` in the user's order (the settings
 * panel), `visibleColumns` = the shown `QwColumn`s in that order, `save(settings)` (debounced PUT) and
 * `reset()` (DELETE, back to the code's columns). Every caller with the same `tableId` shares the state.
 */
export function useTablePrefs(tableId: string, columns: MaybeRefOrGetter<QwColumn[]>) {
  const store = useTablePrefsStore()
  store.load(tableId)
  const settings = computed(() =>
    mergeColumns(
      toValue(columns).map((c) => c.prop),
      store.saved[tableId],
      toValue(columns).flatMap((c) => (c.hidden ? [c.prop] : [])),
    ),
  )
  const visibleColumns = computed(() => {
    const byProp = new Map(toValue(columns).map((c) => [c.prop, c]))
    return settings.value.flatMap((s) => {
      const c = byProp.get(s.prop)
      return s.visible && c ? [c] : []
    })
  })
  return {
    settings,
    visibleColumns,
    save: (next: ColumnSetting[]) => store.save(tableId, next),
    reset: () => store.reset(tableId),
  }
}
