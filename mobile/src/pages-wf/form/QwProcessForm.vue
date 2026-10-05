<template>
  <view class="qw-pf">
    <template v-for="v in views" :key="v.field">
      <!-- read-only: a row of its text (a detail table: its rows) -->
      <view v-if="!v.edit && v.widget !== 'table'" :class="`qw-kv qw-pf__kv qw-pf__kv--${v.field}`">
        <text class="qw-kv__k">{{ v.title }}</text>
        <view class="qw-kv__v">
          <text class="qw-pf__text">{{ shownText(v) }}</text>
          <text v-if="v.unsupported" class="qw-form__hint">
            {{ t('approval.dynamic.desktopField') }}
          </text>
          <text v-if="errors[v.field]" class="qw-field__error">{{ errors[v.field] }}</text>
        </view>
      </view>
      <view v-else :class="`qw-field qw-pf__field qw-pf__field--${v.field}`">
        <text v-if="!CELLS.has(v.widget)" class="qw-field__label" :class="{ 'is-required': v.required }">
          {{ v.title }}
        </text>
        <wd-input
          v-if="v.widget === 'input'"
          :model-value="str(v)"
          :maxlength="v.props.maxlength ?? FORM_TEXT_MAX"
          :placeholder="v.placeholder"
          @update:model-value="set(v.field, $event)"
        />
        <wd-textarea
          v-else-if="v.widget === 'textarea'"
          :model-value="str(v)"
          :maxlength="v.props.maxlength ?? FORM_TEXT_MAX"
          :placeholder="v.placeholder"
          @update:model-value="set(v.field, $event)"
        />
        <wd-input
          v-else-if="v.widget === 'number'"
          type="digit"
          :model-value="numText(v)"
          :placeholder="v.placeholder"
          @update:model-value="setNumber(v, $event)"
        />
        <wd-cell
          v-else-if="PICKED.has(v.widget)"
          :title="v.title"
          :value="shownText(v)"
          :placeholder="v.placeholder || t('picker.select')"
          :required="v.required"
          is-link
          @click="pick(v)"
        />
        <wd-cell v-else-if="v.widget === 'switch'" :title="v.title" :required="v.required" center>
          <wd-switch
            :model-value="model[v.field] ?? v.props.inactiveValue ?? false"
            :active-value="v.props.activeValue ?? true"
            :inactive-value="v.props.inactiveValue ?? false"
            @update:model-value="set(v.field, $event)"
          />
        </wd-cell>
        <wd-rate
          v-else-if="v.widget === 'rate'"
          :model-value="num(v) ?? 0"
          :num="v.props.max ?? 5"
          :allow-half="!!v.props.allowHalf"
          @update:model-value="set(v.field, $event)"
        />
        <wd-slider
          v-else-if="v.widget === 'slider'"
          :model-value="sliderValue(v)"
          :min="v.props.min ?? 0"
          :max="v.props.max ?? 100"
          :step="v.props.step ?? 1"
          :range="!!v.props.range"
          @update:model-value="set(v.field, $event)"
        />
        <QwUserPicker
          v-else-if="v.widget === 'user'"
          :model-value="userPicked(v)"
          :label="v.title"
          :placeholder="v.placeholder"
          :required="v.required"
          @update:model-value="pickUser(v, $event)"
        />
        <QwDeptPicker
          v-else-if="v.widget === 'dept'"
          source="wf"
          :model-value="num(v)"
          :label="v.title"
          :placeholder="v.placeholder"
          :required="v.required"
          @update:model-value="set(v.field, $event)"
        />
        <QwDictSelect
          v-else-if="v.widget === 'dict'"
          :code="v.props.code ?? ''"
          :multiple="!!v.props.multiple"
          :model-value="codes(v)"
          :label="v.title"
          :placeholder="v.placeholder"
          :required="v.required"
          @update:model-value="set(v.field, $event)"
        />
        <QwUpload
          v-else-if="v.widget === 'upload'"
          biz-tag="wf.attachment"
          :limit="v.props.limit ?? 10"
          :max-size="v.props.maxSize ? v.props.maxSize * MB : undefined"
          :model-value="uploadObjects(model[v.field])"
          @update:model-value="set(v.field, uploadValue($event))"
        />
        <QwDetailRows
          v-else-if="v.widget === 'table'"
          :model-value="str(v) || null"
          :columns="v.props.columns ?? []"
          :labels="labels(v)"
          :disabled="!v.edit"
          @update:model-value="set(v.field, $event)"
        />
        <text v-if="v.info" class="qw-form__hint">{{ v.info }}</text>
        <text v-if="errors[v.field]" class="qw-field__error">{{ errors[v.field] }}</text>
      </view>
    </template>
    <!-- one picker of each kind, for the field being picked -->
    <wd-datetime-picker
      :model-value="dateValue"
      :visible="open === 'date'"
      :type="picking?.date?.picker ?? 'date'"
      :title="picking?.title ?? ''"
      root-portal
      @confirm="pickDate"
      @update:visible="closed"
    />
    <wd-select-picker
      :model-value="choiceValue"
      :visible="open === 'choice'"
      :columns="choiceColumns"
      :type="multiple ? 'checkbox' : 'radio'"
      :show-confirm="multiple"
      :max="multiple ? (picking?.props.multipleLimit ?? picking?.props.max ?? 0) : 0"
      :title="picking?.title ?? ''"
      root-portal
      @update:model-value="pickChoice"
      @update:visible="closed"
    />
    <wd-cascader
      :model-value="cascadeValue"
      :visible="open === 'cascade'"
      :options="cascadeOptions"
      :check-strictly="!!picking?.props.props?.checkStrictly"
      :title="picking?.title ?? ''"
      root-portal
      @confirm="pickCascade"
      @update:visible="closed"
    />
  </view>
