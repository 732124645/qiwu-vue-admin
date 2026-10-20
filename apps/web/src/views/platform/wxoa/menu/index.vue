<script setup lang="ts">
import { computed, onActivated, onDeactivated, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  fieldLabelKeys,
  utf8Bytes,
  validationMessage,
  WXOA_BUTTON_FIELDS,
  WXOA_BUTTON_KINDS,
  WXOA_MENU_LIMITS,
  wxoaMenuCreate,
  wxoaMenuUpdateFor,
  wxoaPerms,
  type WxoaButtonKind,
  type WxoaMenuCreate,
  type WxoaMenuKind,
  type WxoaMenuUpdate,
  type WxoaMenuVo,
  type WxoaTagVo,
} from '@qiwu/shared'
import { wxoaMenuApi } from '@/api/platform/wxoa/menu'
import DictSelect from '@/core/components/DictSelect.vue'
import EmptyState from '@/core/components/EmptyState.vue'
import { toastRest } from '@/core/composables/use-crud'
import { useDict } from '@/core/composables/use-dict'
import { openDialog } from '@/core/dialog'
import { Icon } from '@/core/icons'
import { usePerm } from '@/core/permission'
import AccountSwitch from '../components/AccountSwitch.vue'
import { useWxoaAccount } from '../components/use-wxoa-account'
import MenuPhone from './MenuPhone.vue'
import WxoaMenuTryMatch from './try-match.vue'
import {
  addSub,
  addTop,
  buttonAt,
  canMove,
  isLegacy,
  isParent,
  issueSlot,
  moveBy,
  nameBytes,
  nameLimit,
  removeAt,
  sameSlot,
  toButtons,
  toDraft,
  type DraftButton,
  type Slot,
} from './menu-layout'

/**
 * Custom menus of the chosen account (see docs/design-notes.md#wxoa): the default menu and conditional
 * ones in a list, the selected one in a phone preview with its buttons' form. A save stores a draft;
 * publishing sends it to WeChat. Checks are the server's (the shared schemas), byte counts included.
 */
// keep-alive name = the seeded menu's component_name
defineOptions({ name: 'WxoaMenu' })

const { t, te } = useI18n()
const perm = usePerm()
const canModify = computed(() => perm.has(wxoaPerms.menu.modify))
const canPublish = computed(() => perm.has(wxoaPerms.menu.publish))
/** deleting a published conditional menu deletes it on WeChat too: that takes the publish permission */
const isLive = (m: WxoaMenuVo | null) => m?.menuKind === 'conditional' && !!m.publishedAt
/** the tag list lives on the fan page; without it a menu can match a platform only */
const canBrowseTags = computed(() => perm.has(wxoaPerms.tag.browse))
const { accountId } = useWxoaAccount()
const kindDict = useDict('wxoa.button_kind')
const platformDict = useDict('wxoa.client_platform')

interface Draft {
  menuKind: WxoaMenuKind
  label: string
  matchTagId: number | null
  matchPlatform: string | null
  buttons: DraftButton[]
}

const menus = shallowRef<WxoaMenuVo[]>([])
const tags = shallowRef<WxoaTagVo[]>([])
const loading = ref(false)
/** the account whose menus are shown */
let shownAccount: number | null = null
/** the saved menu being edited; null with a draft: a new one */
const current = shallowRef<WxoaMenuVo | null>(null)
const draft = ref<Draft | null>(null)
const slot = ref<Slot | null>(null)
/** problems show once a save was tried; byte counts show all along */
const tried = ref(false)
/** the body as last loaded or saved */
const baseline = ref('')

const canRemove = computed(() => canModify.value && (canPublish.value || !isLive(current.value)))
const defaultMenu = computed(() => menus.value.find((m) => m.menuKind === 'default'))
const conditionals = computed(() => menus.value.filter((m) => m.menuKind === 'conditional'))

