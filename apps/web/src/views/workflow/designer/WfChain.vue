<script setup lang="ts">
import { computed, inject } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessageBox } from 'element-plus'
import {
  WF_ASSIGNEE_ID_KINDS,
  type WfAssignee,
  type WfCondition,
  type WfForkMode,
  type WfForkNode,
  type WfForkPath,
} from '@qiwu/shared'
import IconButton from '@/core/components/IconButton.vue'
import { tx } from '@/core/i18n'
import { Icon } from '@/core/icons'
import {
  DESIGNER,
  INITIATOR_LABEL,
  addPath,
  canMovePath,
  canRemovePath,
  chain,
  copyStep,
  dropsConditions,
  idsOf,
  insertStep,
  movePath,
  newStep,
  removePath,
  removeStep,
  setForkMode,
  stepAfter,
  type Holder,
  type StepType,
} from './tree'
import WfProgress from './WfProgress.vue'

/**
 * One chain of WfDesigner (styles there): the steps below `holder`, a "+" before each and at the end.
 * Read-only (`ctx.progress`): the line without "+", cards without actions, a fork's mode as text.
 */
defineOptions({ name: 'WfChain' })
const { holder } = defineProps<{ holder: Holder }>()
const { t } = useI18n()
const ctx = inject(DESIGNER)!
const ro = !!ctx.progress
const progressOf = (id: string) => ctx.progress?.(id)

/** each "+" with the step below it (none after the last) */
const items = computed(() => {
  const steps = chain(holder)
  return [holder, ...steps].map((h, i) => ({ h, step: steps[i] }))
})

const ICON = { review: 'lucide:user-check', notify: 'lucide:mail', fork: 'lucide:git-fork' }
const ADD: StepType[] = ['review', 'notify', 'fork']
const MODES: WfForkMode[] = ['exclusive', 'inclusive', 'parallel']
const FIELD_KINDS = ['formFieldUser', 'formFieldDeptHead']

const add = (h: Holder, type: StepType) => insertStep(h, newStep(type, idsOf(ctx.tree())))

async function confirmed(message: string) {
  try {
    await ElMessageBox.confirm(message, t('wf.designer.confirm.title'), {
      type: 'warning',
      confirmButtonText: t('wf.designer.confirm.ok'),
      cancelButtonText: t('common.action.cancel'),
    })
    return true
  } catch {
    return false
  }
}
// dropping more than the clicked card (a fork's nodes, a path's nodes, conditions) asks first
async function remove(h: Holder) {
  const step = stepAfter(h)
  if (step?.type === 'fork' && step.paths.some((p) => p.child))
    if (!(await confirmed(t('wf.designer.confirm.removeFork')))) return
  removeStep(h)
}
async function dropPath(fork: WfForkNode, path: WfForkPath) {
  if (path.child && !(await confirmed(t('wf.designer.confirm.removePath')))) return
  removePath(fork, path)
}
async function setMode(fork: WfForkNode, mode: WfForkMode) {
  if (dropsConditions(fork, mode) && !(await confirmed(t('wf.designer.confirm.parallel')))) return
  setForkMode(fork, mode)
}

const missing = (a: WfAssignee) =>
  (WF_ASSIGNEE_ID_KINDS as readonly string[]).includes(a.kind)
    ? !a.ids?.length
    : FIELD_KINDS.includes(a.kind) && !a.field
function assigneeText(a: WfAssignee) {
  const kind = t(`wf.designer.assignee.kinds.${a.kind}`)
  if (missing(a)) return t('wf.designer.summary.unset', { kind })
  if (a.ids?.length) return `${kind} · ${t('wf.designer.summary.count', a.ids.length)}`
  if (a.kind === 'deptHeadChain')
    return `${kind} · ${a.levels == null ? t('wf.designer.summary.toTop') : t('wf.designer.summary.levels', a.levels)}`
  return a.field ? `${kind} · ${a.field}` : kind
}

function condText({ field, op, value }: WfCondition) {
  const initiator = Object.hasOwn(INITIATOR_LABEL, field)
  const name = initiator ? t(INITIATOR_LABEL[field]!) : field
  const type = ctx.fields()[field]
  // ids read as a count
  const ids = initiator || type === 'user' || type === 'dept'
  const shown = Array.isArray(value)
    ? ids
      ? t('wf.designer.summary.count', value.length)
      : value.join(', ')
    : value === ''
      ? '?'
      : ids
        ? `#${value}`
        : String(value)
  return `${name} ${t(`wf.designer.op.${op}`)} ${shown}`
}
/** a condition without its value (the builder starts one so): `compile` rejects it */
const unset = ({ value }: WfCondition) => value === '' || (Array.isArray(value) && !value.length)
const pathMissing = (fork: WfForkNode, p: WfForkPath) =>
  fork.mode !== 'parallel' && !p.fallback && (!p.when.length || p.when.some((g) => g.some(unset)))
function pathText(fork: WfForkNode, p: WfForkPath) {
  if (fork.mode === 'parallel') return t('wf.designer.summary.parallel')
  if (p.fallback) return t('wf.designer.summary.fallback')
  if (!p.when.length) return t('wf.designer.summary.noCondition')
  return p.when
    .map((g) => g.map(condText).join(` ${t('wf.designer.cond.and')} `))
    .join(` ${t('wf.designer.cond.or')} `)
}
</script>

