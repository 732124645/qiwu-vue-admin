// Pickers: the logic of QwUserPicker / QwDeptPicker / QwDictSelect / QwUpload (the web's UserPicker,
// DeptTreeSelect, DictSelect and FileUpload for the phone), here so vitest runs it without the uni compiler.
import { computed, reactive, ref, shallowRef, watch, type Ref } from 'vue'
import {
  STORAGE_MAX_SIZE_DEFAULT,
  storageMaxBytes,
  storageParams,
  type DeptTreeNode,
  type DictPayload,
  type FsObjectVo,
  type PublicParam,
  type StorageBizTag,
  type UserOption,
  type WfUserOption,
} from '@qiwu/shared'
import { formatSize } from './format'
import { locale, t, tx } from './i18n'
import { api, upload } from './request'

/** Several picked names in one cell (as the profile's role names). */
export const joinNames = (names: string[]) => names.join(' · ')

// ---- dicts ------------------------------------------------------------------------------------------------

export interface Choice {
  value: string
  label: string
}

// Once per app run, no `version` check (the web drops entries on realtime dict changes; mobile has
// no socket in v1): an edited dict shows after a restart
const dicts = new Map<string, Promise<DictPayload>>()

/** A dict's enabled entries (GET /settings/dicts/:code/entries, any signed-in user); a failed load retries next time. */
export function loadDict(code: string): Promise<DictPayload> {
  let p = dicts.get(code)
  if (!p) {
    p = api.get<DictPayload>(`/settings/dicts/${encodeURIComponent(code)}/entries`)
    p.catch(() => dicts.delete(code))
    dicts.set(code, p)
  }
  return p
}

/** The entries as options in the current language: `labelI18n[locale]` → `label` (seeded: a key) → `value`. */
export const dictChoices = (dict: DictPayload | undefined): Choice[] =>
  (dict?.entries ?? []).map((e) => ({
    value: e.value,
    label: e.labelI18n?.[locale()] || tx(e.label) || e.value,
  }))

/** The labels of a select's value (one or several); an unknown value shows as itself. */
export const choiceText = (choices: Choice[], value: string | string[] | null | undefined) =>
  joinNames(
    [value ?? []].flat().map((v) => choices.find((c) => c.value === v)?.label ?? v),
  )

// ---- depts ------------------------------------------------------------------------------------------------

/**
 * The enabled depts as a forest (any signed-in user): `iam` GET /iam/depts/tree, the caller's data scope;
 * `wf` GET /wf/depts/options, every one (a process form's dept field: a staff user picks any).
 */
export const loadDepts = (source: 'iam' | 'wf' = 'iam') =>
  api.get<DeptTreeNode[]>(source === 'wf' ? '/wf/depts/options' : '/iam/depts/tree')

export interface DeptChoice {
  value: number
  text: string
  children: DeptChoice[]
}

/** The tree as wd-cascader options; seeded names are keys (re-run it on a language switch). */
export const deptChoices = (nodes: DeptTreeNode[]): DeptChoice[] =>
  nodes.map((n) => ({ value: n.id, text: tx(n.name), children: deptChoices(n.children) }))

/** A dept's path from its root; empty when the tree lacks it. */
export function deptPath(nodes: DeptTreeNode[], id: number): DeptTreeNode[] {
  for (const n of nodes) {
    if (n.id === id) return [n]
    const sub = deptPath(n.children, id)
    if (sub.length) return [n, ...sub]
  }
  return []
}

// ---- users ------------------------------------------------------------------------------------------------

/** `username` only from the iam source */
export type PickedUser = WfUserOption & { username?: string }

/**
 * `wf` (approval pickers: transfer, delegate, add-sign, cc, the initiator's picks): GET /wf/users/options,
 * sign-in only, every enabled user by display name, no dept tree (a staff user's data scope would
 * leave only themselves). `iam`: GET /iam/users/options within the caller's data scope, with the dept tree.
 */
export type UserSource = 'iam' | 'wf'

export const SEARCH_DEBOUNCE_MS = 300

/**
 * The user picker's state. `open(selected)` starts from the field's users (the first open loads the list, and
 * with `iam` the dept tree). The keyword searches 300 ms after the last change; with `iam` the list follows the
 * dept drilled into (`enter` / `back`; a dept lists its whole subtree). A late answer of an older search is
 * dropped. `picked` keeps picks across searches, in picking order.
 */
