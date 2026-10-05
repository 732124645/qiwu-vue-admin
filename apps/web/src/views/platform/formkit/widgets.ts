import {
  computed,
  defineComponent,
  getCurrentInstance,
  h,
  onBeforeUnmount,
  ref,
  watch,
  type Component,
  type PropType,
} from 'vue'
import { ElButton, ElInput, ElInputNumber, ElTable, ElTableColumn } from 'element-plus'
import formCreate from '@form-create/element-ui'
import registerElementPlus from '@form-create/element-ui/auto-import'
import {
  DETAIL_NUMBER_MAX,
  DETAIL_ROWS_MAX,
  DETAIL_TEXT_MAX,
  detailRows,
  detailTotals,
  rangeDays,
  type DetailColumn,
  type FormComponentType,
  type FsObjectVo,
} from '@qiwu/shared'
import AreaCascader from '@/core/components/AreaCascader.vue'
import DeptTreeSelect from '@/core/components/DeptTreeSelect.vue'
import DictSelect from '@/core/components/DictSelect.vue'
import FileUpload from '@/core/components/FileUpload.vue'
import UserSelect from '@/core/components/UserSelect.vue'
import { fileRef, fromFileRef } from '@/core/composables/use-upload'
import { i18n } from '@/core/i18n'

/**
 * Our form-create components (see docs/design-notes.md#workflow): the `qw-*` rule types `sanitizeFormSchema` allows,
 * each the existing picker. Registered here on form-create itself, so every renderer has them: the
 * designer's preview, and the process forms that import this module for its `formCreate`. FormDesigner adds
 * them to the designer's canvas and component list. Values: user / dept = the id, dict = the entry code(s),
 * area = the code path, upload = a `<id>/<file name>` line per file ({@link fileRef}). The calc components
 * show what `@qiwu/shared` form-calc gives; the server recomputes the same on start and
 * every edit.
 */

/** form-create hands every component `formCreateInject` (its api and rule): taken here, off the DOM. */
const inject = { formCreateInject: Object }

/** `attrs` (v-model, the rule's whitelisted props) on to `picker`, with `fixed` props on top. */
const wrap = (name: string, picker: Component, fixed: Record<string, unknown> = {}) =>
  defineComponent({
    name,
    inheritAttrs: false,
    props: inject,
    setup:
      (_, { attrs }) =>
      () =>
        h(picker, { ...attrs, ...fixed }),
  })

const MB = 1024 * 1024

/**
 * FileUpload over {@link fileRef}s, one per line (`storageRefs`, what the server binds on start): no URL and
 * no other field of the stored object reaches the form data, so a value someone else typed cannot become a
 * link. Private `wf.attachment` objects, bound to their process instance on start; `maxSize` in MB.
 */
const QwUpload = defineComponent({
  name: 'QwUpload',
  inheritAttrs: false,
  props: { ...inject, modelValue: null, maxSize: Number },
  emits: ['update:modelValue'],
  setup(props, { attrs, emit }) {
    // cached: FileUpload removes a file by identity; a line of another shape, or a value that is not a
    // string (someone else sent it), shows nothing rather than breaking the form
    const files = computed(() =>
      (typeof props.modelValue === 'string' && props.modelValue ? props.modelValue.split('\n') : [])
        .map(fromFileRef)
        .filter((o): o is FsObjectVo => o !== null),
    )
    return () =>
      h(FileUpload, {
        ...attrs,
        bizTag: 'wf.attachment',
        maxSize: props.maxSize ? props.maxSize * MB : undefined,
        modelValue: files.value,
        'onUpdate:modelValue': (list: FsObjectVo[]) =>
          emit('update:modelValue', list.map(fileRef).join('\n')),
      })
  },
})

const t = (key: string, params: Record<string, unknown> = {}) => i18n.global.t(key, params)
/**
 * form-create's api as the calc components read it: the form's values (those it was given, a rule's field
 * once it has one), its change events and its texts (`t`: the schema's `option.language` in the form's locale)
 */
