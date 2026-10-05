<script setup lang="ts">
import { onBeforeUnmount, onMounted, shallowRef, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import { bpmnToTree, WF_BPMN_MODDLE, WF_NODE_PROGRESS, type WfNodeProgress } from '@qiwu/shared'
import type NavigatedViewer from 'bpmn-js/lib/NavigatedViewer'
import { Icon } from '@/core/icons'
import { PROGRESS_ICON } from '../designer/tree'
import { progressMarks, RENDER_COLORS, type Shown } from './diagram'

/**
 * A BPMN model's instance as a read-only diagram: its version's XML in a bpmn-js
 * `NavigatedViewer` (loaded on mount with its stylesheets; pan and zoom), each element marked as the instance
 * stands there by `progress` (the detail's, as the tree's progress), joins and inner flows filled in
 * (`progressMarks`), a legend of the marks shown above. Flows with a condition carry `qw-cond`. Under the
 * bpmn.io logo, which stays as bpmn-js draws it (license), lies a plate of `--qw-logo-plate`
 * (bpmn-theme.css).
 */
defineOptions({ name: 'WfBpmnViewer' })
const { xml, progress } = defineProps<{ xml: string; progress: Record<string, WfNodeProgress> }>()
const { t } = useI18n()

// the few diagram-js services used (got by name from the viewer; diagram-js is not imported)
interface Shape {
  id: string
  type: string
  source?: { id: string }
  target?: { id: string }
  businessObject?: { conditionExpression?: unknown }
}
interface Registry {
  get(id: string): Shape | undefined
  getAll(): Shape[]
}
interface Canvas {
  addMarker(element: Shape, marker: string): void
  zoom(to: 'fit-viewport', center: 'auto'): number
}

const host = useTemplateRef<HTMLElement>('host')
/** the marks shown, in their order (the legend) */
const legend = shallowRef<Shown[]>([])
let viewer: NavigatedViewer | undefined
let gone = false

async function show() {
  const v = viewer!
  try {
    await v.importXML(xml)
  } catch {
    // a published version's XML passed the server's strict parse: this is no diagram bpmn-js reads
    ElMessage.error(t('validation.wf.bpmn_parse'))
    return
  }
  if (gone) return
  const registry = v.get<Registry>('elementRegistry')
  const canvas = v.get<Canvas>('canvas')
  const all = registry.getAll()
  const flows = all.filter((e) => e.type === 'bpmn:SequenceFlow')
  const r = bpmnToTree(v.getDefinitions())
  const marks = progressMarks(
    progress,
    r.ok ? r.joins : {},
    flows.map((f) => ({ id: f.id, source: f.source!.id, target: f.target!.id })),
    new Set(all.filter((e) => e.type === 'bpmn:EndEvent').map((e) => e.id)),
  )
  const shown = new Set<Shown>()
  for (const [id, mark] of marks) {
    // `progress` may name an element the diagram lacks: skipped (addMarker throws on it)
    const el = registry.get(id)
    if (!el) continue
    canvas.addMarker(el, `qw-${mark}`)
    shown.add(mark)
  }
  for (const f of flows) if (f.businessObject?.conditionExpression) canvas.addMarker(f, 'qw-cond')
  legend.value = WF_NODE_PROGRESS.filter((p): p is Shown => shown.has(p as Shown))
  canvas.zoom('fit-viewport', 'auto')
}

onMounted(async () => {
  const [{ default: Viewer }] = await Promise.all([
    import('bpmn-js/lib/NavigatedViewer'),
    import('bpmn-js/dist/assets/diagram-js.css'),
    import('bpmn-js/dist/assets/bpmn-js.css'),
    import('./bpmn-theme.css'),
  ])
  // left before bpmn-js arrived
  if (gone || !host.value) return
  viewer = new Viewer({
    container: host.value,
    moddleExtensions: { qw: WF_BPMN_MODDLE },
    bpmnRenderer: RENDER_COLORS,
  })
  await show()
})
watch([() => xml, () => progress], () => viewer && void show())
onBeforeUnmount(() => {
  gone = true
  viewer?.destroy()
  viewer = undefined
})
</script>

<template>
  <div class="wf-bpmn wf-bpmn-viewer">
    <ul
      v-if="legend.length"
      class="wf-bpmn-viewer__legend"
      :aria-label="t('wf.designer.progress.legend')"
    >
      <li v-for="p in legend" :key="p" :class="`qw-${p}`">
        <Icon :icon="PROGRESS_ICON[p]" class="wf-bpmn-viewer__icon" />
        {{ t(`wf.designer.progress.${p}`) }}
      </li>
    </ul>
    <div class="wf-bpmn-viewer__canvas">
      <div ref="host" class="wf-bpmn-viewer__host" />
      <!-- under the bpmn.io logo bpmn-js puts at the canvas's bottom right (z-index 100), never over it -->
      <div class="wf-bpmn__plate" aria-hidden="true" />
    </div>
  </div>
</template>

<style scoped>
.wf-bpmn-viewer__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  padding: 0;
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--qw-text-2);
  list-style: none;
}
.wf-bpmn-viewer__legend li {
  display: flex;
  gap: 4px;
  align-items: center;
}
.wf-bpmn-viewer__icon {
  color: var(--wf-mark);
}
.wf-bpmn-viewer__canvas {
  position: relative;
  height: 400px;
  background: var(--qw-surface);
}
.wf-bpmn-viewer__host {
  position: absolute;
  inset: 0;
}
</style>
