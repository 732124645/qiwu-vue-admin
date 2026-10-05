<script setup lang="ts">
import { computed, ref, shallowRef, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance } from 'element-plus'
import {
  PAGE_SIZE_MAX,
  WF_TEMPLATE_KEY_PREFIX,
  wfModelCreate,
  wfPerms,
  type FormSchema,
  type RoleOption,
  type WfFields,
  type WfModelVo,
} from '@qiwu/shared'
import { roleApi } from '@/api/platform/iam/role'
import { wfFormApi } from '@/api/workflow/form'
import { wfModelApi } from '@/api/workflow/model'
import DeptTreeSelect from '@/core/components/DeptTreeSelect.vue'
import DictSelect from '@/core/components/DictSelect.vue'
import IconPicker from '@/core/components/IconPicker.vue'
import { toastRest } from '@/core/composables/use-crud'
import { zodRules } from '@/core/form/zod-rules'
import { tx } from '@/core/i18n'
import { Icon } from '@/core/icons'
import { usePerm } from '@/core/permission'
import { ApiError } from '@/core/request/http'
import { useTagsStore } from '@/core/stores/tags'
import FormDesigner from '@/views/platform/formkit/FormDesigner.vue'
import WfDesigner from '../../designer/WfDesigner.vue'
import WfUserIds from '../../designer/WfUserIds.vue'
import {
  blankWizard,
  fieldsOf,
  saveWizard,
  templatesOf,
  WizardError,
  wizardOf,
  type Wizard,
  type WizardIds,
} from './wizard'

/**
 * 新建审批: one page over a dynamic model, its form and its flow, in four steps: basics
 * (name, category, icon, description, who may start it) → form (the form designer) → flow (the flow
 * designer, conditions over this form's fields) → advanced (process managers, cancel / withdraw switches).
 * 保存草稿 saves form, model and draft; 发布 saves form and model and publishes the flow as the next version;
 * a failed step offers a retry that goes on with what was saved (wizard.ts). 从模板创建 copies a built-in
 * template (key prefix `tpl-`) with its form. `/wf/wizard/:id` (模型管理's 向导, edit.vue) opens a
 * dynamic tree model; a BPMN one goes back to the list.
 */
defineOptions({ name: 'WfWizard' })
const { t, te } = useI18n()
const route = useRoute()
const router = useRouter()
const tags = useTagsStore()
const perm = usePerm()
/** the process managers can be changed */
const managers = perm.has(wfPerms.model.managers)
const editId = route.params.id ? Number(route.params.id) : undefined
/** this page's route (kept alive per path): the one current when a save ends may be another page's */
const path = route.path
const beginName = () => t('wf.designer.type.begin')

const STEPS = ['basics', 'form', 'flow', 'advanced'] as const
type Step = (typeof STEPS)[number]
const tab = ref<Step>('basics')
const w = ref<Wizard>(blankWizard(beginName()))
const ids = ref<WizardIds>({})
/** the form the designer opens with; `formKey` remounts it with a new one */
const schema = shallowRef<FormSchema>({ rule: [] })
const formKey = ref(0)
const fields = shallowRef<WfFields>({})
const loading = ref(false)
const busy = ref<'draft' | 'publish'>()
const basics = useTemplateRef<FormInstance>('basics')
const formDesigner = useTemplateRef<InstanceType<typeof FormDesigner>>('formDesigner')
const flowDesigner = useTemplateRef<InstanceType<typeof WfDesigner>>('flowDesigner')
const rules = zodRules(wfModelCreate, { t, te })
const scope = computed(() => w.value.initiatorScope)

/**
 * The calls a save makes, checked up front: the form and the model created or updated (by the ids saved so
 * far), then the draft (model modify) or the version (model publish). A model reopened here
 * (`/wf/wizard/:id`) saves once it loaded, never as a new one.
 */
const savePerms = computed(() => [
  ids.value.formId ? wfPerms.form.modify : wfPerms.form.create,
  ids.value.modelId ? wfPerms.model.modify : wfPerms.model.create,
])
const canDraft = computed(() => perm.all([...savePerms.value, wfPerms.model.modify]))
const canPublish = computed(() => perm.all([...savePerms.value, wfPerms.model.publish]))
const ready = computed(() => !editId || ids.value.modelId !== undefined)

const roles = shallowRef<RoleOption[]>([])
roleApi
  .options()
  .then((r) => (roles.value = r))
  .catch(() => undefined) // the request layer showed it

/** a template is copied from its detail and its form's */
const canCopy = computed(() =>
  perm.all([wfPerms.model.browse, wfPerms.model.view, wfPerms.form.view]),
)
const templates = shallowRef<WfModelVo[]>([])
if (!editId && canCopy.value)
  wfModelApi
    .page({ modelKey: WF_TEMPLATE_KEY_PREFIX, pageSize: PAGE_SIZE_MAX, sort: 'sortNo' })
    .then((p) => (templates.value = templatesOf(p.items)))
    .catch(() => undefined) // the request layer showed it