type FcApi = {
  form?: Record<string, unknown>
  on?: (event: 'change', fn: () => void) => void
  off?: (event: 'change', fn: () => void) => void
  t?: (id: string) => string
}
type FcInject = { api?: FcApi } | undefined
/** a form-create language text, `{{$t.<id>}}` (as it reads a rule's title; the id as wf-data.service.ts) */
const LANGUAGE_TEXT = /^\{\{\s*\$t\.([A-Za-z][\w-]*)\s*\}\}$/

/**
 * `qw-date-range-days`: the days between two date fields of the form (`rangeDays`), read-only, as its value.
 * Disabled (a reader's `read` field), or its dates not in the form (hidden from the reader): the days as given
 * (the server's), never changed here.
 */
const QwDateRangeDays = defineComponent({
  name: 'QwDateRangeDays',
  inheritAttrs: false,
  props: {
    ...inject,
    modelValue: Number,
    disabled: Boolean,
    startField: String,
    endField: String,
    startHalfField: String,
    endHalfField: String,
  },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    // the form's values are reactive only when the page's rules are (a page holding its schema in a
    // shallowRef passes plain ones, and form-create swaps its value object on reload): its change
    // events say when to read them again
    const api = (props.formCreateInject as FcInject)?.api
    const changed = ref(0)
    const bump = () => changed.value++
    api?.on?.('change', bump)
    onBeforeUnmount(() => api?.off?.('change', bump))
    /** the days its dates give; undefined: not its to compute */
    const days = computed(() => {
      void changed.value
      const form = api?.form ?? {}
      const own = (f?: string): f is string => !!f && Object.hasOwn(form, f)
      const at = (f?: string) => (own(f) ? form[f] : undefined)
      const { startField, endField, startHalfField, endHalfField } = props
      if (props.disabled || !own(startField) || !own(endField)) return undefined
      return rangeDays(at(startField), at(endField), at(startHalfField), at(endHalfField))
    })
    // the value follows the days, and a value set otherwise (typed into the rule, sent) is put back
    watch(
      [days, () => props.modelValue],
      ([d, v]) => {
        if (d !== undefined && d !== (v ?? null)) emit('update:modelValue', d)
      },
      { immediate: true },
    )
    const shown = computed(() => (days.value === undefined ? props.modelValue : days.value))
    return () =>
      h(
        ElInput,
        { modelValue: shown.value == null ? '' : String(shown.value), readonly: true },
        { append: () => t('formkit.widget.days.unit') },
      )
  },
})

type Cell = string | number | null | undefined
/**
 * `qw-detail-table`: rows over the rule's columns (a number cell where the column names a `sum` field), its
 * value the rows as JSON text; the summary line shows the totals of the rows, disabled the ones the server
 * stored in the `sum` fields when the form has them. A column label `{{$t.<id>}}` is a text of the form's
 * `option.language`. Each cell and row button is named by its column and row (screen readers).
 */
