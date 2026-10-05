<script setup lang="ts">
import { computed, defineAsyncComponent, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { breakpointsElement, useBreakpoints, useEventListener } from '@vueuse/core'
import { ElMessage } from 'element-plus'
import type { FormSchema, WfInstanceDetailVo } from '@qiwu/shared'
import { wfCenterApi } from '@/api/workflow/center'
import DictTag from '@/core/components/DictTag.vue'
import { toastRest } from '@/core/composables/use-crud'
import { openDialog } from '@/core/dialog'
import { currentLocale, formLocale, refName, tx } from '@/core/i18n'
import { Icon } from '@/core/icons'
import { ApiError } from '@/core/request/http'
import { viewLoader } from '@/core/router/build-routes'
import { installFormCreate } from '@/views/platform/formkit/widgets'
import WfDesigner from '../designer/WfDesigner.vue'
import { editableValues, FormCreate, processForm, type ProcessFormApi } from './process-form'
import { at } from './use-center-list'
import WfDecideForm, { type WfDecision, type WfTaskAction } from './WfDecideForm.vue'
import WfTimeline from './WfTimeline.vue'

/**
 * 审批详情 (see docs/design-notes.md#workflow): an instance the caller may see (/workflow/instances/:id; the API
 * answers 404 otherwise). Its head (title, process, initiator, times, state), a custom form's business
 * document (the model's `view_component`, loaded through the views glob with `{ businessKey, readonly: true
 * }`; a dynamic form through form-create by the caller's field access, its `hide` fields never
 * come, `read` ones are disabled, the pending step's `edit` ones go with an approval or a resubmit), its
 * progress tree (the read-only designer, each step coloured by its progress, none when the version's
 * tree no longer compiles, a BPMN model's version: its read-only diagram instead, marked the same way,
 * WfBpmnViewer) and the timeline. The caller's
 * pending review task on it takes the decisions (approve, reject, send back, transfer, delegate; a
 * delegated or add-sign one approves only) and add-sign, cc, comment; the caller's add-signs still
 * pending are removed, their newest approval withdrawn, the initiator cancels (each a WfDecideForm dialog) and
 * urges (once an hour). Sent back to the initiator (their pending `begin` task, also in 我的待办): a dynamic
 * form resubmits here (a dialog, with its `begin.access` `edit` fields as changed on the page), a custom
 * form opens its business page (the route of its `view_component`, `:id` = the business key), where it is
 * edited and resubmitted; or they cancel. Print: the
 * print style keeps the document and the timeline (AppLayout drops the navigation, this page its action
 * bar and the progress tree; a BPMN diagram stays, the bpmn.io logo on it). Titles are built
 * in the reader's language: a language switch reloads.
 */
defineOptions({ name: 'WfInstanceDetail' })
// the Element Plus components form-create renders by name (el-form, el-input, …) on this app
installFormCreate()
// a BPMN model's read-only diagram: its chunk only when one shows
const WfBpmnViewer = defineAsyncComponent(() => import('../bpmn/WfBpmnViewer.vue'))
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const id = Number(route.params.id)

const inst = shallowRef<WfInstanceDetailVo>()
const loading = ref(true)
const narrow = useBreakpoints(breakpointsElement).smaller('sm')
/** the dynamic form as rendered (null: none, or one the sanitizer refuses), its values, a key per load */
const form = shallowRef<FormSchema | null>(null)
const values = ref<Record<string, unknown>>({})
const formApi = shallowRef<ProcessFormApi>()
const loads = ref(0)

/**
 * User fields read by name: UserSelect shows an id it did not pick as `#<id>` unless given its `label`
 * (dept fields read by name on their own: their picker lists every enabled dept, GET /wf/depts/options).
 * Names of the first PAGE_SIZE_MAX users of GET /wf/users/options (as the designer's user-names.ts)
 */
async function withNames(f: FormSchema, v: Record<string, unknown>) {
  const users = f.rule.filter((r) => r.type === 'qw-user-select' && typeof v[r.field] === 'number')
  if (!users.length) return
  const list = await wfCenterApi.userOptions().catch(() => [])
  const names = new Map(list.map((u) => [u.id, u.displayName]))
  // processForm built these rules: theirs to change
  for (const r of users) Object.assign((r.props ??= {}), { label: names.get(v[r.field] as number) })
}

async function load() {
  loading.value = true
  try {
    const d = await wfCenterApi.detail(id)
    const f = d.schema && processForm(d.schema, d.access)
    if (f) await withNames(f, d.formValues)
    form.value = f
    values.value = { ...d.formValues }
    loads.value++
    inst.value = d
  } catch (e) {
    toastRest(e)
  } finally {
    loading.value = false
  }
}
void load()
watch(currentLocale, () => void load())

// the path alone: a reload with the same view keeps the mounted document
const viewPath = computed(() =>
  inst.value?.formKind === 'custom' ? inst.value.viewComponent : null,
)
const view = computed(() => {
  const loader = viewPath.value && viewLoader(viewPath.value)
  return loader ? defineAsyncComponent(loader) : undefined
})
/** bumped by a decision: the document reads its row once, a decision may change it (the business state) */
const rev = ref(0)

/** my oldest pending review task on it; once acted on, a reload offers the next */
const task = computed(() => inst.value?.myTasks.find((x) => x.type === 'review'))
/** sent back to me, its initiator: my pending task on its `begin` step */
const begin = computed(() => inst.value?.myTasks.find((x) => x.type === 'begin'))
/** a custom form sent back to me: its business page, where it is edited and resubmitted */
const businessPage = computed(() => {
  const i = inst.value
  if (!begin.value || i?.formKind !== 'custom' || !i.businessKey || !i.viewComponent)
    return undefined
  const page = router.getRoutes().find((r) => r.meta.component === i.viewComponent)
  return page?.path.replace(/:[^/]+/, encodeURIComponent(i.businessKey))
})
const DECISIONS: WfDecision[] = ['approve', 'reject', 'sendBack', 'transfer', 'delegate']
const ICONS: Record<WfTaskAction, string> = {
  approve: 'lucide:check',
  reject: 'lucide:x',
  sendBack: 'lucide:undo-2',
  transfer: 'lucide:forward',
  delegate: 'lucide:user-round-cog',
  addSign: 'lucide:user-plus',
  removeSign: 'lucide:user-minus',
  cc: 'lucide:send',
  comment: 'lucide:message-square',
  withdraw: 'lucide:rotate-ccw',
  cancel: 'lucide:ban',
  resubmit: 'lucide:send',
}
/** my add-signs still pending, of one task of mine (a remove-sign takes one task's) */
const signs = computed(() => {
  const all = inst.value?.signs ?? []
  return all.filter((s) => s.parentTaskId === all[0]?.parentTaskId)
})
const actions = computed<WfTaskAction[]>(() => {
  const i = inst.value
  if (!i) return []
  const mine = task.value
  const list: WfTaskAction[] = !mine
    ? []
    : mine.child
      ? ['approve', 'cc', 'comment']
      : [...DECISIONS, 'addSign', 'cc', 'comment']
  // a custom form resubmits on its business page (businessPage)
  if (begin.value && i.formKind === 'dynamic') list.push('resubmit')
  if (signs.value.length) list.push('removeSign')
  if (i.withdrawable) list.push('withdraw')
  if (i.canCancel) list.push('cancel')
  return list
})

/** approve / resubmit: the caller's `edit` fields as they stand; null once the form's checks fail */
async function edits(action: WfTaskAction) {
  const access = inst.value?.access ?? {}
  if ((action !== 'approve' && action !== 'resubmit') || !form.value) return undefined
  if (!Object.values(access).includes('edit')) return undefined
  const ok = await (formApi.value?.validate().then(
    () => true,
    () => false,
  ) ?? true)
  return ok ? editableValues(values.value, access) : null
}

async function act(action: WfTaskAction) {
  const i = inst.value
  if (!i) return
  const formValues = await edits(action)
  if (formValues === null) return
  // the task (or instance) it is on and that task's step
  const on =
    action === 'cancel'
      ? { id: i.id, node: '' }
      : action === 'withdraw'
        ? { id: i.withdrawable!.id, node: i.withdrawable!.nodeName }
        : action === 'removeSign'
          ? { id: signs.value[0]!.parentTaskId, node: signs.value[0]!.nodeName }
          : action === 'resubmit'
            ? { id: begin.value!.id, node: '' }
            : { id: task.value!.id, node: task.value!.nodeName }
  const label = () => t(`wf.center.decide.${action}`)
  const done = await openDialog<true>(
    WfDecideForm,
    {
      id: on.id,
      action,
      commentRequired: task.value?.commentRequired,
      signs: signs.value,
      formValues,
    },
    { title: () => (on.node ? `${label()} · ${tx(on.node)}` : label()) },
  )
  if (!done) return
  ElMessage.success(t('wf.center.decide.done'))
  rev.value++
  await load()
}

const urging = ref(false)
async function urge() {
  if (urging.value) return
  urging.value = true
  try {
    // silent: the server's 429 is the generic "too many requests"; this one says when to try again
    await wfCenterApi.urge(id, { silent: true })
    ElMessage.success(t('wf.center.urge.done'))
    await load()
  } catch (e) {
    if (e instanceof ApiError && e.status === 429) ElMessage.warning(t('wf.center.urge.later'))
    else ElMessage.error(e instanceof ApiError ? e.message : t('common.error.network'))
  } finally {
    urging.value = false
  }
}

const print = () => window.print()
// paper is light: in the dark theme the print would carry light text onto white paper
const html = document.documentElement
let dark = false
useEventListener(window, 'beforeprint', () => {
  dark = html.classList.contains('dark')
  html.classList.remove('dark')
})
useEventListener(window, 'afterprint', () => dark && html.classList.add('dark'))
</script>

<template>
  <div v-loading="loading" class="qw-page wf-detail">
    <template v-if="inst">
      <div class="qw-page-bar wf-detail__actions">
        <el-button v-if="businessPage" type="primary" @click="router.push(businessPage)">
          <el-icon class="el-icon--left"><Icon icon="lucide:pencil" /></el-icon>
          {{ t('wf.center.decide.editResubmit') }}
        </el-button>
        <el-button
          v-for="a in actions"
          :key="a"
          :type="a === 'approve' || a === 'resubmit' ? 'primary' : undefined"
          @click="act(a)"
        >
          <el-icon class="el-icon--left"><Icon :icon="ICONS[a]" /></el-icon>
          {{ t(`wf.center.decide.${a}`) }}
        </el-button>
        <el-button v-if="inst.canUrge" :loading="urging" @click="urge">
          <el-icon class="el-icon--left"><Icon icon="lucide:bell-ring" /></el-icon>
          {{ t('wf.center.urge.action') }}
        </el-button>
        <el-button @click="print">
          <el-icon class="el-icon--left"><Icon icon="lucide:printer" /></el-icon>
          {{ t('wf.center.detail.print') }}
        </el-button>
      </div>

      <el-card>
        <el-descriptions :title="inst.title" :column="narrow ? 1 : 3">
          <template #extra><DictTag code="wf.instance_state" :value="inst.state" /></template>
          <el-descriptions-item :label="t('wf.center.list.model')">
            {{ tx(inst.modelName) }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('wf.center.list.initiator')">
            {{ refName(inst.initiator.id, inst.initiator.name) }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('wf.center.list.startedAt')">
            {{ at(inst.startedAt) }}
          </el-descriptions-item>
          <el-descriptions-item v-if="inst.endedAt" :label="t('wf.center.list.endedAt')">
            {{ at(inst.endedAt) }}
          </el-descriptions-item>
        </el-descriptions>
      </el-card>

      <div class="wf-detail__body" :class="{ 'wf-detail__body--split': view || form }">
        <component
          :is="view"
          v-if="view"
          :key="rev"
          :business-key="inst.businessKey"
          :readonly="true"
        />
        <el-card v-else-if="form" class="wf-detail__form">
          <template #header>
            <span class="wf-detail__card-title">{{ t('wf.center.detail.form') }}</span>
          </template>
          <component
            :is="FormCreate"
            :key="loads"
            v-model="values"
            v-model:api="formApi"
            :rule="form.rule"
            :option="form.option"
            :locale="formLocale"
          />
        </el-card>
        <div class="wf-detail__side">
          <el-card v-if="inst.bpmnXml && inst.progress" class="wf-detail__diagram">
            <template #header>
              <span class="wf-detail__card-title">{{ t('wf.center.detail.progress') }}</span>
            </template>
            <WfBpmnViewer :xml="inst.bpmnXml" :progress="inst.progress" />
          </el-card>
          <el-card v-else-if="inst.tree && inst.progress" class="wf-detail__progress">
            <template #header>
              <span class="wf-detail__card-title">{{ t('wf.center.detail.progress') }}</span>
            </template>
            <WfDesigner
              class="wf-detail__tree"
              :model-value="inst.tree"
              :fields="inst.fields"
              :progress="inst.progress"
            />
          </el-card>
          <el-card>
            <template #header>
              <span class="wf-detail__card-title">{{ t('wf.center.detail.timeline') }}</span>
            </template>
            <WfTimeline :events="inst.timeline" />
          </el-card>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.wf-detail {
  min-height: 200px;
}
.wf-detail__card-title {
  font-weight: 600;
}
.wf-detail__body,
.wf-detail__side {
  display: grid;
  gap: 16px;
  align-items: start;
}
.wf-detail__tree {
  max-height: 560px;
}
@media (min-width: 1200px) {
  .wf-detail__body--split {
    grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
  }
}
@media print {
  .wf-detail__actions,
  .wf-detail__progress {
    display: none;
  }
}
</style>
