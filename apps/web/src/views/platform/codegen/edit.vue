<script setup lang="ts">
import { computed, reactive, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  CG_GROUPS,
  CG_QUERY_OPS,
  CG_TEMPLATES,
  CG_TS_TYPES,
  CG_WIDGETS,
  cgClassName,
  cgColumnFields,
  cgDictCode,
  cgTableFields,
  cgTableOptions,
  cgTableUpdate,
  codegenPerms,
  LOCALES,
  PAGE_SIZE_MAX,
  validationMessage,
  type CgColumnVo,
  type CgImportableVo,
  type CgParentMenuNode,
  type CgTableDetailVo,
  type CgTableOptions,
  type CgTableUpdate,
  type CgTableVo,
  type I18nText,
  type Locale,
} from '@qiwu/shared'
import { codegenApi, type DictOption } from '@/api/platform/codegen'
import IconPicker from '@/core/components/IconPicker.vue'
import QwEditTable from '@/core/components/QwEditTable.vue'
import { openDialog } from '@/core/dialog'
import { localized } from '@/core/i18n'
import { Icon } from '@/core/icons'
import { usePerm } from '@/core/permission'
import { useTagsStore } from '@/core/stores/tags'
import CodegenPreview from './preview.vue'

/**
 * Generator config of one table (hidden page `/codegen/tables/:id`): basic info, the columns as
 * an editable grid and the generation settings, saved together (`PUT /:id`, the whole config checked with
 * the shared `cgTableUpdate` first). The template decides which settings apply: a tree needs its parent and
 * label columns and ignores the detail drawer, read-only, export, import and options. `options.referencedBy`
 * (the rows elsewhere that keep one from being deleted) is an editable list: its table picker offers
 * this database's tables (the imported configs, and the importable ones with the import perm), its column
 * picker the columns of an imported one; a name either lacks can be typed (the server checks both on save,
 * 422 C3009).
 */
defineOptions({ name: 'CodegenTableEdit' })
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const tags = useTagsStore()
const perm = usePerm()
const canSave = computed(() => perm.has(codegenPerms.modify))
const id = Number(route.params.id)

/** A text in every language (the shared schemas require both). */
type Texts = Record<Locale, string>
/** A reference as edited: table and column unset until picked (the check then says "required"). */
type RefRow = { table?: string; column?: string; label: string }
/** The loaded config as edited: texts filled for both languages, options objects present. */
type Form = Omit<CgTableDetailVo, 'options'> & {
  featureNameI18n: Texts
  options: Omit<CgTableOptions, 'referencedBy'> & { referencedBy: RefRow[] }
  columns: (CgColumnVo & { labelI18n: Texts })[]
}
const form = ref<Form>()
/** A parent-menu option: keyed by route name (a group without one by its id), unpickable ones disabled. */
type MenuOption = CgParentMenuNode & { value: string; disabled: boolean; children: MenuOption[] }
const toOptions = (nodes: CgParentMenuNode[]): MenuOption[] =>
  nodes.map((n) => ({
    ...n,
    value: n.routeName ?? `#${n.id}`,
    disabled: !n.pickable,
    children: toOptions(n.children),
  }))
const parentMenus = shallowRef<MenuOption[]>([])
const dicts = shallowRef<DictOption[]>([])
const loading = ref(true)
const saving = ref(false)
const tab = ref('basic')

const texts = (v: Partial<I18nText> | null | undefined) =>
  Object.fromEntries(LOCALES.map((l) => [l, v?.[l] ?? ''])) as Texts
const blank = (v: Partial<I18nText> | undefined) => !v || LOCALES.every((l) => !v[l]?.trim())

async function load() {
  loading.value = true
  try {
    const d = await codegenApi.get(id)
    const options = d.options ?? {}
    form.value = {
      ...d,
      featureNameI18n: texts(d.featureNameI18n),
      options: {
        ...options,
        entityI18n: texts(options.entityI18n),
        referencedBy: options.referencedBy?.map((r) => ({ ...r })) ?? [],
      },
      columns: d.columns.map((c) => ({
        ...c,
        labelI18n: texts(c.labelI18n),
        options: c.options ?? {},
      })),
    }
  } catch {
    // the request layer toasted 403 / 5xx; 404 leaves an empty page with the way back
  } finally {
    loading.value = false
  }
}
void load()
// the pickers: an empty list when unavailable (the stored value still shows); the groups again each time
// their picker opens (built meanwhile in the menu page)
const loadParentMenus = () =>
  codegenApi
    .parentMenus()
    .then((m) => (parentMenus.value = toOptions(m)))
    .catch(() => undefined)
