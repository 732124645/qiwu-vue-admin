<script setup lang="ts">
import { computed, h, ref, shallowRef, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'
import { useEventListener } from '@vueuse/core'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  wfPerms,
  type WfBeginNode,
  type WfFields,
  type WfModelDetailVo,
  type WfVersionVo,
} from '@qiwu/shared'
import { wfModelApi } from '@/api/workflow/model'
import { toastRest } from '@/core/composables/use-crud'
import { tx } from '@/core/i18n'
import { Icon } from '@/core/icons'
import { ApiError, saveBlob } from '@/core/request/http'
import { useTagsStore } from '@/core/stores/tags'
import WfDesigner from '../designer/WfDesigner.vue'
import WfBpmnDesigner from '../bpmn/WfBpmnDesigner.vue'
import { bpmnRefusal, designFields, draftTree, draftXml, jsonXml, publishBody } from './model-list'

/**
 * 流程设计 (hidden page `/wf/models/:id/design`): the model's draft in its designer — a tree model's
 * in `WfDesigner`, a BPMN model's in `WfBpmnDesigner` (a new one starts as the begin node's
 * diagram) — saved as it is (`PUT /:id/draft`, checked only on publish) or published as the next version
 * (`POST /:id/versions`) once the designer's `validate()` (the server's check) passes, its errors marking their
 * nodes / elements otherwise; a BPMN publish refused by the server marks the elements its errors name.
 * A BPMN model's canvas imports a `.bpmn` / `.xml` file or a version's JSON export (its tree drawn, seed keys as
 * text, ids a diagram refuses renamed) and exports itself as `.bpmn`: an import is unsaved.
 * A stored draft bpmn-js cannot draw (saved through the API: a draft is checked only on publish) gives way to
 * the begin node's diagram, said in a notice: imported or drawn again, it is saved over the draft.
 * Field access applies to dynamic forms only: a custom model's designer shows no field access table.
 * Leaving with unsaved changes (back, another tab, a closed tab, reload) asks first.
 */
defineOptions({ name: 'WfModelDesign' })
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const tags = useTagsStore()
const id = Number(route.params.id)

const model = shallowRef<WfModelDetailVo>()
const versions = shallowRef<WfVersionVo[]>([])
const fields = shallowRef<WfFields>({})
const tree = ref<WfBeginNode>()
/** a BPMN model's diagram to show (the saved draft) */
const xml = ref<string>()
const bpmn = computed(() => model.value?.flowKind === 'bpmn')
const current = computed(
  () => versions.value.find((v) => v.id === model.value?.currentVersionId)?.version,
)
const loading = ref(false)
const busy = ref<'draft' | 'publish'>()
const designer = useTemplateRef<InstanceType<typeof WfDesigner>>('designer')
const bpmnDesigner = useTemplateRef<InstanceType<typeof WfBpmnDesigner>>('bpmnDesigner')
/** the tree as last loaded / saved: anything else is unsaved */
let saved = ''
/** the diagram as bpmn-js wrote it after the last import / save, and as it is now (unset until shown) */
let savedXml = ''
const shownXml = shallowRef<string>()
const ready = computed(() => (bpmn.value ? shownXml.value !== undefined : !!tree.value))
const dirty = () =>
  bpmn.value
    ? shownXml.value !== undefined && shownXml.value !== savedXml
    : !!tree.value && JSON.stringify(tree.value) !== saved

async function load() {
  loading.value = true
  try {
    const [m, v] = await Promise.all([wfModelApi.detail(id), wfModelApi.versions(id)])
    model.value = m
    versions.value = v
    fields.value = designFields(m, v)
    const begin = t('wf.designer.type.begin')
    if (m.flowKind === 'bpmn') xml.value = draftXml(m, begin)
    else {
      tree.value = draftTree(m.draftJson, begin)
      saved = JSON.stringify(tree.value)
    }
  } catch (e) {
    toastRest(e)
  } finally {
    loading.value = false
  }
}
void load()

function changed(text: string, imported: boolean) {
  shownXml.value = text
  if (imported) savedXml = text
}

/** the stored draft is no diagram bpmn-js draws: the new flow's in its place (else nothing could be done) */
function unreadable() {
  const fresh = draftXml({ ...model.value!, draftXml: null }, t('wf.designer.type.begin'))
  if (xml.value === fresh) return
  xml.value = fresh
  ElMessage.warning({
    message: t('wf.model.design.draftUnreadable'),
    showClose: true,
    duration: 0,
  })
}