const body = computed(() => {
  const d = draft.value
  if (!d) return null
  const conditional = d.menuKind === 'conditional'
  return {
    label: d.label,
    // a cleared select leaves '' or undefined
    matchTagId: conditional && typeof d.matchTagId === 'number' ? d.matchTagId : null,
    matchPlatform: (conditional && d.matchPlatform) || null,
    buttons: toButtons(d.buttons),
  }
})
const dirty = computed(() => body.value !== null && JSON.stringify(body.value) !== baseline.value)
const updateSchema = computed(() => current.value && wxoaMenuUpdateFor(current.value))
const parsed = computed(() => {
  const d = draft.value
  if (!d || !body.value) return null
  return updateSchema.value
    ? updateSchema.value.safeParse(body.value)
    : wxoaMenuCreate.safeParse({ accountId: accountId.value, menuKind: d.menuKind, ...body.value })
})

function message(issue: Parameters<typeof validationMessage>[0]) {
  const { key, params } = validationMessage(issue)
  const label = fieldLabelKeys('wxoa.menu', issue.path).find((k) => te(k))
  return t(key, { ...params, field: label ? t(label) : '' })
}
const shown = computed(() => (tried.value ? (parsed.value?.error?.issues ?? []) : []))
const slotKey = ({ i, j }: Slot) => (j === undefined ? `${i}` : `${i}.${j}`)
const invalid = computed(
  () =>
    new Set(
      shown.value.flatMap((issue) => {
        const at = issueSlot(issue.path)
        return at ? [slotKey(at.slot)] : []
      }),
    ),
)
/** problems of the menu itself (label, match, no button) by field, then of the selected button */
const menuErrors = computed(() => {
  const out: Record<string, string> = {}
  for (const issue of shown.value)
    if (!issueSlot(issue.path)) out[String(issue.path[0] ?? '')] ??= message(issue)
  return out
})
const buttonErrors = computed(() => {
  const out: Record<string, string> = {}
  for (const issue of shown.value) {
    const at = issueSlot(issue.path)
    if (at?.prop && sameSlot(at.slot, slot.value)) out[at.prop] ??= message(issue)
  }
  return out
})

const selected = computed(() =>
  draft.value && slot.value ? buttonAt(draft.value.buttons, slot.value) : undefined,
)
const BYTE_LIMITS: Partial<Record<string, number>> = {
  key: WXOA_MENU_LIMITS.keyBytes,
  url: WXOA_MENU_LIMITS.urlBytes,
  pagePath: WXOA_MENU_LIMITS.urlBytes,
}
type FieldProp = (typeof WXOA_BUTTON_FIELDS)[WxoaButtonKind][number]
const fieldBytes = (prop: FieldProp) => utf8Bytes(selected.value?.[prop] ?? '')
const fieldsOf = (kind: WxoaButtonKind | undefined) => (kind ? WXOA_BUTTON_FIELDS[kind] : [])

function edit(row: WxoaMenuVo | null) {
  current.value = row
  draft.value = row && {
    menuKind: row.menuKind,
    label: row.label,
    matchTagId: row.matchTagId,
    matchPlatform: row.matchPlatform,
    buttons: toDraft(row.buttons),
  }
  started()
}
function started() {
  slot.value = draft.value?.buttons.length ? { i: 0 } : null
  tried.value = false
  baseline.value = body.value ? JSON.stringify(body.value) : ''
}

let seq = 0
async function load(keep?: number) {
  const account = accountId.value
  const mine = ++seq
  shownAccount = account
  if (account == null) {
    menus.value = []
    tags.value = []
    edit(null)
    return
  }
  loading.value = true
  try {
    const [list, tagList] = await Promise.all([
      wxoaMenuApi.list(account),
      canBrowseTags.value ? wxoaMenuApi.tags(account).catch(() => []) : [],
    ])
    if (mine !== seq) return
    menus.value = list
    tags.value = tagList
    edit(
      list.find((m) => m.id === keep) ??
        list.find((m) => m.menuKind === 'default') ??
        list[0] ??
        null,
    )
  } catch (e) {
    if (mine !== seq) return
    // never leave another account's menus on screen
    menus.value = []
    tags.value = []
    edit(null)
    toastRest(e)
  } finally {
    if (mine === seq) loading.value = false
  }
}

