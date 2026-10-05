<script setup lang="ts">
import { computed, nextTick, provide, ref, shallowRef, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  compile,
  WF_NODE_PROGRESS,
  type WfBeginNode,
  type WfCompileError,
  type WfFields,
  type WfNodeProgress,
} from '@qiwu/shared'
import { tx } from '@/core/i18n'
import { Icon } from '@/core/icons'
import WfChain from './WfChain.vue'
import WfProgress from './WfProgress.vue'
import WfNodeDrawer from './WfNodeDrawer.vue'
import { checkMessage, DESIGNER, PROGRESS_ICON, targetOf, type Target } from './tree'

/**
 * Process designer, edit mode (see docs/design-notes.md#workflow): the tree as cards joined by CSS lines, a "+" between nodes,
 * fork paths side by side; a card opens its settings in a drawer. `v-model` = the draft tree, edited in
 * place; `fields` = the form's field list (conditions, form-field assignees, field access).
 * `validate()` runs the shared `compile` (the server's publish check): from then on its errors are
 * listed above the flow and mark their cards; a listed error scrolls to its card and opens it.
 * Read-only mode (an instance's progress tree): given `progress` (node / path id → its progress, the
 * instance detail's), the cards carry their progress by colour and icon (a legend on top) and nothing edits.
 */
defineOptions({ name: 'WfDesigner' })
const tree = defineModel<WfBeginNode>({ required: true })
const { fields, progress } = defineProps<{
  fields: WfFields
  progress?: Record<string, WfNodeProgress>
}>()
const { t } = useI18n()
/** the progresses shown, in their order */
const legend = computed(() => {
  const shown = new Set(Object.values(progress ?? {}))
  return WF_NODE_PROGRESS.filter((p) => shown.has(p))
})

const target = shallowRef<Target>()
const drawer = computed({
  get: () => !!target.value,
  set: (open) => !open && (target.value = undefined),
})
const activeId = computed(() => {
  const s = target.value
  return s && ('node' in s ? s.node.id : s.path.id)
})

const checked = ref(false)
const errors = computed<WfCompileError[]>(() => {
  if (!checked.value) return []
  const r = compile(tree.value, fields)
  return r.ok ? [] : r.errors
})
const invalid = computed(() => new Set(errors.value.map((e) => e.id)))
const open = (s: Target) => {
  if (!progress) target.value = s
}
provide(DESIGNER, {
  tree: () => tree.value,
  fields: () => fields,
  open,
  active: () => activeId.value,
  invalid: (id) => invalid.value.has(id),
  progress: progress && ((id) => progress[id]),
})

// a shape error may come with a missing / non-string name (a draft is any tree-shaped object)
const shownName = (name: unknown) => (typeof name === 'string' ? tx(name).trim() : '')
const nameOf = (s: Target) =>
  'node' in s
    ? shownName(s.node.name) || t(`wf.designer.type.${s.node.type}`)
    : shownName(s.path.name) || t('wf.designer.path.name', { n: s.fork.paths.indexOf(s.path) + 1 })
/** `validation.wf.<code>` as the server words it, naming the node / path instead of its id */
function messageOf(e: WfCompileError) {
  const at = e.id ? targetOf(tree.value, e.id) : undefined
  return checkMessage(e, at && t('wf.designer.check.quote', { name: nameOf(at) }))
}

const root = useTemplateRef<HTMLElement>('root')
/** Scrolls to the card of `id` (a fork: its head) and, `select`ed, opens its settings (a fork has none). */
function locate(id: string, select = true) {
  const el = [...(root.value?.querySelectorAll<HTMLElement>('[data-node-id]') ?? [])].find(
    (e) => e.dataset.nodeId === id,
  )
  const at = el?.matches('.wf-fork') ? el.querySelector('.wf-fork__head') : el
  at?.scrollIntoView?.({ block: 'center', inline: 'center' })
  const found = targetOf(tree.value, id)
  if (select && found && !('node' in found && found.node.type === 'fork')) target.value = found
}

/**
 * The publish check (same `compile` as the server): true when the tree compiles; otherwise its errors show
 * (and follow later edits) and the first one is scrolled to. The page publishes only on true.
 */
function validate(): boolean {
  checked.value = true
  const first = errors.value[0]
  // after the error list renders above the canvas (it moves the cards)
  if (first?.id) void nextTick(() => locate(first.id!, false))
  return !first
}
defineExpose({ validate })
</script>