void loadParentMenus()
codegenApi
  .dictOptions()
  .then((d) => (dicts.value = d))
  .catch(() => undefined)
// every config: a sub-table config links to a master (the other configs of template master_sub); the
// reference pickers offer their tables and columns
const configs = shallowRef<CgTableVo[]>([])
codegenApi
  .page({ page: 1, pageSize: PAGE_SIZE_MAX })
  .then((p) => (configs.value = p.items))
  .catch(() => undefined)
const masters = computed(() =>
  configs.value.filter((r) => r.template === 'master_sub' && r.id !== id),
)
// the tables not imported yet (names and comments only), with the import perm
const importable = shallowRef<CgImportableVo[]>([])
if (perm.has(codegenPerms.import))
  codegenApi
    .importable()
    .then((list) => (importable.value = list))
    .catch(() => undefined)

const columnNames = computed(() => form.value?.columns.map((c) => c.columnName) ?? [])
const hasDeptId = computed(() => columnNames.value.includes('dept_id'))
const isTree = computed(() => form.value?.template === 'tree')
/** a column holding another row's id: an integer column, not the key */
const idColumn = (c: Pick<CgColumnVo, 'isPk' | 'columnType'>) =>
  !c.isPk && /^(big|medium|small)?int\b/.test(c.columnType)
/** a sub table's column holding the master row's id */
const fkColumns = computed(
  () => form.value?.columns.filter(idColumn).map((c) => c.columnName) ?? [],
)
/** Linking to a master starts on the first `*_id` column; unlinking clears the column. */
function onMaster(masterId: number | null | undefined) {
  const f = form.value
  if (!f) return
  f.masterTableId = masterId ?? null
  if (f.masterTableId == null) f.subFkCol = null
  else f.subFkCol ??= fkColumns.value.find((c) => c.endsWith('_id')) ?? null
}

/** The template's linked fields: a tree starts on `parent_id` and its first name / title column. */
function onTemplate(template: string) {
  const f = form.value
  if (!f || template !== 'tree') return
  if (!f.treeParentCol && columnNames.value.includes('parent_id')) f.treeParentCol = 'parent_id'
  f.treeLabelCol ??= columnNames.value.find((c) => /(name|title)$/.test(c)) ?? null
}

/**
 * Another domain or business: the class name (plain or with the domain in front) and the
 * enum-code columns' dicts still at what the old names derive follow the new ones; edited ones stay.
 * A cleared domain derives both alike: the last plain / qualified seen goes on.
 */
let qualified = false
function rename(names: { domain?: string; business?: string }) {
  const f = form.value
  if (!f) return
  const next = { domain: f.domain, business: f.business, ...names }
  const derived = [false, true].filter((q) => f.className === cgClassName(f.domain, f.business, q))
  if (derived.length === 1) qualified = derived[0]!
  if (derived.length) f.className = cgClassName(next.domain, next.business, qualified)
  for (const c of f.columns)
    if (c.dictCode && c.dictCode === cgDictCode(f.domain, f.business, c.columnName))
      c.dictCode = cgDictCode(next.domain, next.business, c.columnName)
  Object.assign(f, next)
}

