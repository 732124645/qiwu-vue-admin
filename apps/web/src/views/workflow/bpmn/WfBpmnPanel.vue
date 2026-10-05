<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { WF_NAME_MAX, type WfFields } from '@qiwu/shared'
import IconButton from '@/core/components/IconButton.vue'
import { Icon } from '@/core/icons'
import WfNodeSettings from '../designer/WfNodeSettings.vue'
import {
  branchesOf,
  editOf,
  isFork,
  isTarget,
  written,
  type Edit,
  type Item,
  type Written,
} from './element-node'

/**
 * The BPMN designer's settings panel, docked right of the canvas: the selected element in
 * the tree designer's form (`WfNodeSettings` over its `Target`, `element-node.ts`) — a start, review or carbon
 * copy; a branching gateway's name, its paths in order (up / down: `reorder`) and "add path" (`addPath`); a
 * path's name, condition and "make default"; any other element's name. It edits a copy and hands what to
 * write back on (`update`), debounced — a burst of typing is one undo step — and at once on another selection
 * or `flush()`. The designer bumps `version` on every change of the diagram: an element no longer holding
 * what was last read or handed on (undo, redo, a label edited on the canvas) is read again.
 */
defineOptions({ name: 'WfBpmnPanel' })
const { element, fields, version } = defineProps<{
  element: Item | undefined
  fields: WfFields
  version: number
}>()
const emit = defineEmits<{
  update: [element: Item, edit: Written]
  reorder: [a: string, b: string]
  addPath: [fork: string]
}>()
const { t } = useI18n()

/** ms an edit waits for the next one before it is handed on */
const DEBOUNCE = 300
/** panel titles of the elements edited by name only */
const OTHER: Record<string, string> = {
  'bpmn:EndEvent': 'end',
  'bpmn:SequenceFlow': 'flow',
  'bpmn:ExclusiveGateway': 'join',
  'bpmn:ParallelGateway': 'join',
  'bpmn:InclusiveGateway': 'join',
}

const edit = ref<Edit>()
/** a fork's paths, fresh from the diagram */
const paths = shallowRef<ReturnType<typeof branchesOf>>([])
/** reads so far: the form is new for each */
const reads = ref(0)
/** the element `edit` is of, its type */
let shown: Item | undefined
const type = ref('')
/** `written(edit)` as last read or handed on (JSON) */
let last = ''
let timer: ReturnType<typeof setTimeout> | undefined

function read(el: Item | undefined) {
  shown = el
  type.value = el?.type ?? ''
  edit.value = el && editOf(el)
  last = edit.value ? JSON.stringify(written(edit.value)) : ''
  reads.value++
}

/** Hands a pending edit on now. */
function flush() {
  clearTimeout(timer)
  timer = undefined
  if (!shown || !edit.value) return
  const next = written(edit.value)
  const json = JSON.stringify(next)
  if (json === last) return
  last = json
  emit('update', shown, next)
}

watch(
  () => [element, version] as const,
  ([el]) => {
    if (el !== shown) {
      flush()
      read(el)
    } else if (el && JSON.stringify(written(editOf(el))) !== last) read(el)
    paths.value = el && isFork(el) ? branchesOf(el) : []
  },
  { immediate: true },
)
watch(
  edit,
  () => {
    clearTimeout(timer)
    timer = setTimeout(flush, DEBOUNCE)
  },
  { deep: true },
)
onBeforeUnmount(() => clearTimeout(timer))

const target = computed(() => (edit.value && isTarget(edit.value) ? edit.value : undefined))
const named = computed(() => (edit.value && !isTarget(edit.value) ? edit.value : undefined))
const path = computed(() => (target.value && 'path' in target.value ? target.value : undefined))
const fork = computed(() =>
  target.value && 'node' in target.value && target.value.node.type === 'fork'
    ? target.value.node
    : undefined,
)
const title = computed(() => {
  if (path.value) return t('wf.designer.drawer.path')
  if (fork.value) return t('wf.bpmn.panel.fork')
  if (target.value && 'node' in target.value)
    return t(`wf.designer.drawer.${target.value.node.type}`)
  return t(`wf.bpmn.panel.${OTHER[type.value] ?? 'element'}`)
})

