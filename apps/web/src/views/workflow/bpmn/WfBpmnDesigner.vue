<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { bpmnToTree, compile, WF_BPMN_MODDLE, type WfFields } from '@qiwu/shared'
import type Modeler from 'bpmn-js/lib/Modeler'
import { Icon } from '@/core/icons'
import { checkMessage } from '../designer/tree'
import { RENDER_COLORS } from './diagram'
import type { Written } from './element-node'
import type { El, QwHelpers } from './helpers'
import restrict from './restrict'
import translate from './translate'
import WfBpmnPanel from './WfBpmnPanel.vue'

/**
 * BPMN designer: a bpmn-js `Modeler`, loaded with its stylesheets on mount (the design
 * page's chunk carries neither). `xml` is imported on mount and whenever it changes; `change` reports the
 * diagram as bpmn-js writes it after an import (`imported`: the page's saved state) and after every edit
 * (a command-stack change: canvas, label, undo / redo); `unreadable` when `xml` is no diagram bpmn-js draws
 * (the page shows another). Kept alive with the page, destroyed with it.
 * `validate()` runs the publish check on the diagram itself (shared `bpmnToTree` + `compile`, as the
 * server): from then on its errors are listed above the canvas and mark their elements (`qw-error`);
 * `mark(errors)` shows a server 400's (`path` `xml.<element id>`, `xml` = no single element) until the
 * next edit; `importXml(text)` puts a file's diagram on the canvas, unsaved and checked at once (the page's
 * import). Flows with a condition carry `qw-cond`. What the canvas offers and its editing
 * helpers: `restrict.ts`, `helpers.ts`; the selected element's settings: the panel docked right of the
 * canvas (`WfBpmnPanel.vue`), its edits written back through the same command stack (one undo step each). Its texts follow the app's language
 * (`translate.ts`, switched at runtime). Under the bpmn.io logo, which stays as bpmn-js draws it (license), lies a plate of `--qw-logo-plate`: the dark canvas would leave the logo at about 1.8:1.
 */
defineOptions({ name: 'WfBpmnDesigner' })
const { xml, fields } = defineProps<{ xml: string; fields: WfFields }>()
const emit = defineEmits<{ change: [xml: string, imported: boolean]; unreadable: [] }>()
const { t, locale } = useI18n()

// the few diagram-js services used (got by name from the modeler; diagram-js is not imported)
interface Shape {
  id: string
  type: string
  businessObject?: { name?: string; conditionExpression?: unknown }
}
interface Box {
  x: number
  y: number
  width: number
  height: number
}
interface Canvas {
  viewbox(): Box & { inner: Box; outer: Box }
  viewbox(box: Box): void
  getContainer(): HTMLElement
  addMarker(element: Shape, marker: string): void
  removeMarker(element: Shape, marker: string): void
  scrollToElement(element: Shape): void
}
interface Registry {
  get(id: string): Shape | undefined
  getAll(): Shape[]
}
/** a selected element (a label stands for the element it labels) */
type Picked = El & { labelTarget?: El }

/** px kept free around the fitted diagram */
const MARGIN = 24

type Issue = { id: string | null; msg: string }
const issues = shallowRef<Issue[]>([])
const host = useTemplateRef<HTMLElement>('host')
const panel = useTemplateRef<InstanceType<typeof WfBpmnPanel>>('panel')
/** the one element selected (none: nothing or several); the panel reads it again on every `version` */
const selected = shallowRef<El>()
const version = ref(0)
let modeler: Modeler | undefined
let gone = false
/** validate() ran: the check follows every edit */
let checked = false
/** the issues shown are a server 400's (`mark`): kept until the next edit, a language switch included */
let marked = false

const service = <T,>(name: string) => modeler!.get<T>(name)

/** an element as a message names it: its name quoted, else its id */
function nameOf(id: string | null) {
  const name = id ? service<Registry>('elementRegistry').get(id)?.businessObject?.name : undefined
  return name ? t('wf.designer.check.quote', { name }) : (id ?? '')
}

/** The publish check of the diagram on the canvas (the server's, rule ⑫). */
function check(): Issue[] {
  const r = bpmnToTree(modeler!.getDefinitions())
  if (!r.ok)
    return r.errors.map((e) => ({
      id: e.id,
      msg: t(`validation.wf.${e.code}`, { node: nameOf(e.id) }),
    }))
  const c = compile(r.tree, fields)
  if (c.ok) return []
  return c.errors.map((e) => ({ id: e.id, msg: checkMessage(e, e.id ? nameOf(e.id) : undefined) }))
}