const QwDetailTable = defineComponent({
  name: 'QwDetailTable',
  inheritAttrs: false,
  props: {
    ...inject,
    modelValue: String,
    columns: { type: Array as PropType<DetailColumn[]>, default: () => [] },
    disabled: Boolean,
  },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    const api = (props.formCreateInject as FcInject)?.api
    const label = (c: DetailColumn) => {
      const id = LANGUAGE_TEXT.exec(c.label ?? '')?.[1]
      return (id === undefined ? c.label : api?.t?.(id)) || c.prop
    }
    // what is being edited: a new, still empty row stays here (the server drops it)
    const rows = ref<Record<string, Cell>[]>([])
    let sent: string | null | undefined
    watch(
      () => props.modelValue,
      (v) => {
        if (v !== sent) rows.value = detailRows(v, props.columns)
      },
      { immediate: true },
    )
    const send = () => {
      sent = rows.value.length ? JSON.stringify(rows.value) : null
      emit('update:modelValue', sent)
    }
    const totals = computed(() =>
      detailTotals(detailRows(rows.value, props.columns), props.columns),
    )
    /** a total as the server stored it (read-only), else the rows' */
    const total = (sum: string) => {
      const stored = props.disabled ? api?.form?.[sum] : undefined
      return String(typeof stored === 'number' ? stored : totals.value[sum])
    }
    const summary = () =>
      props.columns.map((c, i) =>
        c.sum !== undefined ? total(c.sum) : i === 0 ? t('formkit.widget.detail.total') : '',
      )
    const set = (row: Record<string, Cell>, prop: string, v: Cell) => {
      row[prop] = v
      send()
    }
    const cell = (row: Record<string, Cell>, i: number, c: DetailColumn) => {
      const v = row[c.prop]
      if (props.disabled) return String(v ?? '')
      const own = {
        ariaLabel: t('formkit.widget.detail.cell', { label: label(c), row: i + 1 }),
        'onUpdate:modelValue': (n: Cell) => set(row, c.prop, n),
      }
      return c.sum !== undefined
        ? h(ElInputNumber, {
            modelValue: typeof v === 'number' ? v : undefined,
            controls: false,
            min: -DETAIL_NUMBER_MAX,
            max: DETAIL_NUMBER_MAX,
            ...own,
          })
        : h(ElInput, { modelValue: v ?? '', maxlength: DETAIL_TEXT_MAX, ...own })
    }
    const remove = (i: number) => {
      rows.value.splice(i, 1)
      send()
    }
    return () =>
      h('div', { class: 'qw-detail-table', style: { width: '100%' } }, [
        h(
          ElTable,
          {
            data: rows.value,
            border: true,
            showSummary: props.columns.some((c) => c.sum !== undefined),
            summaryMethod: summary,
          },
          () => [
            ...props.columns.map((c) =>
              h(
                ElTableColumn,
                { label: label(c), minWidth: 120 },
                {
                  default: ({ row, $index }: { row: Record<string, Cell>; $index: number }) =>
                    cell(row, $index, c),
                },
              ),
            ),
            props.disabled
              ? null
              : h(
                  ElTableColumn,
                  { width: 64, align: 'center' },
                  {
                    default: ({ $index }: { $index: number }) =>
                      h(
                        ElButton,
                        {
                          link: true,
                          type: 'danger',
                          'aria-label': t('formkit.widget.detail.removeRow', { row: $index + 1 }),
                          onClick: () => remove($index),
                        },
                        () => t('formkit.widget.detail.remove'),
                      ),
                  },
                ),
          ],
        ),
        props.disabled || rows.value.length >= DETAIL_ROWS_MAX
          ? null
          : h(ElButton, { link: true, type: 'primary', onClick: () => rows.value.push({}) }, () =>
              t('formkit.widget.detail.add'),
            ),
      ])
  },
})

export type QwWidget = Extract<FormComponentType, `qw-${string}`>
export const QW_WIDGETS: Record<QwWidget, Component> = {
  // anyone fills a process form: the picker lists every enabled user (GET /api/wf/users/options)
  'qw-user-select': wrap('QwUserSelect', UserSelect, { source: 'wf' }),
  // the dept picker: every enabled department (GET /api/wf/depts/options), the names a reader sees too
  'qw-dept-select': wrap('QwDeptSelect', DeptTreeSelect, { source: 'wf' }),
  'qw-dict-select': wrap('QwDictSelect', DictSelect),
  'qw-upload': QwUpload,
  'qw-area-select': wrap('QwAreaSelect', AreaCascader),
  'qw-date-range-days': QwDateRangeDays,
  'qw-detail-table': QwDetailTable,
}

// Element Plus components by name, then ours
formCreate.use(registerElementPlus)
for (const [type, widget] of Object.entries(QW_WIDGETS)) formCreate.component(type, widget)

/**
 * form-create as a plugin (the global `<form-create>`, its props on every component) on the app of the
 * calling component's setup, once: a second `app.use` (the next mount) only warns in dev.
 */
export function installFormCreate() {
  const app = getCurrentInstance()!.appContext.app
  if (!app.config.globalProperties.$formCreate) app.use(formCreate)
}

export default formCreate
