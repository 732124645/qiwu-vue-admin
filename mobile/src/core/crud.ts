// What the generated uni-app pages share (apps/server/codegen-templates/uni, docs/codegen-golden.md
// "Mobile"), so the templates stay thin: the web's crudApi / treeApi for the phone, dict labels, the user
// picker's value, the number input's value and the date picker (upload columns use the shared uploadsOf /
// uploadText, as the web's).
// Hand-written, not generated.
import { computed, reactive, shallowRef } from 'vue'
import type { DictPayload, Page } from '@qiwu/shared'
import { stateTag } from './approvals'
import { choiceText, dictChoices, loadDict, type PickedUser } from './pickers'
import { api } from './request'

/**
 * The standard endpoints of one resource under `base` (see docs/design-notes.md#api-envelope), e.g. `crudApi<BookVo, BookCreate>('/demo/books')`:
 * `page` = `GET base` → `{ items, total }`, `GET base/:id`, `POST base`, `PUT base/:id`, `DELETE base/:id`.
 */
export function crudApi<T, C extends object = Partial<T> & object>(base: string) {
  return {
    page: (query: object) => api.get<Page<T>>(base, query),
    get: (id: number) => api.get<T>(`${base}/${id}`),
    create: (dto: C) => api.post<T>(base, dto),
    update: (id: number, dto: C) => api.put<T>(`${base}/${id}`, dto),
    remove: (id: number) => api.delete<null>(`${base}/${id}`),
  }
}

/** A tree row as `GET base` of a tree resource answers it: the row plus its children, recursively. */
export type TreeRow<T> = T & { children: TreeRow<T>[] }

/** A tree resource (docs/codegen-golden.md "Tree"): `list` = `GET base`, the whole filtered forest (no paging). */
export function treeApi<T, C extends object = Partial<T> & object>(base: string) {
  const { get, create, update, remove } = crudApi<T, C>(base)
  return {
    list: (query: object = {}) => api.get<TreeRow<T>[]>(base, query),
    get,
    create,
    update,
    remove,
  }
}

/** Node `id` of `forest`, depth first; undefined when it is not there (deleted, out of scope). */
export function findNode<T extends { id: number }>(
  forest: TreeRow<T>[],
  id: number,
): TreeRow<T> | undefined {
  for (const node of forest) {
    if (node.id === id) return node
    const hit = findNode(node.children, id)
    if (hit) return hit
  }
  return undefined
}

/**
 * A form's model: the create body's fields, each may be empty (`null`) until filled; a row list (a master-sub's
 * rows) stays a list of such rows.
 */
export type Form<T> = {
  [K in keyof T]: T[K] extends readonly (infer R)[] ? Form<R>[] : T[K] | null
}

/** Copies the values of the form's own fields from `row` (GET /:id before an edit); the others keep theirs. */
export function fillForm<F extends object>(form: F, row: object) {
  const from = row as Record<string, unknown>
  for (const key of Object.keys(form))
    if (key in from) (form as Record<string, unknown>)[key] = from[key]
}

/**
 * The dicts a page shows (each loaded once per app run, core/pickers.ts): `dictText` a value's label, `dictTag`
 * its label and tag style (`qw-tag--<type>`). Before a dict is there (or when it fails) values show as they are.
 */
export function useDicts(codes: readonly string[]) {
  const dicts = reactive<Record<string, DictPayload>>({})
  for (const code of codes)
    loadDict(code).then(
      (d) => (dicts[code] = d),
      () => {}, // shown by the request layer
    )
  const text = (v: unknown) => (v === null || v === undefined ? '' : String(v))
  return {
    dictText: (code: string, v: unknown) => choiceText(dictChoices(dicts[code]), text(v)),
    dictTag: (code: string, v: unknown) => stateTag(dicts[code], text(v)),
  }
}

/** A list row's second line: the values that are there, joined (`a · b`). */
export const metaLine = (...values: unknown[]) =>
  values.filter((v) => v !== null && v !== undefined && v !== '').join(' · ')

// the users picked in this app run, by id: a user column shows its user's name once picked
const users = new Map<number, PickedUser>()

/**
 * A user column (a user id) as QwUserPicker's `v-model`. A user not picked in this app run (an
 * edited row's) shows as its id, like the web's detail; resolve names when mobile gets a user lookup.
 */
export const usersOf = (id: unknown): PickedUser[] =>
  typeof id === 'number' ? [users.get(id) ?? { id, displayName: String(id), deptName: null }] : []

/** The user column's value of QwUserPicker's pick (remembered for {@link usersOf}); none → null. */
export function userId(list: readonly PickedUser[]): number | null {
  const user = list[0]
  if (user) users.set(user.id, user)
  return user?.id ?? null
}

/**
 * wd-input-number's value as the form's number: it hands back `''` when emptied (→ null) and, with a
 * `precision`, its formatted text when it first shows (`'0.00'` → 0); the shared rules want a number.
 */
export const numOf = (v: number | string): number | null => (v === '' ? null : Number(v))

const pad = (n: number) => String(n).padStart(2, '0')

/** An API date (`YYYY-MM-DD`: that local day) or instant (ISO) as wd-datetime-picker's epoch ms; none → 0. */
export function msOf(value: string | null | undefined): number {
  if (!value) return 0
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  return day ? new Date(+day[1]!, +day[2]! - 1, +day[3]!).getTime() : Date.parse(value)
}

/** The picker's ms as the API's instant (ISO, UTC: the server takes an offset). */
export const isoOf = (ms: number) => new Date(ms).toISOString()

/** The picker's ms as the API's date: the local day, `YYYY-MM-DD`. */
export function dateOf(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** What a date picker is picking: a date or datetime field of the form or of one of its rows. */
export interface Picking {
  on: Record<string, unknown>
  field: string
  type: 'date' | 'datetime'
  title: string
}

/**
 * One wd-datetime-picker for every date / datetime field of a form page: `open(on, field, type, title)` shows
 * it at the field's value (else now); its confirm writes the API's date (`YYYY-MM-DD`) or instant (ISO).
 */
export function useDatePicker() {
  const picking = shallowRef<Picking | null>(null)
  const value = computed(() => {
    const p = picking.value
    const v = p?.on[p.field]
    return msOf(typeof v === 'string' ? v : null) || Date.now()
  })
  const open = (on: Record<string, unknown>, field: string, type: Picking['type'], title: string) =>
    (picking.value = { on, field, type, title })
  function pick({ value: ms }: { value: number }) {
    const p = picking.value
    if (p) p.on[p.field] = p.type === 'date' ? dateOf(ms) : isoOf(ms)
  }
  const closed = (visible: boolean) => visible || (picking.value = null)
  return { picking, value, open, pick, closed }
}