/** The reference table picker: table name → comment, of the imported configs and importable tables. */
const refTables = computed(
  () =>
    new Map(
      [...configs.value, ...importable.value]
        .map((r) => [r.tableName, r.tableComment] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
)
/**
 * Columns of a referencing table that may hold this table's ids (integer, not the key nor the audit
 * user ids), fetched once when its column picker opens: known for configs only.
 */
const refColumns = reactive(new Map<string, string[]>())
function loadRefColumns(table: string | undefined) {
  const config = configs.value.find((c) => c.tableName === table)
  if (!table || !config || refColumns.has(table)) return
  refColumns.set(table, [])
  codegenApi
    .get(config.id)
    .then((d) =>
      refColumns.set(
        table,
        d.columns
          .filter((c) => idColumn(c) && !['created_by', 'updated_by'].includes(c.columnName))
          .map((c) => c.columnName),
      ),
    )
    .catch(() => refColumns.delete(table))
}
/**
 * Another table clears the column (it named one of the old table); the label follows the table's
 * comment while blank or still the old table's comment, a typed one stays.
 */
function onRefTable(row: RefRow, table: string) {
  const comment = (name?: string) =>
    refTables.value
      .get(name ?? '')
      ?.trim()
      .slice(0, 64) ?? ''
  if (!row.label || row.label === comment(row.table)) row.label = comment(table)
  if (row.table !== table) row.column = undefined
  row.table = table
}
const newRef = (): RefRow => ({ label: '' })
const REF_COLUMNS = [
  { prop: 'table', label: 'field.codegen.table', minWidth: 220, required: true },
  { prop: 'column', label: 'field.codegen.column', minWidth: 180, required: true },
  { prop: 'label', label: 'field.codegen.label', minWidth: 180, required: true },
]

const pick = (o: object, keys: string[]) =>
  Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, (o as Record<string, unknown>)[k]]))

/** The PUT body: every editable field (the shared schemas' keys) of the table and its columns. */
function body(f: Form): CgTableUpdate {
  const table = pick(f, Object.keys(cgTableFields.shape)) as CgTableUpdate
  const { entityI18n, referencedBy, ...options } = pick(
    f.options,
    Object.keys(cgTableOptions.shape),
  ) as NonNullable<CgTableUpdate['options']> & { entityI18n?: I18nText }
  return {
    ...table,
    treeParentCol: f.template === 'tree' ? f.treeParentCol : null,
    treeLabelCol: f.template === 'tree' ? f.treeLabelCol : null,
    // only a single-table config is a master's sub table
    masterTableId: f.template === 'crud' ? f.masterTableId : null,
    subFkCol: f.template === 'crud' && f.masterTableId != null ? f.subFkCol : null,
    note: f.note?.trim() || null,
    options: {
      ...options,
      ...(blank(entityI18n) ? {} : { entityI18n }),
      // none left = none stored (the options are replaced whole)
      ...(referencedBy?.length ? { referencedBy } : {}),
    },
    columns: f.columns.map((c) => ({
      ...(pick(c, Object.keys(cgColumnFields.shape)) as NonNullable<
        CgTableUpdate['columns']
      >[number]),
      id: c.id,
      dictCode: c.dictCode || null,
      example: c.example || null,
    })),
  }
}

const BASIC = new Set(['className', 'featureName', 'featureNameI18n', 'note'])
/** The first problem of the config, translated, on the tab that shows the field. */
function report(issue: Parameters<typeof validationMessage>[0], f: Form) {
  const [first] = issue.path
  tab.value = first === 'columns' ? 'columns' : BASIC.has(String(first)) ? 'basic' : 'generate'
  // a row's issue: the row (a column by name, a reference by number), then its field
  const at = issue.path.findIndex((p) => typeof p === 'number')
  const index = Number(issue.path[at])
  const field = issue.path
    .slice(at + 1)
    .filter((p): p is string => typeof p === 'string' && p !== 'columns' && p !== 'options')
    .map((p) => t(`field.codegen.${p}`))
    .join(' · ')
  const { key, params } = validationMessage(issue)
  const message = t(key, { ...params, field })
  const where =
    issue.path[at - 1] === 'columns'
      ? `${t('codegen.table.edit.column')} ${f.columns[index]?.columnName}`
      : issue.path[at - 1] === 'referencedBy'
        ? `${t('field.codegen.referencedBy')} ${index + 1}`
        : undefined
  ElMessage.error(where ? t('codegen.table.edit.invalid', { where, message }) : message)
}

async function save() {
  const f = form.value
  if (!f || saving.value) return
  const dto = body(f)
  const checked = cgTableUpdate.safeParse(dto)
  if (!checked.success) return report(checked.error.issues[0]!, f)
  saving.value = true
  try {
    await codegenApi.update(id, dto)
    ElMessage.success(t('crud.msg.updated'))
    await load()
  } catch {
    // toasted by the request layer (422: identifiers, tree columns, options)
  } finally {
    saving.value = false
  }
}