<template>
  <div class="wf-chain">
    <template v-for="{ h, step } in items" :key="step?.id ?? 'end'">
      <div class="wf-add">
        <el-dropdown v-if="!ro" trigger="click" @command="(type: StepType) => add(h, type)">
          <button type="button" class="wf-add__btn" :aria-label="t('wf.designer.add')">
            <Icon icon="lucide:plus" />
          </button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item v-for="type in ADD" :key="type" :command="type">
                <Icon :icon="ICON[type]" class="wf-add__icon" />
                {{ t(`wf.designer.type.${type}`) }}
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>

      <div
        v-if="step?.type === 'fork'"
        class="wf-fork"
        :class="{ 'is-error': ctx.invalid(step.id) }"
        :data-node-id="step.id"
        :data-progress="progressOf(step.id)"
      >
        <div class="wf-fork__top">
          <div v-if="ro" class="wf-fork__head">
            <Icon :icon="ICON.fork" class="wf-fork__icon" />
            {{ t(`wf.designer.fork.modes.${step.mode ?? 'exclusive'}`) }}
            <WfProgress :of="progressOf(step.id)" />
          </div>
          <div v-else class="wf-fork__head">
            <el-radio-group
              :model-value="step.mode ?? 'exclusive'"
              size="small"
              :aria-label="t('wf.designer.fork.mode')"
              @change="(m: WfForkMode) => setMode(step, m)"
            >
              <el-radio-button v-for="m in MODES" :key="m" :value="m">
                {{ t(`wf.designer.fork.modes.${m}`) }}
              </el-radio-button>
            </el-radio-group>
            <IconButton
              icon="lucide:plus"
              :label="t('wf.designer.fork.addPath')"
              @click="addPath(step, ctx.tree())"
            />
            <IconButton
              icon="lucide:copy"
              :label="t('wf.designer.copy')"
              @click="copyStep(h, ctx.tree())"
            />
            <IconButton icon="lucide:trash-2" :label="t('wf.designer.remove')" @click="remove(h)" />
          </div>
        </div>
        <div class="wf-fork__paths">
          <div v-for="p in step.paths" :key="p.id" class="wf-fork__path">
            <div
              class="wf-card wf-card--path"
              :class="{ 'is-active': ctx.active() === p.id, 'is-error': ctx.invalid(p.id) }"
              :data-node-id="p.id"
              :data-progress="progressOf(p.id)"
            >
              <component
                :is="ro ? 'div' : 'button'"
                :type="ro ? undefined : 'button'"
                class="wf-card__main"
                @click="ctx.open({ fork: step, path: p })"
              >
                <span class="wf-card__head">
                  <Icon icon="lucide:split" class="wf-card__icon" />
                  <span class="wf-card__name">{{ tx(p.name) }}</span>
                  <WfProgress :of="progressOf(p.id)" />
                </span>
                <span class="wf-card__body" :class="{ 'is-missing': pathMissing(step, p) }">
                  {{ pathText(step, p) }}
                </span>
              </component>
              <span v-if="!ro" class="wf-card__actions">
                <IconButton
                  v-if="canMovePath(step, p, -1)"
                  icon="lucide:chevron-left"
                  :label="t('wf.designer.fork.moveLeft')"
                  @click="movePath(step, p, -1)"
                />
                <IconButton
                  v-if="canMovePath(step, p, 1)"
                  icon="lucide:chevron-right"
                  :label="t('wf.designer.fork.moveRight')"
                  @click="movePath(step, p, 1)"
                />
                <IconButton
                  v-if="canRemovePath(step, p)"
                  icon="lucide:x"
                  :label="t('wf.designer.fork.removePath')"
                  @click="dropPath(step, p)"
                />
              </span>
            </div>
            <WfChain :holder="p" />
          </div>
        </div>
      </div>

      <div
        v-else-if="step"
        class="wf-card"
        :class="[
          `wf-card--${step.type}`,
          { 'is-active': ctx.active() === step.id, 'is-error': ctx.invalid(step.id) },
        ]"
        :data-node-id="step.id"
        :data-progress="progressOf(step.id)"
      >
        <component
          :is="ro ? 'div' : 'button'"
          :type="ro ? undefined : 'button'"
          class="wf-card__main"
          @click="ctx.open({ node: step })"
        >
          <span class="wf-card__head">
            <Icon :icon="ICON[step.type]" class="wf-card__icon" />
            <span class="wf-card__name">{{ tx(step.name) }}</span>
            <WfProgress :of="progressOf(step.id)" />
          </span>
          <span class="wf-card__body" :class="{ 'is-missing': missing(step.assignee) }">
            {{ assigneeText(step.assignee) }}
          </span>
        </component>
        <span v-if="!ro" class="wf-card__actions">
          <IconButton
            icon="lucide:copy"
            :label="t('wf.designer.copy')"
            @click="copyStep(h, ctx.tree())"
          />
          <IconButton icon="lucide:trash-2" :label="t('wf.designer.remove')" @click="remove(h)" />
        </span>
      </div>
    </template>
  </div>
</template>