async function ask(text: string, action: string): Promise<boolean> {
  try {
    await ElMessageBox.confirm(text, t('crud.confirm.title'), {
      type: 'warning',
      confirmButtonText: action,
      cancelButtonText: t('common.action.cancel'),
    })
    return true
  } catch {
    return false
  }
}
const keepEditing = async () =>
  dirty.value &&
  !(await ask(
    t('wxoa.menu.discardConfirm', { label: draft.value?.label || t('wxoa.menu.untitled') }),
    t('wxoa.menu.discard'),
  ))

// The account is shared by every wxoa page and keep-alive keeps this page's watcher running while
// another one is shown: an account switched there is followed once this page shows again.
let active = true
onActivated(() => {
  active = true
  void follow()
})
onDeactivated(() => (active = false))

/** another account: its menus, unless the user keeps editing this one (the switch goes back) */
async function follow() {
  if (!active || accountId.value === shownAccount) return
  if (shownAccount != null && (await keepEditing())) {
    accountId.value = shownAccount
    // the account shown is gone or disabled by now: the switch cannot go back
    if (accountId.value === shownAccount) return
  }
  await load()
}
watch(accountId, follow, { immediate: true })

async function open(row: WxoaMenuVo) {
  if (row.id !== current.value?.id && !(await keepEditing())) edit(row)
}
async function create(menuKind: WxoaMenuKind) {
  if (await keepEditing()) return
  current.value = null
  draft.value = {
    menuKind,
    label: menuKind === 'default' ? t('wxoa.menu.kind.default') : '',
    matchTagId: null,
    matchPlatform: null,
    buttons: [],
  }
  started()
}
async function cancelNew() {
  if (!(await keepEditing())) edit(defaultMenu.value ?? menus.value[0] ?? null)
}

function onAddTop() {
  if (draft.value) slot.value = addTop(draft.value.buttons) ?? slot.value
}
function onAddSub(i: number) {
  if (draft.value) slot.value = addSub(draft.value.buttons, i) ?? slot.value
}
function onMove(delta: -1 | 1) {
  if (draft.value && slot.value) slot.value = moveBy(draft.value.buttons, slot.value, delta)
}
function onRemove() {
  if (draft.value && slot.value) slot.value = removeAt(draft.value.buttons, slot.value)
}

const saving = ref(false)
async function save() {
  const result = parsed.value
  if (!result || saving.value) return
  tried.value = true
  if (!result.success) {
    const first = shown.value.map((i) => issueSlot(i.path)).find(Boolean)
    if (first) slot.value = first.slot
    ElMessage.error(t('wxoa.menu.fixErrors'))
    return
  }
  saving.value = true
  try {
    let id = current.value?.id
    if (id != null) await wxoaMenuApi.update(id, result.data as WxoaMenuUpdate)
    else id = (await wxoaMenuApi.create(result.data as WxoaMenuCreate)).id
    ElMessage.success(t('crud.msg.updated'))
    await load(id)
  } catch (e) {
    toastRest(e)
  } finally {
    saving.value = false
  }
}

/** the WeChat action running (one at a time) */
const busy = ref<'publish' | 'remove' | 'pull' | 'clear' | null>(null)
async function upstream(
  name: NonNullable<typeof busy.value>,
  confirmText: string,
  action: string,
  call: () => Promise<string>,
  keep?: number,
) {
  if (busy.value || !(await ask(confirmText, action))) return
  busy.value = name
  try {
    const done = await call()
    if (done) ElMessage.success(done)
    await load(keep)
  } catch (e) {
    toastRest(e)
  } finally {
    busy.value = null
  }
}

