import { reactive, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import { ElMessage, ElMessageBox, type FormInstance } from 'element-plus'
import { PAGE_SIZE_DEFAULT, type ObjectSchema } from '@qiwu/shared'
import type { DialogEmit } from '@/core/dialog'
import { revalidateOnLocale, zodRules } from '@/core/form/zod-rules'
import { i18n, tx } from '@/core/i18n'
import { ApiError, type CrudApi, type TreeApi, type TreeRow } from '@/core/request/http'

// The CRUD kit (see docs/design-notes.md#crud-kit): plain el-table/el-form pages, consistency comes from the generator templates.

const t = (key: string, params: Record<string, unknown> = {}) => i18n.global.t(key, params)

/** The request layer toasts 403/409/422/429/5xx; a CRUD action also shows the 400/404 it leaves to callers. */
export function toastRest(e: unknown) {
  if (e instanceof ApiError && (e.status === 400 || e.status === 404)) ElMessage.error(e.message)
}

/** Asks to delete `count` records, then runs `del`; `true` once deleted (message shown), `false` otherwise. */
async function confirmRemove(count: number, del: () => Promise<unknown>): Promise<boolean> {
  try {
    await ElMessageBox.confirm(
      count > 1 ? t('crud.confirm.batchDelete', { count }) : t('crud.confirm.delete'),
      t('crud.confirm.title'),
      {
        type: 'warning',
        confirmButtonText: t('crud.action.delete'),
        cancelButtonText: t('common.action.cancel'),
      },
    )
  } catch {
    return false
  }
  try {
    await del()
  } catch (e) {
    toastRest(e)
    return false
  }
  ElMessage.success(t('crud.msg.deleted'))
  return true
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
/** a `YYYY-MM-DD` range end (daterange picker, `value-format="YYYY-MM-DD"`) as that day's first / last instant here */
const bound = (v: unknown, end: boolean) =>
  typeof v === 'string' && DAY.test(v)
    ? dayjs(v)[end ? 'endOf' : 'startOf']('day').toISOString()
    : v

/**
 * Query params of a list query: '' / null / undefined filters are left out, and a `<field>Range: [from, to]`
 * filter (el-date-picker range) becomes `<field>From` / `<field>To` (see docs/design-notes.md#api-envelope); date-only ends cover the
 * whole days in the browser's time zone (sent as UTC instants). A `<field>Dates` range is sent the same
 * way but as it is: the calendar dates of a `date` column.
 */
export function listParams(query: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(query)) {
    if (v === '' || v == null) continue
    const [, range, kind] = /^(.+)(Range|Dates)$/.exec(k) ?? []
    if (range && Array.isArray(v)) {
      const end = (x: unknown, last: boolean) => (kind === 'Dates' ? x : bound(x, last))
      if (v[0] != null && v[0] !== '') out[`${range}From`] = end(v[0], false)
      if (v[1] != null && v[1] !== '') out[`${range}To`] = end(v[1], true)
    } else out[k] = v
  }
  return out
}

export interface ListQuery {
  page: number
  pageSize: number
  /** `createdAt,-id` (see docs/design-notes.md#api-envelope); set by the table's sort-change */
  sort?: string
}

/**
 * List page state: `query` (page/pageSize/sort + the filters in `filters`, bound to the search form),
 * `rows`/`total`/`loading`, `filtered` (the rows shown were loaded with a filter set: `QwTable :filtered`
 * then says "no match" instead of "no data"), `search()` (page 1), `reset()` (filters back to their defaults, sort kept),
 * `refresh()` (same page), el-table `onSelectionChange`/`onSortChange` (columns `sortable="custom"`),
 * `remove(ids)` (confirm → delete → message → reload), `batchRemove()` (the selected rows) and
 * `exportXlsx(filename)` (the filtered rows of every page, `exporting` while it runs).
 * Loads at once; errors: the request layer's toasts, plus the 400/404 it leaves to callers.
 */
export function useCrudList<T extends object, F extends object = Record<string, unknown>>({
  api,
  filters = {} as F,
  sort,
}: {
  /** `remove` only for pages that delete rows (`remove` / `batchRemove`) */
  api: Pick<CrudApi<T>, 'page'> & Partial<Pick<CrudApi<T>, 'remove' | 'exportFile'>>
  filters?: F
  sort?: string
}) {
  const initial = () => structuredClone({ ...filters }) as F
  const query = reactive({
    page: 1,
    pageSize: PAGE_SIZE_DEFAULT,
    sort,
    ...initial(),
  }) as ListQuery & F
  const rows = shallowRef<T[]>([])
  const total = ref(0)
  const loading = ref(false)
  const selection = shallowRef<T[]>([])
  const filtered = ref(false)
  // the filters as sent (listParams drops '' / null), to compare with the defaults
  const filterKey = (q: object) =>
    JSON.stringify(
      listParams(
        Object.fromEntries(Object.keys(filters).map((k) => [k, (q as Record<string, unknown>)[k]])),
      ),
    )
  const unfiltered = filterKey(filters)
  let seq = 0

  async function refresh(): Promise<void> {
    const mine = ++seq
    loading.value = true
    const withFilters = filterKey(query) !== unfiltered
    try {
      const { items, total: count } = await api.page(listParams(query as Record<string, unknown>))
      if (mine !== seq) return
      // past the last page (its rows deleted meanwhile): go to the last page that has rows
      const last = Math.max(1, Math.ceil(count / query.pageSize))
      if (!items.length && query.page > last) {
        query.page = last
        if (count) return refresh()
      }
      rows.value = items
      total.value = count
      filtered.value = withFilters
    } catch (e) {
      if (mine === seq) toastRest(e)
    } finally {
      if (mine === seq) loading.value = false
    }
  }

  function search() {
    query.page = 1
    return refresh()
  }

  function reset() {
    Object.assign(query, initial())
    return search()
  }

  const onSelectionChange = (selected: T[]) => (selection.value = selected)

  function onSortChange({ prop, order }: { prop: string | null; order: string | null }) {
    query.sort = prop && order ? (order === 'descending' ? `-${prop}` : prop) : sort
    return search()
  }

  /** Confirms, deletes, then reloads; resolves `true` once deleted. */
  async function remove(ids: number[]): Promise<boolean> {
    const del = api.remove
    if (!del || !ids.length || !(await confirmRemove(ids.length, () => del(ids)))) return false
    await refresh()
    return true
  }

  // rows keyed otherwise (sessions: `sid`) have their own actions and never call remove / batchRemove
  const batchRemove = () => remove(selection.value.map((r) => (r as { id: number }).id))

  const exporting = ref(false)
  /** Downloads the rows the current filters and sort select (all pages) as `filename`; bind `exporting` to the button's `loading`. */
  async function exportXlsx(filename: string) {
    if (exporting.value || !api.exportFile) return
    exporting.value = true
    try {
      const {
        page: _page,
        pageSize: _size,
        ...params
      } = listParams(query as Record<string, unknown>)
      await api.exportFile(params, filename)
    } catch (e) {
      toastRest(e)
    } finally {
      exporting.value = false
    }
  }

  void refresh()
  return {
    query,
    rows,
    total,
    loading,
    filtered,
    selection,
    search,
    reset,
    refresh,
    onSelectionChange,
    onSortChange,
    remove,
    batchRemove,
    exporting,
    exportXlsx,
  }
}

/**
 * Tree list page state (docs/codegen-golden.md "Tree"): the whole filtered forest, no paging or server sort.
 * `query` (the filters in `filters`, bound to the search form), `rows`, `loading`, `filtered` (as in
 * `useCrudList`), `search()` / `refresh()` (reload), `reset()` (filters back to their defaults), `remove(id)`
 * (confirm → delete → message → reload) and `expanded` / `toggleExpand()` for expand / collapse all: bind
 * `:default-expand-all="expanded"` and `:key` on the table (a new key re-renders every row that way).
 * Loads at once; errors: the request layer's toasts, plus the 400/404 it leaves to callers.
 */
export function useTreeList<T extends { id: number }, F extends object = Record<string, unknown>>({
  api,
  filters = {} as F,
}: {
  api: Pick<TreeApi<T>, 'list' | 'remove'>
  filters?: F
}) {
  const initial = () => structuredClone({ ...filters }) as F
  const query = reactive(initial()) as F
  const rows = shallowRef<TreeRow<T>[]>([])
  const loading = ref(false)
  const filtered = ref(false)
  const expanded = ref(true)
  // the filters as sent (listParams drops '' / null), to compare with the defaults
  const unfiltered = JSON.stringify(listParams(initial() as Record<string, unknown>))
  let seq = 0

  async function refresh(): Promise<void> {
    const mine = ++seq
    loading.value = true
    const params = listParams(query as Record<string, unknown>)
    try {
      const forest = await api.list(params)
      if (mine !== seq) return
      rows.value = forest
      filtered.value = JSON.stringify(params) !== unfiltered
    } catch (e) {
      if (mine === seq) toastRest(e)
    } finally {
      if (mine === seq) loading.value = false
    }
  }

  function reset() {
    Object.assign(query, initial())
    return refresh()
  }

  /** Confirms, deletes, then reloads; resolves `true` once deleted. */
  async function remove(id: number): Promise<boolean> {
    if (!(await confirmRemove(1, () => api.remove(id)))) return false
    await refresh()
    return true
  }

  const toggleExpand = () => (expanded.value = !expanded.value)

  void refresh()
  return {
    query,
    rows,
    loading,
    filtered,
    search: refresh,
    reset,
    refresh,
    remove,
    expanded,
    toggleExpand,
  }
}

/**
 * Add/edit form shown with `openDialog`; call from the form component's setup with its `id` prop
 * and `emit` (`defineEmits<{ done: [saved: …]; cancel: [] }>()`). With an `id` it loads `GET /:id` and copies
 * the fields `emptyModel()` has (a failed load shows the 400/404 and emits `cancel`); a seeded name (a
 * `seed.*` i18n key; see docs/design-notes.md#i18n) is edited as its text and saved as the key again while the text is
 * unchanged, so it keeps following the language. `submit()` validates
 * with `rules` (the shared zod `schema`, whole model), POSTs / PUTs, then emits `done` with the saved model
 * plus its id (an add: also what else the POST answer holds, e.g. a secret shown once); `row` = the loaded row (edit); `submitting` stays true while the request is pending — bind it to the submit button's
 * `loading` (duplicate submits, `@Idempotent`; see docs/design-notes.md#api-envelope).
 */
export function useCrudForm<T extends object, C extends Record<string, unknown>>({
  api,
  schema,
  emptyModel,
  id,
  emit,
}: {
  api: Pick<CrudApi<T, C>, 'get' | 'create' | 'update'>
  schema: ObjectSchema
  /** the add form's values; a required field may start empty (`null`: the rules report it) */
  emptyModel: () => { [K in keyof C]: C[K] | null }
  /** the row to edit; none = add */
  id?: number
  emit: DialogEmit<C & { id: number }>
}) {
  const model = reactive(emptyModel()) as C
  const formRef = ref<FormInstance>()
  const rules = zodRules(schema, useI18n(), model)
  revalidateOnLocale(formRef)
  const loading = ref(false)
  const submitting = ref(false)
  /** the row as `GET /:id` answered it (edit), for what the form shows beside the model (joined names) */
  const row = shallowRef<T>()
  /** field → [its seed key, the text shown for it] */
  const seeded = new Map<string, [key: string, text: string]>()

  async function load(id: number) {
    loading.value = true
    try {
      const loaded = await api.get(id)
      row.value = loaded
      const data = loaded as Record<string, unknown>
      for (const k of Object.keys(model)) {
        if (!(k in data)) continue
        let value = data[k]
        if (typeof value === 'string' && value.startsWith('seed.') && i18n.global.te(value)) {
          seeded.set(k, [value, tx(value)])
          value = tx(value)
        }
        ;(model as Record<string, unknown>)[k] = value
      }
    } catch (e) {
      toastRest(e)
      emit('cancel')
    } finally {
      loading.value = false
    }
  }

  async function submit() {
    if (submitting.value || loading.value) return
    if (!(await formRef.value?.validate().catch(() => false))) return
    submitting.value = true
    try {
      const body = { ...model }
      // a seeded name left as shown goes back as its key
      for (const [k, [key, text]] of seeded) if (body[k] === text) Object.assign(body, { [k]: key })
      if (id == null) {
        // POST answers with the created row (see docs/design-notes.md#api-envelope); what it adds (a secret shown once) goes along
        const created = (await api.create(body)) as { id: number }
        ElMessage.success(t('crud.msg.created'))
        emit('done', { ...created, ...body, id: created.id })
      } else {
        await api.update(id, body)
        ElMessage.success(t('crud.msg.updated'))
        emit('done', { ...body, id })
      }
    } catch (e) {
      toastRest(e)
    } finally {
      submitting.value = false
    }
  }

  if (id != null) void load(id)
  return { model, row, formRef, rules, loading, submitting, submit }
}
