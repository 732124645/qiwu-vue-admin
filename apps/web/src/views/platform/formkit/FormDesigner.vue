<script lang="ts">
import { shallowRef } from 'vue'
import FcDesigner from '@form-create/designer'
import type { DragRule } from '@form-create/designer'
import builtIn from '@form-create/designer/src/config/index.js'
import { sanitizeFormSchema, type DictOption } from '@qiwu/shared'
import { i18n, localized } from '@/core/i18n'
import { QW_WIDGETS, installFormCreate, type QwWidget } from './widgets'

const tr = (key: string) => i18n.global.t(key)

/**
 * The designer's own components whose new rule the whitelist refuses (see docs/design-notes.md#workflow, #security): a type it does not
 * know (layouts, sub-forms, text, colour, tree, transfer, signature, rich text, raw html …) or a setting it
 * forbids (the upload's `$FNX` onSuccess, which would also render through `new Function`: qw-upload is the
 * upload). Not offered; their groups (sub-form, aide, layout) hold nothing else, so those go too. Read
 * before our own are added below (formkit-items.spec.ts).
 */
export const REFUSED_ITEMS = builtIn
  .filter((d) => d.menu && !sanitizeFormSchema({ rule: [d.rule({ t: (k: string) => k })] }).ok)
  .map((d) => d.name)
export const HIDDEN_MENUS = ['subform', 'aide', 'layout']

/** the dicts a `qw-dict-select` can show, loaded when a designer mounts */
const dicts = shallowRef<DictOption[]>([])

type Prop = { type: string; field: string; title?: string; [k: string]: unknown }
const prop = (type: string, field: string, extra: Record<string, unknown> = {}): Prop => ({
  type,
  field,
  ...extra,
})
// the props each component offers: the ones sanitizeFormSchema keeps for its type (see docs/design-notes.md#workflow)
const disabled = prop('switch', 'disabled')
const placeholder = prop('input', 'placeholder')
const WIDGET_PROPS: Record<QwWidget, { icon: string; menu?: 'qwCalc'; props: () => Prop[] }> = {
  'qw-user-select': { icon: 'icon-person', props: () => [disabled] },
  'qw-dept-select': { icon: 'icon-branch', props: () => [disabled, placeholder] },
  'qw-dict-select': {
    icon: 'icon-data-select',
    props: () => [
      prop('select', 'code', {
        props: { filterable: true },
        options: dicts.value.map((d) => ({
          value: d.code,
          label: `${localized(d.nameI18n, d.name)} (${d.code})`,
        })),
      }),
      prop('switch', 'multiple'),
      disabled,
      placeholder,
    ],
  },
  'qw-upload': {
    icon: 'icon-import-file',
    props: () => [
      prop('inputNumber', 'limit', { props: { min: 1, max: 50, precision: 0 } }),
      prop('inputNumber', 'maxSize', { props: { min: 1, precision: 0 } }),
      prop('input', 'accept'),
      disabled,
    ],
  },
  'qw-area-select': {
    icon: 'icon-address',
    props: () => [disabled, prop('switch', 'clearable'), placeholder],
  },
  // the calc components: they name other fields of the form; sanitizeFormSchema checks the names
  'qw-date-range-days': {
    icon: 'icon-date-range',
    menu: 'qwCalc',
    props: () =>
      ['startField', 'endField', 'startHalfField', 'endHalfField'].map((f) => prop('input', f)),
  },
  'qw-detail-table': {
    icon: 'icon-data-table',
    menu: 'qwCalc',
    props: () => [
      // the designer's own row editor: a row is kept once its required cells are filled
      prop('TableOptions', 'columns', {
        props: {
          column: [
            { label: tr('formkit.widget.prop.column.prop'), key: 'prop' },
            { label: tr('formkit.widget.prop.column.label'), key: 'label', required: false },
            { label: tr('formkit.widget.prop.column.sum'), key: 'sum', required: false },
          ],
        },
      }),
      disabled,
    ],
  },
}
const WIDGETS = Object.keys(WIDGET_PROPS) as QwWidget[]