function publish() {
  const row = current.value
  if (!row || dirty.value) return
  return upstream(
    'publish',
    t('wxoa.menu.publish.confirm'),
    t('wxoa.menu.publish.action'),
    async () => {
      await wxoaMenuApi.publish(row.id)
      return t('wxoa.menu.publish.done')
    },
    row.id,
  )
}
function removeMenu() {
  const row = current.value
  if (!row) return
  return upstream(
    'remove',
    isLive(row)
      ? t('wxoa.menu.remove.confirmLive', { label: row.label })
      : t('wxoa.menu.remove.confirm', { label: row.label }),
    t('crud.action.delete'),
    async () => {
      await wxoaMenuApi.remove(row.id)
      return t('crud.msg.deleted')
    },
  )
}
function pull() {
  const account = accountId.value
  if (account == null) return
  return upstream('pull', t('wxoa.menu.pull.confirm'), t('wxoa.menu.pull.action'), async () => {
    const { skipped } = await wxoaMenuApi.pull(account)
    if (!skipped.length) return t('wxoa.menu.pull.done')
    for (const reason of ['no_match', 'invalid'] as const) {
      const count = skipped.filter((s) => s.reason === reason).length
      if (count)
        ElMessage.warning({
          message: t(`wxoa.menu.pull.skipped.${reason}`, { count }),
          duration: 0,
          showClose: true,
        })
    }
    return ''
  })
}
async function clear() {
  const account = accountId.value
  if (account == null || busy.value || (await keepEditing())) return
  return upstream(
    'clear',
    t('wxoa.menu.clear.confirm'),
    t('wxoa.menu.clear.action'),
    async () => {
      await wxoaMenuApi.clear(account)
      return t('wxoa.menu.clear.done')
    },
    current.value?.id,
  )
}
function tryMatch() {
  if (accountId.value == null) return
  return openDialog(
    WxoaMenuTryMatch,
    { accountId: accountId.value },
    { title: () => t('wxoa.menu.tryMatch.title'), width: 480 },
  )
}

/** where a saved menu stands against WeChat */
function stateOf(m: WxoaMenuVo): 'draft' | 'changed' | 'live' {
  return !m.publishedAt ? 'draft' : m.unpublished ? 'changed' : 'live'
}
const tagName = (id: number) => tags.value.find((x) => x.tagId === id)?.name ?? `#${id}`
const tagOptions = computed(() => {
  const id = draft.value?.matchTagId
  const known = tags.value.map((x) => ({ value: x.tagId, label: x.name }))
  return id == null || known.some((o) => o.value === id)
    ? known
    : [...known, { value: id, label: `#${id}` }]
})
function matchText(m: Pick<WxoaMenuVo, 'matchTagId' | 'matchPlatform'>) {
  const parts = []
  if (m.matchTagId != null) parts.push(t('wxoa.menu.matchTag', { tag: tagName(m.matchTagId) }))
  if (m.matchPlatform)
    parts.push(t('wxoa.menu.matchPlatform', { platform: platformDict.label(m.matchPlatform) }))
  return parts.join(' · ')
}
</script>