/** `qw-error` on the elements the issues name, `qw-cond` on the flows with a condition. */
function paint() {
  const canvas = service<Canvas>('canvas')
  const bad = new Set(issues.value.map((i) => i.id))
  const mark = (el: Shape, marker: string, on: boolean) =>
    on ? canvas.addMarker(el, marker) : canvas.removeMarker(el, marker)
  for (const el of service<Registry>('elementRegistry').getAll()) {
    if (el.type === 'label') continue
    mark(el, 'qw-error', bad.has(el.id))
    mark(el, 'qw-cond', !!el.businessObject?.conditionExpression)
  }
}

/** the check's issues (validated), else none: a server's answer is stale once the diagram changed */
function recheck() {
  marked = false
  issues.value = checked ? check() : []
  paint()
}

/**
 * Fits the diagram into the canvas right of the palette (it floats over the canvas's left edge), at most at
 * 100 %.
 */
function fit() {
  const canvas = service<Canvas>('canvas')
  const { inner, outer } = canvas.viewbox()
  if (!outer.width || !outer.height) return
  const box = canvas.getContainer().getBoundingClientRect()
  const palette = canvas.getContainer().querySelector('.djs-palette')?.getBoundingClientRect()
  const left = (palette ? palette.right - box.left : 0) + MARGIN
  const scale = Math.max(
    0.2,
    Math.min(
      1,
      (outer.width - left - MARGIN) / inner.width,
      (outer.height - 2 * MARGIN) / inner.height,
    ),
  )
  canvas.viewbox({
    x: inner.x - left / scale,
    y: inner.y - MARGIN / scale,
    width: outer.width / scale,
    height: outer.height / scale,
  })
}

/** The diagram as XML, as it is. */
async function xmlNow(): Promise<string> {
  const { xml: out } = await modeler!.saveXML({ format: true })
  return out!
}

/** The diagram as XML (what the page saves and publishes), the panel's pending edit written first. */
function saveXml(): Promise<string> {
  panel.value?.flush()
  return xmlNow()
}

/** Shows the diagram `text` (`saved`: the page's saved state); its import warnings, null when bpmn-js failed. */
async function show(text: string, saved: boolean): Promise<string[] | null> {
  let warnings: unknown[]
  try {
    ;({ warnings } = await modeler!.importXML(text))
  } catch {
    return null
  }
  selected.value = undefined
  if (gone) return []
  fit()
  recheck()
  emit('change', await xmlNow(), saved)
  // moddle's and bpmn-js's warnings are `{ message }` objects (the typings say strings)
  return warnings.map((w) => (w as { message?: string }).message ?? String(w))
}

async function load(text: string) {
  // a stored draft passed the server's strict parse, yet bpmn-js may draw nothing of it (no DI, …)
  if ((await show(text, true)) === null && !gone) emit('unreadable')
}

onMounted(async () => {
  const [{ default: BpmnModeler }] = await Promise.all([
    import('bpmn-js/lib/Modeler'),
    import('bpmn-js/dist/assets/diagram-js.css'),
    import('bpmn-js/dist/assets/bpmn-js.css'),
    import('bpmn-js/dist/assets/bpmn-font/css/bpmn.css'),
    import('./bpmn-theme.css'),
  ])
  // left before bpmn-js arrived
  if (gone || !host.value) return
  modeler = new BpmnModeler({
    container: host.value,
    moddleExtensions: { qw: WF_BPMN_MODDLE },
    bpmnRenderer: RENDER_COLORS,
    // the element subset's palette / context pad / change menu, the editing helpers, the app's language
    additionalModules: [restrict, translate],
  })
  modeler.on('selection.changed', ({ newSelection: [el, ...more] }: { newSelection: Picked[] }) => {
    selected.value = el && !more.length ? (el.labelTarget ?? el) : undefined
  })
  modeler.on('commandStack.changed', async (e: { trigger?: string }) => {
    // an import clears the stack: that is no edit
    if (e.trigger === 'clear') return
    version.value++
    recheck()
    const out = await xmlNow()
    if (!gone) emit('change', out, false)
  })
  await load(xml)
})
watch(
  () => xml,
  (text) => modeler && void load(text),
)
// a language switch: the palette rebuilds, an open context pad reopens (its entries read again), a menu closes;
// the check's messages follow
watch(locale, () => {
  if (!modeler) return
  service<{ fire(event: string): void }>('eventBus').fire('i18n.changed')
  service<{ close(): void }>('popupMenu').close()
  const selection = service<{ get(): Shape[]; select(els: Shape[]): void }>('selection')
  selection.select(selection.get())
  if (checked && !marked) recheck()
})
onBeforeUnmount(() => {
  gone = true
  modeler?.destroy()
  modeler = undefined
})

/**
 * The publish check (same as the server's): true when the diagram compiles; otherwise its errors show (and
 * follow later edits). The page publishes only on true.
 */
function validate(): boolean {
  if (!modeler) return false
  panel.value?.flush()
  checked = true
  recheck()
  return !issues.value.length
}