// our own groups in the component list (their titles and the items' names: the designer locale below)
FcDesigner.addMenu({ name: 'qw', title: 'qw', list: [] })
FcDesigner.addMenu({ name: 'qwCalc', title: 'qwCalc', list: [] })
FcDesigner.addDragRule(
  WIDGETS.map((name): DragRule => ({
    menu: WIDGET_PROPS[name].menu ?? 'qw',
    name,
    label: name,
    icon: WIDGET_PROPS[name].icon,
    input: true,
    validate: 'required',
    languageKey: [],
    // the designer adds the field id
    rule: () => ({
      type: name,
      title: tr(`formkit.widget.${name}`),
      info: '',
      $required: false,
      props: {},
    }),
    props: () =>
      WIDGET_PROPS[name]
        .props()
        .map((p) => ({ ...p, title: tr(`formkit.widget.prop.${p.field}`) })),
  })),
)
// the canvas and the preview render the real pickers
for (const name of WIDGETS) FcDesigner.component(name, QW_WIDGETS[name])
</script>

<script setup lang="ts">
import {
  computed,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  onMounted,
  useTemplateRef,
} from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import type { Config } from '@form-create/designer'
import type { FormSchema } from '@qiwu/shared'
import en from '@form-create/designer/src/locale/en.js'
import zhCn from '@form-create/designer/src/locale/zh-cn.js'
import { dictApi } from '@/api/platform/settings/dict'
import { openDialog } from '@/core/dialog'
import { formLocale } from '@/core/i18n'
import FormExport from './FormExport.vue'

/**
 * The form-create designer (built from its source, wangeditor stubbed; see docs/design-notes.md#workflow, docs/adr/004-form-create.md) under the SPA
 * CSP (`script-src 'self'`). Every editor that evaluates what the user types is hidden: the
 * event and function editors (FnEditor, FnInput) and the JSON editors (Struct, StructEditor) run it through
 * `new Function`, which the CSP blocks, and the schema whitelist rejects functions anyway (see docs/design-notes.md#security).
 * fc-designer-csp.spec.ts holds the designer to that. The formkit page and the process form embed this.
 * Its texts, and its renderers' (settings panels, preview), follow `setLocale` (formkit-design.spec.ts).
 * Our `qw-*` components (widgets.ts) sit in their own group of the component list (formkit-widgets.spec.ts).
 * Export shows the sanitized schema as JSON and as a Vue SFC (formkit-export.spec.ts).
 * Embedded (the new-approval wizard, the process form dialog): `schema` is the form it opens
 * with (a new one: remount it by `key`), `current()` what saving would keep of the form as designed.
 */
defineOptions({ name: 'FormDesigner' })
const { schema } = defineProps<{ schema?: FormSchema }>()

/** embedded (a page or dialog of its own around it, maybe kept alive): no document-wide hotkeys */
const embedded = schema !== undefined
const config: Config & { hotKey: boolean } = {
  showAi: false,
  hiddenMenu: HIDDEN_MENUS,
  hiddenItem: REFUSED_ITEMS,
  showEventForm: false,
  showControl: false,
  showCustomProps: false,
  showJsonPreview: false,
  // the rule list offers a custom validator function
  validateOnlyRequired: true,
  // form events; the form name (the whitelist drops it: a form is named where it is saved)
  hiddenFormConfig: ['formCreate_event', 'formCreateFormName'],
  // its leave-page prompt is a global `window.onbeforeunload` it never removes
  exitConfirm: false,
  // its copy / paste / delete / preview keys listen on the whole document
  hotKey: !embedded,
  hiddenItemConfig: {
    // _optionType: the JSON and remote-fetch options editors; the rest: function props
    default: [
      '_optionType',
      'beforeUpload',
      'beforeRemove',
      'onBeforeRemove',
      'onSuccess',
      'remoteMethod',
    ],
  },
}