/** Opens model `id` (a template: `copy`, a new model once saved) with its form. */
async function load(id: number, copy: boolean) {
  loading.value = true
  try {
    const m = await wfModelApi.detail(id)
    // a BPMN model is drawn on its design page: back to the list
    if (m.flowKind !== 'tree') {
      ElMessage.warning(t('wf.model.list.wizardTreeOnly'))
      if (!copy && !(await router.push('/wf/models'))) tags.close((tag) => tag.path === path)
      return
    }
    if (m.formKind !== 'dynamic') {
      ElMessage.error(t('wf.wizard.notDynamic'))
      return
    }
    const form = m.formId ? (await wfFormApi.detail(m.formId)).schemaJson : { rule: [] }
    w.value = wizardOf(m, beginName(), copy, managers)
    ids.value = copy ? {} : { modelId: m.id, formId: m.formId ?? undefined }
    schema.value = form
    fields.value = fieldsOf(form) ?? {}
    formKey.value++
    tab.value = 'basics'
  } catch (e) {
    toastRest(e)
  } finally {
    loading.value = false
  }
}
if (editId) void load(editId, false)

async function fromTemplate(id: number) {
  // replaces what is typed so far
  if (w.value.name)
    try {
      await ElMessageBox.confirm(t('wf.wizard.replaceConfirm'), t('wf.wizard.fromTemplate'), {
        type: 'warning',
        confirmButtonText: t('wf.wizard.replace'),
        cancelButtonText: t('common.action.cancel'),
      })
    } catch {
      return
    }
  await load(id, true)
}

/** The form as designed (sanitized), its fields now the flow's; a form the whitelist refuses says why. */
function designedForm(): FormSchema | undefined {
  const r = formDesigner.value?.current()
  if (!r) return
  if ('reason' in r) {
    ElMessage.error(t('wf.wizard.badForm', { reason: r.reason }))
    return
  }
  fields.value = fieldsOf(r.schema) ?? {}
  return r.schema
}
// the flow step builds on the form as it is now
function onTab(name: string | number) {
  if (name === 'flow') designedForm()
}

/** A failed save step: true once the user asks to retry. */
async function retry(e: unknown): Promise<boolean> {
  const step = e instanceof WizardError ? e.step : 'form'
  const cause = e instanceof WizardError ? e.cause : e
  // not an answer of the server: the network failed (the request layer showed it too)
  const reason = cause instanceof ApiError ? cause.message : t('common.error.network')
  try {
    await ElMessageBox.confirm(
      t('wf.wizard.failed', { step: t(`wf.wizard.step.${step}`), reason }),
      t('wf.wizard.failedTitle'),
      {
        type: 'error',
        confirmButtonText: t('wf.wizard.retry'),
        cancelButtonText: t('common.action.cancel'),
      },
    )
    return true
  } catch {
    return false
  }
}

/** 保存草稿 / 发布: the steps checked first (each failing one shown), then form → model → draft / version. */
async function save(publish: boolean) {
  if (busy.value || loading.value || !ready.value) return
  const form = designedForm()
  if (!form) {
    tab.value = 'form'
    return
  }
  if (
    !(await basics.value?.validate().then(
      () => true,
      () => false,
    ))
  ) {
    tab.value = 'basics'
    return
  }
  if (publish && !flowDesigner.value?.validate()) {
    tab.value = 'flow'
    return
  }
  busy.value = publish ? 'publish' : 'draft'
  try {
    for (;;) {
      try {
        const { version } = await saveWizard(w.value, form, ids.value, publish, managers)
        if (!publish) {
          ElMessage.success(t('wf.wizard.draftSaved'))
          return
        }
        ElMessage.success(t('wf.wizard.published', { version }))
        break
      } catch (e) {
        if (!(await retry(e))) return
      }
    }
  } finally {
    busy.value = undefined
  }
  // published: the model list; a new wizard starts blank next time (the page is kept alive), a reopened
  // model's stays on that model (its ids kept: a later save updates it)
  if (!editId) {
    w.value = blankWizard(beginName())
    ids.value = {}
    schema.value = { rule: [] }
    fields.value = {}
    formKey.value++
  }
  tab.value = 'basics'
  if (await router.push('/wf/models')) return
  tags.close((tag) => tag.path === path)
}
</script>