</template>

<script setup lang="ts">
import { computed, reactive, ref, shallowRef, watch } from 'vue'
import {
  FORM_TEXT_MAX,
  type DeptTreeNode,
  type DictPayload,
  type FormOptionItem,
  type FormSchema,
  type GeoAreaNode,
  type WfFieldAccess,
  type WfUserOption,
} from '@qiwu/shared'
import QwDeptPicker from '@/core/components/QwDeptPicker.vue'
import QwDictSelect from '@/core/components/QwDictSelect.vue'
import QwUpload from '@/core/components/QwUpload.vue'
import QwUserPicker from '@/core/components/QwUserPicker.vue'
import { t } from '@/core/i18n'
import { loadDepts, loadDict, type PickedUser } from '@/core/pickers'
import { api } from '@/core/request'
import QwDetailRows from './QwDetailRows.vue'
import {
  fieldText,
  fieldViews,
  formText,
  numberInput,
  pickedValue,
  pickerValue,
  shownValues,
  uploadObjects,
  uploadValue,
  type FieldView,
  type Widget,
} from './process-form'

/**
 * A dynamic process form (no form-create on the phone, mp-weixin has no dynamic
 * components; see docs/design-notes.md#workflow): each field of `process-form.ts`'s views through one `v-if` chain, an input when editable
 * (the start page: all; the detail: the reader's `edit` ones), else a row of its text. One date, one choice
 * and one cascade picker serve the field being picked. `v-model` = the values (replaced, never mutated);
 * `errors`: field → message. Texts render as text only (titles and options come from the designer). The
 * names of read-only users, depts, areas and dict entries load once per form as needed.
 */
defineOptions({ options: { virtualHost: true } })
const model = defineModel<Record<string, unknown>>({ required: true })
const props = withDefaults(
  defineProps<{ form: FormSchema; access?: WfFieldAccess; errors?: Record<string, string> }>(),
  { access: undefined, errors: () => ({}) },
)

const MB = 1024 * 1024
/** drawn as a cell with the title in it */
const CELLS = new Set<Widget>(['choice', 'date', 'cascader', 'area', 'switch', 'user', 'dept', 'dict'])
/** a cell opening one of the shared pickers */
const PICKED = new Set<Widget>(['choice', 'date', 'cascader', 'area'])

// formText reads the locale: titles follow a switch
const text = computed(() => formText(props.form))
const views = computed(() => fieldViews(props.form, props.access, text.value))
const shown = computed(() => shownValues(props.form, model.value))

const look = reactive({
  users: new Map<number, string>(),
  depts: [] as DeptTreeNode[],
  areas: [] as FormOptionItem[],
  dicts: new Map<string, DictPayload>(),
})
const areaOptions = (nodes: GeoAreaNode[]): FormOptionItem[] =>
  nodes.map((n) => ({ value: n.code, label: n.name, children: n.children && areaOptions(n.children) }))
/** numbers as typed ("1." while typing), by field */
const typed = reactive<Record<string, string>>({})
const ignore = () => {} // shown by the request layer: ids / codes show instead
watch(
  () => props.form,
  (form) => {
    for (const k of Object.keys(typed)) delete typed[k]
    const has = (type: string) => form.rule.some((r) => r.type === type)
    for (const r of form.rule)
      if (r.type === 'qw-dict-select' && r.props?.code) {
        const code = r.props.code
        loadDict(code).then((d) => look.dicts.set(code, d), ignore)
      }
    if (has('qw-dept-select')) loadDepts('wf').then((d) => (look.depts = d), ignore)
    if (has('qw-area-select'))
      api.get<GeoAreaNode[]>('/geo/areas/tree').then((d) => (look.areas = areaOptions(d)), ignore)
    // Names of the first page of users only (as the web's detail); others show as #id
    if (form.rule.some((r) => r.type === 'qw-user-select' && model.value[r.field] != null))
      api
        .get<WfUserOption[]>('/wf/users/options')
        .then((list) => list.forEach((u) => look.users.set(u.id, u.displayName)), ignore)
  },
  { immediate: true },
)