/** a BPMN body the server would refuse unread (size, DOCTYPE): said here instead */
function refused(text: string, body?: object) {
  const code = bpmnRefusal(text, body)
  if (code) ElMessage.error(t(`validation.wf.${code}`))
  return !!code
}

/** a 400 names the node like the designer's check (fields changed meanwhile); a BPMN one marks it */
function failed(e: unknown) {
  if (e instanceof ApiError && e.status === 400 && e.errors?.length)
    bpmnDesigner.value?.mark(e.errors)
  toastRest(e)
}

async function saveDraft() {
  if (!ready.value || busy.value) return
  busy.value = 'draft'
  try {
    if (bpmn.value) {
      // the publish check marks what publishing would refuse; a draft may be half drawn
      bpmnDesigner.value!.validate()
      // edits made while it is sent stay unsaved
      const sent = await bpmnDesigner.value!.saveXml()
      if (refused(sent)) return
      await wfModelApi.saveDraftXml(id, sent)
      savedXml = sent
    } else {
      const sent = JSON.stringify(tree.value)
      await wfModelApi.saveDraft(id, tree.value!)
      saved = sent
    }
    ElMessage.success(t('wf.model.design.draftSaved'))
  } catch (e) {
    failed(e)
  } finally {
    busy.value = undefined
  }
}

async function publish() {
  const m = model.value
  if (!m || !ready.value || busy.value) return
  if (!(bpmn.value ? bpmnDesigner.value?.validate() : designer.value?.validate())) return
  const version = (versions.value[0]?.version ?? 0) + 1
  try {
    await ElMessageBox.confirm(
      t('wf.model.design.publishConfirm', { version }),
      t('wf.model.design.confirmTitle'),
      {
        type: 'warning',
        confirmButtonText: t('wf.model.design.publish'),
        cancelButtonText: t('common.action.cancel'),
      },
    )
  } catch {
    return
  }
  busy.value = 'publish'
  try {
    const sent = bpmn.value ? await bpmnDesigner.value!.saveXml() : undefined
    const body = publishBody(
      m,
      sent === undefined ? { tree: tree.value } : { xml: sent },
      fields.value,
    )
    if (sent !== undefined && refused(sent, body)) return
    const v = await wfModelApi.publish(id, body)
    if (sent !== undefined) savedXml = sent
    ElMessage.success(t('wf.model.design.published', { version: v.version }))
    // the draft is now the published flow, the version the current one
    await load()
  } catch (e) {
    failed(e)
  } finally {
    busy.value = undefined
  }
}

const file = useTemplateRef<HTMLInputElement>('file')
/** A file's diagram, or a version's JSON export drawn, replaces the canvas once confirmed. */
async function importFile() {
  const picked = file.value?.files?.[0]
  if (!picked || !bpmnDesigner.value) return
  // the same file can be picked again after a fix
  file.value!.value = ''
  const text = await picked.text()
  const json = jsonXml(text)
  const sent = json?.xml ?? text
  if (refused(sent)) return
  try {
    await ElMessageBox.confirm(
      h('div', [
        h('p', t('wf.model.design.importHint')),
        h('p', t('wf.model.design.importConfirm')),
      ]),
      t('wf.model.design.importTitle'),
      {
        type: 'warning',
        confirmButtonText: t('wf.model.design.import'),
        cancelButtonText: t('common.action.cancel'),
      },
    )
  } catch {
    return
  }
  const warnings = await bpmnDesigner.value.importXml(sent)
  if (!warnings) {
    ElMessage.error(t('wf.model.design.badFile'))
    return
  }
  if (json?.renamed.length)
    ElMessage.warning({
      message: t('wf.model.design.importRenamed', {
        ids: json.renamed.map(([from, to]) => `${from} → ${to}`).join(', '),
      }),
      showClose: true,
      duration: 0,
    })
  if (warnings.length)
    ElMessage.warning({
      message: h('div', [
        h('p', t('wf.model.design.importWarnings')),
        h(
          'ul',
          warnings.map((w) => h('li', w)),
        ),
      ]),
      showClose: true,
      duration: 0,
    })
}

/** The canvas as it is, `<model key>-draft.bpmn`. */
async function exportBpmn() {
  const text = await bpmnDesigner.value!.saveXml()
  saveBlob(new Blob([text], { type: 'application/xml' }), `${model.value!.modelKey}-draft.bpmn`)
}