<template>
  <div v-loading="loading" class="qw-page wf-wizard">
    <div class="qw-page-bar">
      <span class="qw-page-bar__context wf-wizard__title">
        <Icon :icon="w.icon || 'lucide:file-text'" class="wf-wizard__icon" />
        <strong>{{ w.name ? tx(w.name) : t('wf.wizard.untitled') }}</strong>
        <el-tag v-if="ids.modelId" type="info" disable-transitions>
          {{ t('wf.wizard.saved') }}
        </el-tag>
      </span>
      <el-dropdown
        v-if="!editId && !ids.modelId && templates.length"
        trigger="click"
        @command="fromTemplate"
      >
        <el-button>
          <el-icon class="el-icon--left"><Icon icon="lucide:copy-plus" /></el-icon>
          {{ t('wf.wizard.fromTemplate') }}
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item v-for="m in templates" :key="m.id" :command="m.id">
              <Icon :icon="m.icon || 'lucide:file-text'" class="wf-wizard__icon" />
              {{ tx(m.name) }}
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <el-button
        v-if="canDraft"
        :disabled="!ready"
        :loading="busy === 'draft'"
        @click="save(false)"
      >
        <el-icon class="el-icon--left"><Icon icon="lucide:save" /></el-icon>
        {{ t('wf.wizard.saveDraft') }}
      </el-button>
      <el-button
        v-if="canPublish"
        type="primary"
        :disabled="!ready"
        :loading="busy === 'publish'"
        @click="save(true)"
      >
        <el-icon class="el-icon--left"><Icon icon="lucide:rocket" /></el-icon>
        {{ t('wf.wizard.publish') }}
      </el-button>
    </div>

    <el-tabs v-model="tab" class="wf-wizard__tabs" @tab-change="onTab">
      <el-tab-pane
        v-for="(s, i) in STEPS"
        :key="s"
        :name="s"
        :label="t('wf.wizard.tab', { n: i + 1, name: t(`wf.wizard.steps.${s}`) })"
      />
    </el-tabs>

    <el-form
      v-show="tab === 'basics'"
      ref="basics"
      :model="w"
      :rules="rules"
      label-position="left"
      label-width="120px"
      class="wf-wizard__settings"
    >
      <el-form-item :label="t('field.wf.model.name')" prop="name">
        <el-input v-model="w.name" maxlength="128" />
      </el-form-item>
      <el-form-item :label="t('field.wf.model.category')" prop="category">
        <DictSelect v-model="w.category" code="wf.category" :clearable="false" />
      </el-form-item>
      <el-form-item :label="t('field.wf.model.icon')" prop="icon">
        <IconPicker v-model="w.icon" />
      </el-form-item>
      <el-form-item :label="t('field.wf.model.description')" prop="description">
        <el-input v-model="w.description" type="textarea" :rows="3" maxlength="500" />
      </el-form-item>
      <el-form-item :label="t('field.wf.model.initiatorScope')">
        <div class="wf-wizard__scope">
          <p class="wf-wizard__hint">{{ t('wf.model.form.scopeHint') }}</p>
          <el-form-item :label="t('field.wf.model.userIds')">
            <WfUserIds v-model="scope.userIds" />
          </el-form-item>
          <el-form-item :label="t('field.wf.model.deptIds')">
            <DeptTreeSelect v-model="scope.deptIds" multiple />
          </el-form-item>
          <el-form-item :label="t('field.wf.model.roleIds')">
            <el-select v-model="scope.roleIds" multiple filterable name="roleIds">
              <el-option v-for="r in roles" :key="r.id" :label="tx(r.name)" :value="r.id" />
            </el-select>
          </el-form-item>
        </div>
      </el-form-item>
    </el-form>

    <!-- mounted from the start: the form is read from it on any step -->
    <FormDesigner
      v-show="tab === 'form'"
      ref="formDesigner"
      :key="formKey"
      :schema
      class="wf-wizard__form"
    />

    <div v-show="tab === 'flow'" class="wf-wizard__canvas">
      <p class="wf-wizard__hint">{{ t('wf.wizard.flowHint') }}</p>
      <WfDesigner ref="flowDesigner" v-model="w.tree" :fields class="wf-wizard__designer" />
    </div>

    <el-form
      v-show="tab === 'advanced'"
      :model="w"
      label-position="left"
      label-width="120px"
      class="wf-wizard__settings"
    >
      <el-form-item :label="t('field.wf.model.managerUserIds')">
        <WfUserIds v-model="w.managerUserIds" :disabled="!managers" />
        <p class="wf-wizard__hint">{{ t('wf.model.form.managersHint') }}</p>
        <p v-if="!managers" class="wf-wizard__hint">{{ t('wf.model.form.managersLocked') }}</p>
      </el-form-item>
      <el-form-item :label="t('field.wf.model.allowCancel')">
        <el-switch v-model="w.allowCancel" />
      </el-form-item>
      <el-form-item :label="t('field.wf.model.allowWithdraw')">
        <el-switch v-model="w.allowWithdraw" />
      </el-form-item>
    </el-form>
  </div>
</template>

<style scoped>
.wf-wizard__title {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  min-width: 0;
}
.wf-wizard__icon {
  flex: none;
  margin-right: 4px;
  color: var(--qw-text-3);
}
.wf-wizard__tabs :deep(.el-tabs__header) {
  margin-bottom: 16px;
}
.wf-wizard__settings {
  max-width: 720px;
}
.wf-wizard__scope {
  width: 100%;
}
.wf-wizard__scope .el-form-item {
  margin-bottom: 12px;
}
.wf-wizard__hint {
  width: 100%;
  margin: 0 0 8px;
  font-size: 12px;
  line-height: 18px;
  color: var(--qw-text-3);
}
.wf-wizard .wf-wizard__form {
  height: calc(100vh - 250px);
}
.wf-wizard__canvas {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 250px);
  min-height: 360px;
}
.wf-wizard__designer {
  flex: 1;
  min-height: 0;
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius);
}
</style>