function back() {
  tags.close((tag) => tag.path === route.path)
  return router.push('/codegen/tables')
}

// the preview renders the stored config: what was saved last
const canPreview = computed(() => perm.has(codegenPerms.generate))
function preview() {
  const f = form.value
  if (!f) return
  // writing is offered in the preview only where the server allows it
  void codegenApi
    .writable()
    .catch(() => ({ writable: false }))
    .then(({ writable }) =>
      openDialog(
        CodegenPreview,
        { id, tableName: f.tableName, writable },
        { title: () => t('codegen.table.preview.title', { table: f.tableName }), width: '1200px' },
      ),
    )
}

const menuProps = {
  value: 'value',
  label: (n: object) => {
    const m = n as MenuOption
    const name = localized(m.nameI18n, m.name)
    return m.reason
      ? t('codegen.table.edit.parentMenuUnpickable', {
          name,
          reason: t(`codegen.table.edit.parentMenuReason.${m.reason}`),
        })
      : name
  },
  children: 'children',
  disabled: 'disabled',
}
// the grid's dropdowns: el-select-v2 takes its options as data (plain el-selects render every option of
// every row up front, which a table of many columns feels)
const tsOptions = CG_TS_TYPES.map((value) => ({ value, label: value }))
const widgetOptions = computed(() =>
  CG_WIDGETS.map((value) => ({ value, label: t(`codegen.table.widgets.${value}`) })),
)
const opOptions = computed(() =>
  CG_QUERY_OPS.map((value) => ({ value, label: t(`codegen.table.queryOps.${value}`) })),
)
const dictOptions = computed(() =>
  dicts.value.map((d: DictOption) => ({
    value: d.code,
    label: `${localized(d.nameI18n, d.name)} (${d.code})`,
  })),
)
const LANGUAGE: Record<Locale, string> = {
  'zh-CN': 'common.language.zhCN',
  'en-US': 'common.language.enUS',
}
</script>