const shownText = (v: FieldView) => fieldText(v, shown.value[v.field], look, text.value)
const str = (v: FieldView) => {
  const x = model.value[v.field]
  return typeof x === 'string' ? x : ''
}
const num = (v: FieldView) => {
  const x = model.value[v.field]
  return typeof x === 'number' ? x : null
}
const codes = (v: FieldView) => {
  const x = model.value[v.field]
  return typeof x === 'string' || Array.isArray(x) ? (x as string | string[]) : null
}

function set(field: string, value: unknown) {
  const next = { ...model.value }
  if (value === undefined) delete next[field]
  else next[field] = value
  model.value = next
}
const sliderValue = (v: FieldView) => {
  const x = model.value[v.field]
  const { min = 0, max = 100, range } = v.props
  return typeof x === 'number' || Array.isArray(x) ? x : range ? [min, max] : min
}
const labels = (v: FieldView) => (v.props.columns ?? []).map((c) => text.value(c.label) || c.prop)
const numText = (v: FieldView) => typed[v.field] ?? (num(v) === null ? str(v) : String(num(v)))
/** A number; blank → null, which clears the stored value; invalid text stays for the pre-check. */
function setNumber(v: FieldView, s: string) {
  typed[v.field] = s
  set(v.field, numberInput(s))
}

const userPicked = (v: FieldView): PickedUser[] => {
  const id = num(v)
  return id === null ? [] : [{ id, displayName: look.users.get(id) ?? `#${id}`, deptName: null }]
}
function pickUser(v: FieldView, list: PickedUser[]) {
  const u = list[0]
  if (u) look.users.set(u.id, u.displayName)
  set(v.field, u ? u.id : null)
}

// ---- the shared pickers ----
const picking = shallowRef<FieldView>()
const open = ref<'' | 'date' | 'choice' | 'cascade'>('')
function pick(v: FieldView) {
  picking.value = v
  open.value = v.widget === 'date' ? 'date' : v.widget === 'choice' ? 'choice' : 'cascade'
}
const closed = (visible: boolean) => visible || (open.value = '')
const at = () => (picking.value ? model.value[picking.value.field] : undefined)

const dateValue = computed(() =>
  picking.value?.date ? pickerValue(picking.value.date, at()) : Date.now(),
)
const pickDate = ({ value }: { value: number | string | (number | string)[] }) =>
  picking.value?.date && set(picking.value.field, pickedValue(picking.value.date, value))

// choices by their index (an option value may be a number or boolean)
const multiple = computed(
  () => picking.value?.rule.type === 'checkbox' || !!picking.value?.props.multiple,
)
const choiceColumns = computed(() =>
  (picking.value?.options ?? []).map((o, i) => ({
    value: i,
    label: text.value(o.label),
    disabled: o.disabled,
  })),
)
const choiceValue = computed(() => {
  const opts = picking.value?.options ?? []
  const index = (x: unknown) => opts.findIndex((o) => o.value === x)
  if (multiple.value) return [at() ?? []].flat().map(index).filter((i) => i >= 0)
  const i = index(at())
  return i < 0 ? '' : i
})
function pickChoice(i: number | '' | number[]) {
  const v = picking.value
  if (!v) return
  const value = (n: number) => v.options[n]!.value
  if (Array.isArray(i)) set(v.field, i.length ? i.map(value) : null)
  else set(v.field, i === '' ? null : value(i))
}

type Cascade = { value: unknown; text: string; disabled?: boolean; children?: Cascade[] }
const cascade = (opts: readonly FormOptionItem[]): Cascade[] =>
  opts.map((o) => ({
    value: o.value,
    text: text.value(o.label),
    disabled: o.disabled,
    children: o.children?.length ? cascade(o.children) : undefined,
  }))
const cascadeOptions = computed(() =>
  !picking.value ? [] : cascade(picking.value.widget === 'area' ? look.areas : picking.value.options),
)
/** wd-cascader takes the leaf's value */
const cascadeValue = computed(() => {
  const leaf = [at() ?? []].flat().pop()
  return typeof leaf === 'string' || typeof leaf === 'number' ? leaf : ''
})
function pickCascade({ selectedOptions }: { selectedOptions: Cascade[] }) {
  const v = picking.value
  if (!v) return
  const path = selectedOptions.map((o) => o.value)
  const leafOnly = v.widget === 'cascader' && v.props.props?.emitPath === false
  set(v.field, !path.length ? null : leafOnly ? path[path.length - 1] : path)
}
</script>

<style scoped>
.qw-pf {
  display: flex;
  flex-direction: column;
  gap: var(--qw-space-3);
}

.qw-pf__text {
  white-space: pre-line;
}
</style>