/** The path becomes its fork's default one (it has no condition then). */
function makeDefault() {
  path.value!.path.fallback = true
  path.value!.path.when = []
  flush()
}
function move(i: number, delta: -1 | 1) {
  flush()
  emit('reorder', paths.value[i]!.id, paths.value[i + delta]!.id)
}
function addPath() {
  flush()
  emit('addPath', shown!.id)
}

defineExpose({ flush })
</script>

<template>
  <aside class="wf-bpmn-panel" :aria-label="t('wf.bpmn.panel.title')">
    <template v-if="edit">
      <h3 class="wf-bpmn-panel__title">{{ title }}</h3>
      <WfNodeSettings v-if="target" :key="reads" :target :fields />
      <el-form v-else-if="named" :key="reads" label-position="top" @submit.prevent>
        <el-form-item :label="t('wf.designer.drawer.name')">
          <el-input v-model="named.name" name="name" :maxlength="WF_NAME_MAX" show-word-limit />
        </el-form-item>
      </el-form>

      <el-button
        v-if="path && path.fork.mode !== 'parallel' && !path.path.fallback"
        class="wf-bpmn-panel__default"
        @click="makeDefault"
      >
        {{ t('wf.bpmn.panel.makeDefault') }}
      </el-button>

      <section v-if="fork" class="wf-bpmn-panel__paths">
        <h4 class="wf-bpmn-panel__label">{{ t('wf.bpmn.panel.order') }}</h4>
        <p v-if="fork.mode === 'exclusive'" class="wf-bpmn-panel__hint">
          {{ t('wf.bpmn.panel.orderHint') }}
        </p>
        <ol class="wf-bpmn-panel__list">
          <li v-for="(p, i) in paths" :key="p.id" class="wf-bpmn-panel__path">
            <span class="wf-bpmn-panel__no">{{ i + 1 }}</span>
            <span class="wf-bpmn-panel__name">{{ p.label }}</span>
            <el-tag v-if="p.fallback" size="small" type="info" disable-transitions>
              {{ t('wf.bpmn.panel.default') }}
            </el-tag>
            <IconButton
              v-if="i > 0"
              icon="lucide:arrow-up"
              :label="t('wf.bpmn.panel.up')"
              @click="move(i, -1)"
            />
            <IconButton
              v-if="i < paths.length - 1"
              icon="lucide:arrow-down"
              :label="t('wf.bpmn.panel.down')"
              @click="move(i, 1)"
            />
          </li>
        </ol>
        <el-button @click="addPath">
          <el-icon class="el-icon--left"><Icon icon="lucide:plus" /></el-icon>
          {{ t('wf.designer.fork.addPath') }}
        </el-button>
      </section>
    </template>
    <p v-else class="wf-bpmn-panel__hint">{{ t('wf.bpmn.panel.empty') }}</p>
  </aside>
</template>

<style scoped>
.wf-bpmn-panel {
  box-sizing: border-box;
  padding: 16px;
  overflow: auto;
  background: var(--qw-surface);
  border-left: 1px solid var(--qw-border);
}
.wf-bpmn-panel__title {
  margin: 0 0 16px;
  font-size: 15px;
  font-weight: 600;
  color: var(--qw-text);
}
.wf-bpmn-panel__default {
  margin-bottom: 16px;
}
.wf-bpmn-panel__label {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 500;
  color: var(--qw-text-2);
}
.wf-bpmn-panel__hint {
  margin: 0 0 8px;
  font-size: 12px;
  line-height: 18px;
  color: var(--qw-text-3);
}
.wf-bpmn-panel__list {
  padding: 0;
  margin: 0 0 12px;
  list-style: none;
}
.wf-bpmn-panel__path {
  display: flex;
  gap: 6px;
  align-items: center;
  min-height: 36px;
  font-size: 13px;
  color: var(--qw-text);
  border-bottom: 1px solid var(--qw-border);
}
.wf-bpmn-panel__no {
  flex: none;
  width: 20px;
  color: var(--qw-text-3);
  text-align: right;
}
.wf-bpmn-panel__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