<template>
  <div class="qw-page codegen-edit">
    <div class="qw-page-bar">
      <el-tag v-if="form" class="qw-page-bar__context" type="info" disable-transitions>{{
        form.tableName
      }}</el-tag>
      <el-button @click="back">
        <el-icon class="el-icon--left"><Icon icon="lucide:arrow-left" /></el-icon>
        {{ t('codegen.table.edit.back') }}
      </el-button>
      <el-button v-if="canPreview" :disabled="!form" @click="preview">
        <el-icon class="el-icon--left"><Icon icon="lucide:eye" /></el-icon>
        {{ t('codegen.table.action.preview') }}
      </el-button>
      <el-button v-if="canSave" type="primary" :disabled="!form" :loading="saving" @click="save">
        <el-icon class="el-icon--left"><Icon icon="lucide:save" /></el-icon>
        {{ t('crud.action.save') }}
      </el-button>
    </div>

    <el-card v-loading="loading" class="codegen-edit__card">
      <el-tabs v-if="form" v-model="tab">
        <el-tab-pane :label="t('codegen.table.edit.basic')" name="basic">
          <el-form :model="form" label-position="top" class="codegen-edit__form">
            <el-form-item :label="t('field.codegen.tableName')">
              <el-input :model-value="form.tableName" disabled />
            </el-form-item>
            <el-form-item :label="t('field.codegen.tableComment')">
              <el-input :model-value="form.tableComment" disabled />
            </el-form-item>
            <el-form-item :label="t('field.codegen.className')">
              <el-input v-model="form.className" name="className" maxlength="64" />
            </el-form-item>
            <el-form-item :label="t('field.codegen.featureName')">
              <el-input v-model="form.featureName" name="featureName" maxlength="128" />
            </el-form-item>
            <el-form-item
              v-for="l in LOCALES"
              :key="l"
              :label="`${t('field.codegen.featureNameI18n')} · ${t(LANGUAGE[l])}`"
            >
              <el-input
                v-model="form.featureNameI18n[l]"
                :name="`featureName-${l}`"
                maxlength="128"
              />
            </el-form-item>
            <el-form-item :label="t('field.codegen.note')" class="codegen-edit__wide">
              <el-input
                v-model="form.note"
                type="textarea"
                :rows="3"
                maxlength="500"
                show-word-limit
              />
            </el-form-item>
          </el-form>
        </el-tab-pane>

        <el-tab-pane :label="t('codegen.table.edit.columns')" name="columns">
          <el-table
            :data="form.columns"
            row-key="id"
            max-height="600"
            class="codegen-edit__columns"
          >
            <el-table-column :label="t('codegen.table.edit.column')" width="180" fixed="left">
              <template #default="{ row }: { row: CgColumnVo }">
                <div class="codegen-edit__column">
                  <span :title="row.columnComment">{{ row.columnName }}</span>
                  <small>{{ row.columnType }}</small>
                </div>
              </template>
            </el-table-column>
            <el-table-column :label="t('field.codegen.fieldName')" width="160">
              <template #default="{ row }: { row: CgColumnVo }">
                <el-input
                  v-model="row.fieldName"
                  :aria-label="`${t('field.codegen.fieldName')} ${row.columnName}`"
                />
              </template>
            </el-table-column>
            <el-table-column :label="t('field.codegen.labelI18n')">
              <el-table-column v-for="l in LOCALES" :key="l" :label="t(LANGUAGE[l])" width="150">
                <template #default="{ row }: { row: Form['columns'][number] }">
                  <el-input
                    v-model="row.labelI18n[l]"
                    :aria-label="`${t('field.codegen.labelI18n')} ${t(LANGUAGE[l])} ${row.columnName}`"
                  />
                </template>
              </el-table-column>
            </el-table-column>
            <el-table-column :label="t('field.codegen.tsType')" width="120">
              <template #default="{ row }: { row: CgColumnVo }">
                <el-select-v2
                  v-model="row.tsType"
                  :options="tsOptions"
                  :aria-label="`${t('field.codegen.tsType')} ${row.columnName}`"
                />
              </template>
            </el-table-column>
            <el-table-column :label="t('field.codegen.widget')" width="160">
              <template #default="{ row }: { row: CgColumnVo }">
                <el-select-v2
                  v-model="row.widget"
                  :options="widgetOptions"
                  :aria-label="`${t('field.codegen.widget')} ${row.columnName}`"
                />
              </template>
            </el-table-column>
            <el-table-column :label="t('field.codegen.dictCode')" width="200">
              <template #default="{ row }: { row: CgColumnVo }">
                <el-select-v2
                  v-model="row.dictCode"
                  :options="dictOptions"
                  filterable
                  clearable
                  :aria-label="`${t('field.codegen.dictCode')} ${row.columnName}`"
                />
              </template>
            </el-table-column>
            <el-table-column
              v-for="flag in ['inList', 'inForm', 'inQuery'] as const"
              :key="flag"
              :label="t(`field.codegen.${flag}`)"
              width="120"
              align="center"
            >
              <template #default="{ row }: { row: CgColumnVo }">
                <el-checkbox
                  v-model="row[flag]"
                  :aria-label="`${t(`field.codegen.${flag}`)} ${row.columnName}`"
                />
              </template>
            </el-table-column>
            <el-table-column :label="t('field.codegen.queryOp')" width="130">
              <template #default="{ row }: { row: CgColumnVo }">
                <el-select-v2
                  v-model="row.queryOp"
                  :options="opOptions"
                  :disabled="!row.inQuery"
                  :aria-label="`${t('field.codegen.queryOp')} ${row.columnName}`"
                />
              </template>
            </el-table-column>
            <el-table-column
              v-for="flag in ['sortable', 'required'] as const"
              :key="flag"
              :label="t(`field.codegen.${flag}`)"
              width="100"
              align="center"
            >
              <template #default="{ row }: { row: CgColumnVo }">
                <el-checkbox
                  v-model="row[flag]"
                  :aria-label="`${t(`field.codegen.${flag}`)} ${row.columnName}`"
                />
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane :label="t('codegen.table.edit.generate')" name="generate">
          <el-form :model="form" label-position="top" class="codegen-edit__form">
            <el-form-item :label="t('field.codegen.template')">
              <el-radio-group v-model="form.template" @change="onTemplate(String($event))">
                <el-radio-button v-for="tp in CG_TEMPLATES" :key="tp" :value="tp">
                  {{ t(`codegen.table.templates.${tp}`) }}
                </el-radio-button>
              </el-radio-group>
            </el-form-item>
            <template v-if="isTree">
              <el-form-item :label="t('field.codegen.treeParentCol')">
                <el-select v-model="form.treeParentCol" name="treeParentCol" clearable>
                  <el-option v-for="c in columnNames" :key="c" :value="c" :label="c" />
                </el-select>
              </el-form-item>
              <el-form-item :label="t('field.codegen.treeLabelCol')">
                <el-select v-model="form.treeLabelCol" name="treeLabelCol" clearable>
                  <el-option v-for="c in columnNames" :key="c" :value="c" :label="c" />
                </el-select>
              </el-form-item>
              <el-alert
                :title="t('codegen.table.edit.treeIgnores')"
                type="info"
                :closable="false"
                show-icon
              />
            </template>
            <el-alert
              v-else-if="form.template === 'master_sub'"
              :title="t('codegen.table.edit.masterSubHint')"
              type="info"
              :closable="false"
              show-icon
            />
            <template v-else>
              <el-form-item :label="t('field.codegen.masterTableId')">
                <el-select
                  :model-value="form.masterTableId ?? undefined"
                  name="masterTableId"
                  :placeholder="t('codegen.table.edit.masterNone')"
                  clearable
                  @update:model-value="onMaster"
                >
                  <el-option v-for="m in masters" :key="m.id" :value="m.id" :label="m.tableName" />
                </el-select>
              </el-form-item>
              <el-form-item v-if="form.masterTableId != null" :label="t('field.codegen.subFkCol')">
                <el-select v-model="form.subFkCol" name="subFkCol">
                  <el-option v-for="c in fkColumns" :key="c" :value="c" :label="c" />
                </el-select>
              </el-form-item>
            </template>

            <el-divider content-position="left">{{ t('codegen.table.edit.options') }}</el-divider>
            <el-form-item :label="t('field.codegen.groupCode')">
              <el-select v-model="form.groupCode" name="groupCode">
                <el-option v-for="g in CG_GROUPS" :key="g" :value="g" :label="g" />
              </el-select>
            </el-form-item>
            <el-form-item :label="t('field.codegen.domain')">
              <el-input
                :model-value="form.domain"
                name="domain"
                maxlength="32"
                @update:model-value="rename({ domain: $event })"
              />
            </el-form-item>
            <el-form-item :label="t('field.codegen.business')">
              <el-input
                :model-value="form.business"
                name="business"
                maxlength="64"
                @update:model-value="rename({ business: $event })"
              />
            </el-form-item>
            <el-form-item :label="t('field.codegen.formCols')">
              <el-radio-group v-model="form.formCols">
                <el-radio-button v-for="n in [1, 2, 3]" :key="n" :value="n">{{
                  n
                }}</el-radio-button>
              </el-radio-group>
            </el-form-item>
            <template v-if="!isTree">
              <el-form-item :label="t('field.codegen.withDetailView')">
                <el-switch v-model="form.withDetailView" />
              </el-form-item>
              <el-form-item :label="t('field.codegen.readonly')">
                <el-switch v-model="form.readonly" />
              </el-form-item>
              <el-form-item :label="t('field.codegen.withExport')">
                <el-switch v-model="form.options!.withExport" />
              </el-form-item>
              <el-form-item v-if="!form.readonly" :label="t('field.codegen.withImport')">
                <el-switch v-model="form.options!.withImport" />
              </el-form-item>
              <el-form-item :label="t('field.codegen.withOptions')">
                <el-switch v-model="form.options!.withOptions" />
              </el-form-item>
            </template>
            <!-- the uni-app pages too; a sub table's own config renders none (its master's page edits it) -->
            <el-form-item v-if="form.masterTableId == null" :label="t('field.codegen.withMobile')">
              <el-switch v-model="form.options!.withMobile" />
            </el-form-item>
            <el-form-item v-if="hasDeptId" :label="t('codegen.table.edit.dataScope')">
              <!-- unset = on for a table with dept_id -->
              <el-switch
                :model-value="form.options!.dataScope ?? true"
                @update:model-value="form.options!.dataScope = Boolean($event)"
              />
            </el-form-item>
            <el-alert
              :title="t('codegen.table.edit.referencedByHint')"
              type="info"
              :closable="false"
              show-icon
            />
            <QwEditTable
              v-model="form.options.referencedBy"
              label="field.codegen.referencedBy"
              :columns="REF_COLUMNS"
              :create="newRef"
            >
              <template #cell-table="{ row, index }">
                <el-select
                  :model-value="row.table"
                  filterable
                  allow-create
                  default-first-option
                  :aria-label="`${t('field.codegen.table')} ${index + 1}`"
                  @update:model-value="onRefTable(row, $event)"
                >
                  <el-option
                    v-for="[name, comment] in refTables"
                    :key="name"
                    :value="name"
                    :label="name"
                    class="codegen-edit__option"
                  >
                    {{ name }}<small>{{ comment }}</small>
                  </el-option>
                </el-select>
              </template>
              <template #cell-column="{ row, index }">
                <el-select
                  v-model="row.column"
                  filterable
                  allow-create
                  default-first-option
                  :aria-label="`${t('field.codegen.column')} ${index + 1}`"
                  @visible-change="$event && loadRefColumns(row.table)"
                >
                  <el-option
                    v-for="c in refColumns.get(row.table ?? '') ?? []"
                    :key="c"
                    :value="c"
                    :label="c"
                  />
                </el-select>
              </template>
              <template #cell-label="{ row, index }">
                <el-input
                  v-model="row.label"
                  maxlength="64"
                  :aria-label="`${t('field.codegen.label')} ${index + 1}`"
                />
              </template>
            </QwEditTable>

            <el-divider content-position="left">{{ t('codegen.table.edit.menu') }}</el-divider>
            <el-form-item :label="t('field.codegen.parentMenuRouteName')">
              <el-tree-select
                v-model="form.parentMenuRouteName"
                :data="parentMenus"
                node-key="value"
                :props="menuProps"
                :placeholder="t('codegen.table.edit.parentMenuHint')"
                check-strictly
                default-expand-all
                @visible-change="(open: boolean) => open && loadParentMenus()"
              />
            </el-form-item>
            <el-form-item :label="t('field.codegen.menuIcon')">
              <IconPicker v-model="form.options!.menuIcon" />
            </el-form-item>
            <el-form-item :label="t('field.codegen.menuSortNo')">
              <el-input-number
                v-model="form.options!.menuSortNo"
                :min="0"
                :max="999999"
                controls-position="right"
              />
            </el-form-item>

            <el-divider content-position="left">{{ t('codegen.table.edit.texts') }}</el-divider>
            <el-form-item
              v-for="l in LOCALES"
              :key="`entity-${l}`"
              :label="`${t('field.codegen.entityI18n')} · ${t(LANGUAGE[l])}`"
            >
              <el-input v-model="form.options!.entityI18n![l]" maxlength="64" />
            </el-form-item>
          </el-form>
        </el-tab-pane>
      </el-tabs>
    </el-card>
  </div>
</template>

<style scoped>
.codegen-edit__card {
  min-height: 240px;
}
/* two fields a row; sections, notes and hints take the whole row */
.codegen-edit__form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 24px;
  max-width: 880px;
  padding-top: 8px;
}
.codegen-edit__form > .el-divider,
.codegen-edit__form > .el-alert,
.codegen-edit__wide {
  grid-column: 1 / -1;
}
.codegen-edit__form > .el-alert {
  margin-bottom: 18px;
}
.codegen-edit__column {
  display: grid;
  line-height: 18px;
}
.codegen-edit__column span {
  font-weight: 600;
  color: var(--qw-text);
}
.codegen-edit__column small {
  font-size: 12px;
  color: var(--qw-text-3);
}
.codegen-edit__option small {
  margin-left: 8px;
  font-size: 12px;
  color: var(--qw-text-3);
}
</style>