/**
 * A file's diagram on the canvas (the page's import): unsaved, its check shown at once; its
 * import warnings, null when it is no diagram bpmn-js reads.
 */
async function importXml(text: string): Promise<string[] | null> {
  if (!modeler) return null
  const before = await xmlNow().catch(() => undefined)
  const warnings = await show(text, false)
  // read but not drawn (no diagram in it, …): bpmn-js cleared the canvas first, what was there comes back
  if (!warnings) {
    if (before !== undefined) await show(before, false)
  } else if (!gone) {
    checked = true
    recheck()
  }
  return warnings
}

/** A server 400's errors on their elements (until the next edit). */
function mark(errors: readonly { path: string; msg: string }[]) {
  if (!modeler) return
  marked = true
  issues.value = errors.map((e) => ({
    id: e.path.startsWith('xml.') ? e.path.slice(4) : null,
    msg: e.msg,
  }))
  paint()
}

/** Scrolls to the element `id` and selects it. */
function locate(id: string) {
  const el = service<Registry>('elementRegistry').get(id)
  if (!el) return
  service<Canvas>('canvas').scrollToElement(el)
  service<{ select(el: Shape): void }>('selection').select(el)
}

/** `el` still on the canvas (an edit pending for an element deleted meanwhile goes nowhere) */
const live = (el: { id: string }) =>
  !!modeler && service<Registry>('elementRegistry').get(el.id) === el
const helpers = () => service<QwHelpers>('qwHelpers')
const byId = (id: string) => service<Registry>('elementRegistry').get(id) as El | undefined

function update(el: { id: string }, edit: Written) {
  if (live(el)) helpers().update(el as El, edit)
}
function reorder(a: string, b: string) {
  const [from, to] = [byId(a), byId(b)]
  if (from && to) helpers().reorder(from, to)
}
/** ③: the fork's new path, selected to set it up */
function addPath(id: string) {
  const fork = byId(id)
  const flow = fork && helpers().addPath(fork)
  if (flow) service<{ select(el: El): void }>('selection').select(flow)
}

defineExpose({ validate, mark, saveXml, importXml })
</script>

<template>
  <div class="wf-bpmn">
    <div v-if="issues.length" class="wf-bpmn__errors" role="alert">
      <p class="wf-bpmn__errors-title">
        <Icon icon="lucide:circle-alert" />
        {{ t('wf.designer.check.title', issues.length) }}
      </p>
      <ul>
        <li v-for="(e, i) in issues" :key="i">
          <button v-if="e.id" type="button" class="wf-bpmn__error" @click="locate(e.id)">
            {{ e.msg }}
          </button>
          <span v-else>{{ e.msg }}</span>
        </li>
      </ul>
    </div>
    <div class="wf-bpmn__body">
      <div class="wf-bpmn__canvas">
        <div ref="host" class="wf-bpmn__host" />
        <!-- under the bpmn.io logo bpmn-js puts at the canvas's bottom right (z-index 100), never over it: a light
             ground it reads on in both themes -->
        <div class="wf-bpmn__plate" aria-hidden="true" />
      </div>
      <WfBpmnPanel
        ref="panel"
        :element="selected"
        :fields
        :version
        class="wf-bpmn__panel"
        @update="update"
        @reorder="reorder"
        @add-path="addPath"
      />
    </div>
  </div>
</template>

<style scoped>
.wf-bpmn {
  display: flex;
  flex-direction: column;
  background: var(--qw-surface);
}
.wf-bpmn__body {
  display: flex;
  flex: 1;
  min-height: 0;
}
.wf-bpmn__canvas {
  position: relative;
  flex: 1;
  min-width: 0;
}
.wf-bpmn__host {
  position: absolute;
  inset: 0;
}
/* docked beside the canvas, never over it (the bpmn.io logo stays clear) */
.wf-bpmn__panel {
  flex: none;
  width: 320px;
}
.wf-bpmn__errors {
  flex: none;
  max-height: 30%;
  padding: 10px 16px;
  margin: 12px 12px 0;
  overflow: auto;
  font-size: 13px;
  color: var(--qw-text);
  background: var(--qw-danger-weak);
  border-radius: var(--qw-radius-sm);
}
.wf-bpmn__errors-title {
  display: flex;
  gap: 6px;
  align-items: center;
  margin: 0 0 4px;
  font-weight: 600;
  color: var(--qw-danger);
}
.wf-bpmn__errors ul {
  padding-left: 20px;
  margin: 0;
}
.wf-bpmn__error {
  padding: 0;
  font: inherit;
  color: inherit;
  text-align: left;
  text-decoration: underline dotted;
  text-underline-offset: 3px;
  cursor: pointer;
  background: none;
  border: 0;
}
.wf-bpmn__error:hover {
  color: var(--qw-danger);
}
</style>