<template>
  <div ref="root" class="wf-designer" :class="{ 'is-readonly': progress }">
    <div v-if="errors.length" class="wf-designer__errors" role="alert">
      <p class="wf-designer__errors-title">
        <Icon icon="lucide:circle-alert" />
        {{ t('wf.designer.check.title', errors.length) }}
      </p>
      <ul>
        <li v-for="(e, i) in errors" :key="i">
          <button v-if="e.id" type="button" class="wf-designer__error" @click="locate(e.id)">
            {{ messageOf(e) }}
          </button>
          <span v-else>{{ messageOf(e) }}</span>
        </li>
      </ul>
    </div>
    <ul
      v-if="legend.length"
      class="wf-designer__legend"
      :aria-label="t('wf.designer.progress.legend')"
    >
      <li v-for="p in legend" :key="p" :data-progress="p">
        <Icon :icon="PROGRESS_ICON[p]" class="wf-progress" />
        {{ t(`wf.designer.progress.${p}`) }}
      </li>
    </ul>
    <div class="wf-designer__canvas">
      <div class="wf-designer__flow">
        <div
          class="wf-card wf-card--begin"
          :class="{ 'is-active': activeId === tree.id, 'is-error': invalid.has(tree.id) }"
          :data-node-id="tree.id"
          :data-progress="progress?.[tree.id]"
        >
          <component
            :is="progress ? 'div' : 'button'"
            :type="progress ? undefined : 'button'"
            class="wf-card__main"
            @click="open({ node: tree })"
          >
            <span class="wf-card__head">
              <Icon icon="lucide:send" class="wf-card__icon" />
              <span class="wf-card__name">{{ tx(tree.name) }}</span>
              <WfProgress :of="progress?.[tree.id]" />
            </span>
            <span class="wf-card__body">{{ t('wf.designer.summary.begin') }}</span>
          </component>
        </div>
        <WfChain :holder="tree" />
        <div class="wf-designer__end">
          <span class="wf-designer__end-dot" />
          {{ t('wf.designer.end') }}
        </div>
      </div>
    </div>
    <WfNodeDrawer v-if="target" v-model="drawer" :target :fields />
  </div>
</template>