async function back() {
  const path = route.path
  // the tag closes only once the page is left (the leave check may keep it)
  if (!(await router.push('/wf/models'))) tags.close((tag) => tag.path === path)
}

/** unsaved changes: ask before the page goes (another model's design page reuses the route, not the page) */
async function leaving() {
  if (!dirty()) return true
  try {
    await ElMessageBox.confirm(t('wf.model.design.leaveConfirm'), t('wf.model.design.leaveTitle'), {
      type: 'warning',
      confirmButtonText: t('wf.model.design.leave'),
      cancelButtonText: t('common.action.cancel'),
    })
    return true
  } catch {
    // staying: a tag closed on the way out comes back
    tags.open(route)
    return false
  }
}
onBeforeRouteLeave(leaving)
onBeforeRouteUpdate(leaving)
// a reload or a closed browser tab: the browser's own prompt
useEventListener(window, 'beforeunload', (e) => dirty() && e.preventDefault())
</script>

<template>
  <div
    class="qw-page wf-model-design"
    :class="{ 'wf-model-design--custom': model?.formKind === 'custom' }"
  >
    <div class="qw-page-bar">
      <span v-if="model" class="qw-page-bar__context wf-model-design__title">
        <Icon :icon="model.icon || 'lucide:file-text'" class="wf-model-design__icon" />
        <strong>{{ tx(model.name) }}</strong>
        <el-tag type="info" disable-transitions>
          {{ t(`wf.model.formKinds.${model.formKind}`) }}
        </el-tag>
        <el-tag v-if="current" type="success" disable-transitions>
          {{ t('wf.model.design.current', { version: current }) }}
        </el-tag>
        <el-tag v-else type="info" disable-transitions>{{ t('wf.model.list.no') }}</el-tag>
      </span>
      <el-button @click="back">
        <el-icon class="el-icon--left"><Icon icon="lucide:arrow-left" /></el-icon>
        {{ t('wf.model.design.back') }}
      </el-button>
      <template v-if="bpmn">
        <input
          ref="file"
          type="file"
          accept=".bpmn,.xml,.json,application/xml,text/xml,application/json"
          hidden
          :aria-label="t('wf.model.design.import')"
          @change="importFile"
        />
        <el-button :disabled="!ready || !!busy" @click="file?.click()">
          <el-icon class="el-icon--left"><Icon icon="lucide:upload" /></el-icon>
          {{ t('wf.model.design.import') }}
        </el-button>
        <el-button :disabled="!ready" @click="exportBpmn">
          <el-icon class="el-icon--left"><Icon icon="lucide:download" /></el-icon>
          {{ t('wf.model.design.exportBpmn') }}
        </el-button>
      </template>
      <el-button
        v-perm="wfPerms.model.modify"
        :disabled="!ready"
        :loading="busy === 'draft'"
        @click="saveDraft"
      >
        <el-icon class="el-icon--left"><Icon icon="lucide:save" /></el-icon>
        {{ t('wf.model.design.saveDraft') }}
      </el-button>
      <el-button
        v-perm="wfPerms.model.publish"
        type="primary"
        :disabled="!ready"
        :loading="busy === 'publish'"
        @click="publish"
      >
        <el-icon class="el-icon--left"><Icon icon="lucide:rocket" /></el-icon>
        {{ t('wf.model.design.publish') }}
      </el-button>
    </div>

    <div v-loading="loading" class="wf-model-design__canvas">
      <WfBpmnDesigner
        v-if="xml !== undefined"
        ref="bpmnDesigner"
        :xml
        :fields
        class="wf-model-design__designer"
        @change="changed"
        @unreadable="unreadable"
      />
      <WfDesigner
        v-else-if="tree"
        ref="designer"
        v-model="tree"
        :fields
        class="wf-model-design__designer"
      />
    </div>
  </div>
</template>

<style scoped>
.wf-model-design__title {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  min-width: 0;
}
.wf-model-design__icon {
  flex: none;
  color: var(--qw-text-3);
}
.wf-model-design__canvas {
  height: calc(100vh - 220px);
  min-height: 480px;
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius);
}
.wf-model-design__designer {
  height: 100%;
}
/*
 * Field access applies to dynamic forms only (see docs/design-notes.md#workflow): a custom form's business page decides what can
 * be edited. The node drawer renders inside the designer (not teleported).
 * Hidden by CSS; a WfDesigner prop would be the cleaner switch.
 */
.wf-model-design--custom :deep(.wf-access) {
  display: none;
}
</style>