<template>
  <div class="qw-page">
    <div class="qw-page-bar">
      <AccountSwitch class="qw-page-bar__context" />
      <template v-if="accountId != null">
        <el-button @click="tryMatch">
          <el-icon class="el-icon--left"><Icon icon="lucide:user-search" /></el-icon>
          {{ t('wxoa.menu.tryMatch.action') }}
        </el-button>
        <el-button
          v-if="canModify"
          :loading="busy === 'pull'"
          :disabled="busy !== null"
          @click="pull"
        >
          <el-icon class="el-icon--left"><Icon icon="lucide:cloud-download" /></el-icon>
          {{ t('wxoa.menu.pull.action') }}
        </el-button>
        <el-button
          v-if="canPublish"
          type="danger"
          plain
          :loading="busy === 'clear'"
          :disabled="busy !== null"
          @click="clear"
        >
          {{ t('wxoa.menu.clear.action') }}
        </el-button>
      </template>
    </div>

    <div v-if="accountId != null" v-loading="loading" class="menu-page">
      <el-card class="menu-list" shadow="never">
        <div class="menu-list__title">{{ t('wxoa.menu.kind.default') }}</div>
        <button
          v-if="defaultMenu"
          type="button"
          class="menu-item"
          :class="{ 'is-active': current?.id === defaultMenu.id }"
          :aria-current="current?.id === defaultMenu.id || undefined"
          @click="open(defaultMenu)"
        >
          <span class="menu-item__label">{{ defaultMenu.label }}</span>
          <span class="menu-item__state" :class="`is-${stateOf(defaultMenu)}`">
            {{ t(`wxoa.menu.state.${stateOf(defaultMenu)}`) }}
          </span>
        </button>
        <el-button v-else-if="canModify" link type="primary" @click="create('default')">
          {{ t('wxoa.menu.newDefault') }}
        </el-button>
        <div v-else class="muted">{{ t('wxoa.menu.noDefault') }}</div>

        <div class="menu-list__title">{{ t('wxoa.menu.kind.conditional') }}</div>
        <button
          v-for="m in conditionals"
          :key="m.id"
          type="button"
          class="menu-item"
          :class="{ 'is-active': current?.id === m.id }"
          :aria-current="current?.id === m.id || undefined"
          @click="open(m)"
        >
          <span class="menu-item__label">{{ m.label }}</span>
          <span class="menu-item__state" :class="`is-${stateOf(m)}`">
            {{ t(`wxoa.menu.state.${stateOf(m)}`) }}
          </span>
          <span class="menu-item__match">{{ matchText(m) }}</span>
        </button>
        <div v-if="!conditionals.length" class="muted">{{ t('wxoa.menu.noConditional') }}</div>
        <el-button v-if="canModify" link type="primary" @click="create('conditional')">
          {{ t('wxoa.menu.newConditional') }}
        </el-button>
        <div class="field-hint">{{ t('wxoa.menu.conditionalHint') }}</div>
      </el-card>

      <template v-if="draft">
        <div class="menu-preview">
          <MenuPhone
            :buttons="draft.buttons"
            :selected="slot"
            :editable="canModify"
            :invalid="invalid"
            @select="slot = $event"
            @add-top="onAddTop"
            @add-sub="onAddSub"
          >
            <div class="menu-preview__label">{{ draft.label }}</div>
          </MenuPhone>
          <div v-if="menuErrors.buttons" class="menu-error">{{ menuErrors.buttons }}</div>
        </div>

        <el-card class="menu-editor" shadow="never">
          <el-alert
            v-if="!current"
            type="info"
            :closable="false"
            :title="t('wxoa.menu.notice.new')"
          />
          <el-alert
            v-else-if="dirty"
            type="warning"
            :closable="false"
            :title="t('wxoa.menu.notice.unsaved')"
          />
          <el-alert
            v-else-if="stateOf(current) === 'changed'"
            type="warning"
            :closable="false"
            :title="t('wxoa.menu.notice.unpublished')"
          />
          <el-alert
            v-else-if="stateOf(current) === 'draft'"
            type="info"
            :closable="false"
            :title="t('wxoa.menu.notice.draft')"
          />
          <el-alert
            v-else
            type="success"
            :closable="false"
            :title="
              t('wxoa.menu.notice.live', {
                at: dayjs(current.publishedAt).format('YYYY-MM-DD HH:mm'),
              })
            "
          />

          <el-form label-position="top" :disabled="!canModify" class="menu-form" @submit.prevent>
            <el-form-item :label="t('field.wxoa.menu.label')" :error="menuErrors.label" required>
              <el-input v-model="draft.label" maxlength="64" />
            </el-form-item>
            <template v-if="draft.menuKind === 'conditional'">
              <el-form-item :label="t('field.wxoa.menu.matchTagId')" :error="menuErrors.matchTagId">
                <el-select v-model="draft.matchTagId" clearable filterable>
                  <el-option
                    v-for="o in tagOptions"
                    :key="o.value"
                    :value="o.value"
                    :label="o.label"
                  />
                </el-select>
              </el-form-item>
              <el-form-item
                :label="t('field.wxoa.menu.matchPlatform')"
                :error="menuErrors.matchPlatform"
              >
                <DictSelect v-model="draft.matchPlatform" code="wxoa.client_platform" />
              </el-form-item>
              <div class="field-hint">{{ t('wxoa.menu.matchHint') }}</div>
              <div v-if="!canBrowseTags" class="field-hint">
                {{ t('wxoa.menu.tagNeedsBrowse') }}
              </div>
            </template>

            <el-divider />

            <template v-if="selected && slot">
              <template v-if="isLegacy(selected)">
                <el-alert type="info" :closable="false" :title="t('wxoa.menu.legacy')" />
                <el-form-item :label="t('field.wxoa.menu.name')">
                  <span class="readonly">{{ selected.name }}</span>
                </el-form-item>
                <el-form-item :label="t('field.wxoa.menu.kind')">
                  <span class="readonly">{{ kindDict.label(selected.kind) }}</span>
                </el-form-item>
                <el-form-item :label="t('field.wxoa.menu.mediaId')">
                  <span class="readonly">{{ selected.mediaId }}</span>
                </el-form-item>
              </template>
              <template v-else>
                <el-form-item
                  :label="t('field.wxoa.menu.name')"
                  :error="buttonErrors.name"
                  required
                >
                  <el-input v-model="selected.name">
                    <template #suffix>
                      <span
                        class="bytes"
                        :class="{ 'is-over': nameBytes(selected) > nameLimit(slot) }"
                      >
                        {{
                          t('wxoa.menu.bytes', { used: nameBytes(selected), max: nameLimit(slot) })
                        }}
                      </span>
                    </template>
                  </el-input>
                </el-form-item>
                <div v-if="isParent(selected)" class="field-hint">
                  {{ t('wxoa.menu.parentHint') }}
                </div>
                <template v-else>
                  <el-form-item
                    :label="t('field.wxoa.menu.kind')"
                    :error="buttonErrors.kind"
                    required
                  >
                    <el-select v-model="selected.kind">
                      <el-option
                        v-for="k in WXOA_BUTTON_KINDS"
                        :key="k"
                        :value="k"
                        :label="kindDict.label(k)"
                      />
                    </el-select>
                  </el-form-item>
                  <el-form-item
                    v-for="prop in fieldsOf(selected.kind)"
                    :key="prop"
                    :label="t(`field.wxoa.menu.${prop}`)"
                    :error="buttonErrors[prop]"
                    required
                  >
                    <el-input v-model="selected[prop]">
                      <template v-if="BYTE_LIMITS[prop]" #suffix>
                        <span
                          class="bytes"
                          :class="{ 'is-over': fieldBytes(prop) > BYTE_LIMITS[prop]! }"
                        >
                          {{
                            t('wxoa.menu.bytes', { used: fieldBytes(prop), max: BYTE_LIMITS[prop] })
                          }}
                        </span>
                      </template>
                    </el-input>
                    <div v-if="prop === 'key'" class="field-hint">{{ t('wxoa.menu.keyHint') }}</div>
                    <div
                      v-if="prop === 'url' && selected.kind === 'miniprogram'"
                      class="field-hint"
                    >
                      {{ t('wxoa.menu.miniprogramUrlHint') }}
                    </div>
                  </el-form-item>
                </template>
              </template>
              <div v-if="canModify" class="button-actions">
                <el-button
                  size="small"
                  :disabled="!canMove(draft.buttons, slot, -1)"
                  @click="onMove(-1)"
                >
                  <el-icon class="el-icon--left">
                    <Icon :icon="slot.j === undefined ? 'lucide:arrow-left' : 'lucide:arrow-up'" />
                  </el-icon>
                  {{ t('wxoa.menu.moveEarlier') }}
                </el-button>
                <el-button
                  size="small"
                  :disabled="!canMove(draft.buttons, slot, 1)"
                  @click="onMove(1)"
                >
                  <el-icon class="el-icon--left">
                    <Icon
                      :icon="slot.j === undefined ? 'lucide:arrow-right' : 'lucide:arrow-down'"
                    />
                  </el-icon>
                  {{ t('wxoa.menu.moveLater') }}
                </el-button>
                <el-button size="small" type="danger" plain @click="onRemove">
                  {{ t('wxoa.menu.removeButton') }}
                </el-button>
              </div>
            </template>
            <div v-else class="muted">{{ t('wxoa.menu.pickButton') }}</div>
          </el-form>

          <div class="menu-editor__footer">
            <el-button v-if="!current" @click="cancelNew">{{
              t('common.action.cancel')
            }}</el-button>
            <el-button
              v-else-if="canRemove"
              type="danger"
              plain
              :loading="busy === 'remove'"
              :disabled="busy !== null"
              @click="removeMenu"
            >
              {{ t('crud.action.delete') }}
            </el-button>
            <el-button
              v-if="canModify"
              type="primary"
              :loading="saving"
              :disabled="saving"
              @click="save"
            >
              {{ t('crud.action.save') }}
            </el-button>
            <el-button
              v-if="canPublish && current"
              type="success"
              :loading="busy === 'publish'"
              :disabled="busy !== null || dirty"
              :title="dirty ? t('wxoa.menu.publish.saveFirst') : undefined"
              @click="publish"
            >
              {{ t('wxoa.menu.publish.action') }}
            </el-button>
          </div>
        </el-card>
      </template>
      <EmptyState v-else-if="!loading" :description="t('wxoa.menu.empty')" class="menu-empty" />
    </div>
  </div>