<style>
/* not scoped: WfChain (recursive) draws the same cards and lines */
.wf-designer {
  --wf-line: color-mix(in srgb, var(--qw-text-3) 45%, transparent);

  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--qw-canvas);
  border-radius: var(--qw-radius);
}
.wf-designer__canvas {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
/* compile errors (validate()): each one locates its card */
.wf-designer__errors {
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
.wf-designer__errors-title {
  display: flex;
  gap: 6px;
  align-items: center;
  margin: 0 0 4px;
  font-weight: 600;
  color: var(--qw-danger);
}
.wf-designer__errors ul {
  padding-left: 20px;
  margin: 0;
}
.wf-designer__error {
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
.wf-designer__error:hover {
  color: var(--qw-danger);
}
.wf-designer__flow {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: max-content;
  min-width: 100%;
  padding: 32px 24px 40px;
}
.wf-designer__end {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  font-size: 12px;
  color: var(--qw-text-3);
}
.wf-designer__end-dot {
  width: 10px;
  height: 10px;
  background: var(--wf-line);
  border-radius: 50%;
}
.wf-chain {
  display: flex;
  flex-direction: column;
  align-items: center;
}

/* a segment of the line with the "+" on it */
.wf-add {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 64px;
  background: linear-gradient(var(--wf-line), var(--wf-line)) center / 2px 100% no-repeat;
}
.wf-add__btn {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  color: var(--qw-on-brand);
  cursor: pointer;
  background: var(--qw-brand);
  border: 0;
  border-radius: 50%;
  box-shadow: var(--qw-shadow-1);
  transition: transform 0.15s;
}
.wf-add__btn:hover {
  transform: scale(1.1);
}
.wf-add__icon {
  margin-right: 6px;
}

.wf-card {
  --wf-accent: var(--qw-brand);

  position: relative;
  width: 220px;
  color: var(--qw-text);
  background: var(--qw-surface);
  border: 1px solid var(--qw-border);
  border-top: 3px solid var(--wf-accent);
  border-radius: var(--qw-radius-sm);
  box-shadow: var(--qw-shadow-1);
  transition: border-color 0.15s;
}
.wf-card:hover,
.wf-card.is-active {
  border-color: var(--wf-accent);
}
.wf-card--begin {
  --wf-accent: var(--qw-neutral);
}
.wf-card--notify {
  --wf-accent: var(--qw-success);
}
.wf-card--path {
  --wf-accent: var(--qw-warning);
}
.wf-card.is-error {
  border-color: var(--qw-danger);
  box-shadow: 0 0 0 1px var(--qw-danger);
}
.wf-card__main {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  padding: 10px 12px 12px;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  background: none;
  border: 0;
  border-radius: inherit;
}
.wf-add__btn:focus-visible,
.wf-card__main:focus-visible,
.wf-designer__error:focus-visible {
  outline: 2px solid var(--qw-brand-text);
  outline-offset: 2px;
}
.wf-card__head {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 13px;
  font-weight: 600;
}
.wf-card__icon {
  flex: none;
  width: 16px;
  height: 16px;
  color: var(--wf-accent);
}
.wf-card__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wf-card__body {
  display: -webkit-box;
  overflow: hidden;
  -webkit-line-clamp: 2;
  font-size: 12px;
  line-height: 18px;
  color: var(--qw-text-2);
  -webkit-box-orient: vertical;
}
.wf-card__body.is-missing {
  color: var(--qw-danger);
}
/* copy / remove / move: shown on hover or keyboard focus, over the name's end */
.wf-card__actions {
  position: absolute;
  top: 4px;
  right: 4px;
  display: flex;
  background: var(--qw-surface);
  border-radius: var(--qw-radius-sm);
  opacity: 0;
  transition: opacity 0.15s;
}
.wf-card:hover .wf-card__actions,
.wf-card:focus-within .wf-card__actions {
  opacity: 1;
}
.wf-card .wf-card__actions .icon-button {
  width: 24px;
  height: 24px;
}

.wf-fork {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.wf-fork__top {
  padding-bottom: 24px;
  background: linear-gradient(var(--wf-line), var(--wf-line)) center / 2px 100% no-repeat;
}
.wf-fork__head {
  display: flex;
  gap: 2px;
  align-items: center;
  padding: 4px 4px 4px 8px;
  background: var(--qw-surface);
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius-sm);
  box-shadow: var(--qw-shadow-1);
}
.wf-fork.is-error > .wf-fork__top > .wf-fork__head {
  border-color: var(--qw-danger);
  box-shadow: 0 0 0 1px var(--qw-danger);
}
.wf-fork__head .el-radio-group {
  margin-right: 6px;
}
.wf-fork__paths {
  display: flex;
}
/*
 * each path: its half of the top and bottom bars (none past the outer paths), the stub down to its card, and
 * its chain's segments, the last one stretched to the bottom bar. No full-height line: a nested fork has no
 * background and would show it between its own paths.
 */
.wf-fork__path {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 24px 20px 0;
  background: linear-gradient(var(--wf-line), var(--wf-line)) center top / 2px 24px no-repeat;
}
.wf-fork__path > .wf-chain {
  flex: 1;
}
.wf-fork__path > .wf-chain > .wf-add:last-child {
  box-sizing: border-box;
  flex: 1 0 64px;
  align-items: flex-start;
  padding-top: 18px;
}
.wf-fork__path::before,
.wf-fork__path::after {
  position: absolute;
  right: 0;
  left: 0;
  height: 2px;
  content: '';
  background: var(--wf-line);
}
.wf-fork__path::before {
  top: 0;
}
.wf-fork__path::after {
  bottom: 0;
}
.wf-fork__path:first-child::before,
.wf-fork__path:first-child::after {
  left: 50%;
}
.wf-fork__path:last-child::before,
.wf-fork__path:last-child::after {
  right: 50%;
}

/* read-only (progress): no "+" on the line, cards and the fork head show their progress by colour and icon */
.wf-designer__legend {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  gap: 4px 16px;
  padding: 12px 16px 0;
  margin: 0;
  font-size: 12px;
  color: var(--qw-text-2);
  list-style: none;
}
.wf-designer__legend li {
  display: flex;
  gap: 4px;
  align-items: center;
}
.wf-designer [data-progress='done'] {
  --wf-accent: var(--qw-success);
}
.wf-designer [data-progress='active'] {
  --wf-accent: var(--qw-brand);
}
.wf-designer [data-progress='pending'],
.wf-designer [data-progress='skipped'] {
  --wf-accent: var(--qw-text-3);
}
.wf-designer [data-progress='stopped'] {
  --wf-accent: var(--qw-danger);
}
.wf-progress {
  display: inline-flex;
  flex: none;
  color: var(--wf-accent);
}
.wf-card__head .wf-progress {
  margin-left: auto;
}
.wf-card[data-progress='active'],
.wf-card[data-progress='stopped'] {
  border-color: var(--wf-accent);
  box-shadow:
    0 0 0 1px var(--wf-accent),
    var(--qw-shadow-1);
}
.wf-card[data-progress='skipped'] {
  color: var(--qw-text-3);
  background: var(--qw-canvas);
  border-style: dashed;
  box-shadow: none;
}
.wf-card[data-progress='skipped'] .wf-card__body {
  color: var(--qw-text-3);
}
.is-readonly .wf-card__main {
  cursor: default;
}
/* no "+" to size it: the segment is the line alone */
.is-readonly .wf-add {
  width: 2px;
  height: 40px;
}
.is-readonly .wf-fork__path > .wf-chain > .wf-add:last-child {
  flex-basis: 40px;
}
.is-readonly .wf-fork__head {
  gap: 6px;
  padding: 4px 8px;
  font-size: 12px;
  color: var(--qw-text-2);
}
.wf-fork__icon {
  width: 14px;
  height: 14px;
  color: var(--wf-accent);
}

@media (prefers-reduced-motion: reduce) {
  .wf-add__btn:hover {
    transform: none;
  }
}
</style>