// the designer rebuilds itself on a new locale name (its `:key`) and relabels on a new object; its texts
// plus ours: our group's title and our components' names in the list
const TEXTS = { en, 'zh-cn': zhCn }
const { t } = useI18n()
const locale = computed(() => {
  const texts = TEXTS[formLocale.value]
  const names = WIDGETS.map((name) => [name, { name: t(`formkit.widget.${name}`) }])
  return {
    ...texts,
    menu: { ...texts.menu, qw: t('formkit.widget.menu'), qwCalc: t('formkit.widget.calcMenu') },
    com: { ...texts.com, ...Object.fromEntries(names) },
  }
})

dictApi
  .options()
  .then((list) => (dicts.value = list))
  .catch(() => undefined) // the request layer showed it; the dict list stays empty

installFormCreate()

const designer = useTemplateRef<InstanceType<typeof FcDesigner>>('designer')
// its texts (option.language) before the rules that use them
onMounted(() => {
  if (!schema) return
  designer.value!.setOption(schema.option ?? {})
  designer.value!.setRule(schema.rule)
})

/** its document hotkeys (the form builder page): only while that page shows, kept alive or not */
function hotkeys(on: boolean) {
  const d = designer.value as unknown as { bindHotkey?: EventListener; bindPaste?: EventListener }
  if (!config.hotKey || !d?.bindHotkey || !d.bindPaste) return
  const listen = on ? document.addEventListener : document.removeEventListener
  listen.call(document, 'keydown', d.bindHotkey)
  listen.call(document, 'paste', d.bindPaste)
}
onActivated(() => hotkeys(true))
onDeactivated(() => hotkeys(false))
// it sets `window.onbeforeunload` on create and leaves it (exitConfirm off: a no-op still there)
onBeforeUnmount(() => {
  window.onbeforeunload = null
})

/** a setting left off: nothing lost when the whitelist drops it (the designer's blank / `false` defaults) */
const unset = (v: unknown): boolean =>
  v == null || v === '' || v === false || (typeof v === 'object' && Object.values(v).every(unset))
/** the paths (`rule.0.props.x`) of the settings in `input` that `kept` lacks */
function dropped(input: unknown, kept: unknown, path = ''): string[] {
  if (!input || typeof input !== 'object') return []
  return Object.entries(input).flatMap(([k, v]) => {
    const at = path ? `${path}.${k}` : k
    if (kept && typeof kept === 'object' && Object.hasOwn(kept, k))
      return dropped(v, (kept as Record<string, unknown>)[k], at)
    return unset(v) ? [] : [at]
  })
}

/**
 * The form as designed through the whitelist saving applies (see docs/design-notes.md#workflow) with the settings it dropped
 * (`removed`), or why that refuses it.
 */
function current(): { schema: FormSchema; removed: string[] } | { reason: string } {
  const input = { rule: designer.value!.getRule(), option: designer.value!.getOption() }
  const r = sanitizeFormSchema(input)
  if (r.ok) return { schema: r.schema, removed: dropped(input, r.schema) }
  const { message, path } = r.errors[0]!
  return { reason: t(message.key, { ...message.params, field: path.join('.') }) }
}
defineExpose({ current })

/** The schema saving would keep: a form it rejects says why instead. */
function exportCode() {
  const result = current()
  if ('reason' in result) {
    ElMessage.error(t('formkit.export.invalid', { reason: result.reason }))
    return
  }
  void openDialog(
    FormExport,
    { schema: result.schema },
    { title: () => t('formkit.export.title'), width: '960px' },
  )
}
</script>

<template>
  <div class="form-designer">
    <FcDesigner ref="designer" :config="config" :locale="locale" height="100%">
      <template #handle>
        <el-button type="primary" plain size="small" @click="exportCode">
          <i class="fc-icon icon-download"></i> {{ t('formkit.export.action') }}
        </el-button>
      </template>
    </FcDesigner>
  </div>
</template>

<style scoped>
.form-designer {
  height: calc(100vh - 160px);
  /* a page or dialog around it sets its height: room for its own rows at 1280x720 */
  min-height: 360px;
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius);
  overflow: hidden;
}
</style>