export function useUserPicker(source: UserSource, multiple: boolean) {
  const keyword = ref('')
  const depts = shallowRef<DeptTreeNode[]>([])
  const path = shallowRef<DeptTreeNode[]>([])
  const dept = () => path.value[path.value.length - 1]
  /** the depts to drill into here: the tree's roots, or the children of the dept drilled into */
  const subDepts = computed(() => dept()?.children ?? depts.value)
  const rows = shallowRef<PickedUser[]>([])
  const loading = ref(false)
  const picked = reactive(new Map<number, PickedUser>())
  let seq = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let started = false

  async function load() {
    clearTimeout(timer)
    const mine = ++seq
    loading.value = true
    // no undefined keys: uni sends them as empty values
    const query: { keyword?: string; deptId?: number } = {}
    const kw = keyword.value.trim()
    if (kw) query.keyword = kw
    try {
      let list: PickedUser[]
      if (source === 'wf') list = await api.get<WfUserOption[]>('/wf/users/options', query)
      else {
        const d = dept()
        if (d) query.deptId = d.id
        list = await api.get<UserOption[]>('/iam/users/options', query)
      }
      if (mine === seq) rows.value = list
    } catch {
      if (mine === seq) rows.value = [] // the request layer showed why
    } finally {
      if (mine === seq) loading.value = false
    }
  }
  watch(keyword, () => {
    clearTimeout(timer)
    timer = setTimeout(load, SEARCH_DEBOUNCE_MS)
  })

  function open(selected: PickedUser[]) {
    picked.clear()
    for (const u of selected) picked.set(u.id, u)
    if (started) return
    started = true
    void load()
    if (source === 'iam')
      loadDepts().then(
        (d) => (depts.value = d),
        () => {}, // shown by the request layer; users can still be searched
      )
  }

  function enter(d: DeptTreeNode) {
    path.value = [...path.value, d]
    void load()
  }
  /** back to the first `depth` depts of the path (0: all depts) */
  function back(depth: number) {
    if (depth === path.value.length) return
    path.value = path.value.slice(0, depth)
    void load()
  }

  /** multiple: adds or removes; single: replaces */
  function toggle(u: PickedUser) {
    if (multiple && picked.has(u.id)) picked.delete(u.id)
    else {
      if (!multiple) picked.clear()
      picked.set(u.id, u)
    }
  }

  return { keyword, path, subDepts, rows, loading, picked, open, enter, back, toggle }
}

// ---- upload -----------------------------------------------------------------------------------------------

/** A file the device picked: its temp path, and name / size where the platform tells them. */
export interface PickedFile {
  path: string
  name?: string
  size?: number
}

export interface PendingUpload {
  key: number
  name: string
}

const toast = (title: string) => uni.showToast({ title, icon: 'none' })
let uploadKey = 0

let serverLimit: Promise<number> | undefined
/**
 * The server's upload limit in bytes (public param `storage.max_size_mb`), read once per app run;
 * the default when unreadable. An admin's change shows after a restart (the server checks every
 * upload anyway).
 */
export const uploadMaxSize = () =>
  (serverLimit ??= api
    .get<PublicParam>(`/settings/params/public/${storageParams.maxSizeMb}`, undefined, {
      silent: true,
    })
    .then(
      (p) => storageMaxBytes(p.value),
      () => STORAGE_MAX_SIZE_DEFAULT,
    ))

/**
 * The upload field's state (the web's FileUpload): `add(files)` checks count and size for quick feedback (the
 * server sniffs, whitelists and limits again), then uploads them one at a time through the backend (uni.uploadFile to POST /storage/objects, `bizTag` sent before the file) and appends each stored object to
 * `model`. A failed upload is toasted by the request layer and leaves the list as it was. `remove` drops an
 * object from the list only (the stored object stays).
 */
export function useUpload(o: {
  model: Ref<FsObjectVo[]>
  bizTag: () => StorageBizTag
  limit: () => number
  /** bytes; unset: the server's limit ({@link uploadMaxSize}) */
  maxSize: () => number | undefined
}) {
  const pending = ref<PendingUpload[]>([])
  const serverMax = ref(STORAGE_MAX_SIZE_DEFAULT)
  void uploadMaxSize().then((v) => (serverMax.value = v))
  const maxSize = () => o.maxSize() ?? serverMax.value
  // a v-model update reaches the prop only once the parent re-renders: build on the list emitted last
  let emitted: FsObjectVo[] | null = null
  watch(o.model, () => (emitted = null), { flush: 'sync' })
  const current = () => emitted ?? o.model.value ?? []
  function update(list: FsObjectVo[]) {
    emitted = list
    o.model.value = list
  }
  const remaining = () => o.limit() - current().length - pending.value.length

  async function add(files: PickedFile[]) {
    const room = Math.max(remaining(), 0)
    const params = { limit: o.limit(), size: formatSize(maxSize()) }
    if (files.length > room) toast(t('picker.upload.limit', params))
    const accepted = files.slice(0, room).filter((f) => {
      if (f.size === undefined || f.size <= maxSize()) return true
      toast(t('picker.upload.tooLarge', { ...params, name: nameOf(f) }))
      return false
    })
    const jobs = accepted.map((f) => ({ f, p: { key: ++uploadKey, name: nameOf(f) } }))
    pending.value.push(...jobs.map((j) => j.p))
    for (const { f, p } of jobs) {
      try {
        const stored = await upload<FsObjectVo>('/storage/objects', f.path, { bizTag: o.bizTag() })
        update([...current(), stored])
      } catch {
        // toasted by the request layer (413 over the limit, 415 a refused type, …)
      } finally {
        pending.value = pending.value.filter((x) => x.key !== p.key)
      }
    }
  }

  const remove = (x: FsObjectVo) => update(current().filter((y) => y !== x))

  return { pending, remaining, maxSize, add, remove }
}

const nameOf = (f: PickedFile) => f.name || f.path.split('/').pop() || f.path