</template>

<style scoped>
.menu-page {
  display: grid;
  grid-template-columns: 240px auto minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
@media (max-width: 1100px) {
  .menu-page {
    grid-template-columns: minmax(0, 1fr);
  }
}
.menu-list :deep(.el-card__body) {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
}
.menu-list__title {
  margin-top: 4px;
  font-weight: 600;
  color: var(--qw-text-2);
}
.menu-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 2px 8px;
  width: 100%;
  padding: 8px 10px;
  font: inherit;
  color: var(--qw-text);
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius-sm);
}
.menu-item:hover {
  background: var(--qw-neutral-weak);
}
.menu-item.is-active {
  background: var(--qw-brand-weak);
  border-color: var(--qw-brand);
}
.menu-item__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.menu-item__state {
  font-size: 12px;
}
.menu-item__state.is-draft {
  color: var(--qw-text-3);
}
.menu-item__state.is-changed {
  color: var(--qw-warning);
}
.menu-item__state.is-live {
  color: var(--qw-success);
}
.menu-item__match {
  grid-column: 1 / -1;
  font-size: 12px;
  color: var(--qw-text-3);
}
.menu-preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
}
.menu-preview__label {
  font-size: 12px;
  color: var(--qw-text-3);
  text-align: center;
}
.menu-error {
  color: var(--qw-danger);
}
.menu-form {
  margin-top: 16px;
}
.menu-form .el-select {
  width: 100%;
}
.button-actions,
.menu-editor__footer {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.menu-editor__footer {
  justify-content: flex-end;
  margin-top: 16px;
}
.bytes {
  font-size: 12px;
  color: var(--qw-text-3);
}
.bytes.is-over {
  color: var(--qw-danger);
}
.readonly {
  word-break: break-all;
}
.field-hint {
  width: 100%;
  margin-bottom: 8px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--qw-text-3);
}
.muted {
  color: var(--qw-text-3);
}
@media (min-width: 1101px) {
  .menu-empty {
    grid-column: 2 / -1;
  }
}
</style>
