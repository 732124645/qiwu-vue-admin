<script setup lang="ts">
import { computed, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  PAGE_SIZE_MAX,
  WF_FLOW_KINDS,
  WF_FORM_KINDS,
  wfModelCreate,
  wfPerms,
  type RoleOption,
  type WfFormVo,
  type WfInitiatorScope,
  type WfModelCreate,
} from '@qiwu/shared'
import { roleApi } from '@/api/platform/iam/role'
import { wfFormApi } from '@/api/workflow/form'
import { wfModelApi } from '@/api/workflow/model'
import DeptTreeSelect from '@/core/components/DeptTreeSelect.vue'
import DictSelect from '@/core/components/DictSelect.vue'
import IconPicker from '@/core/components/IconPicker.vue'
import { useCrudForm } from '@/core/composables/use-crud'
import { tx } from '@/core/i18n'
import { usePerm } from '@/core/permission'
import WfUserIds from '../designer/WfUserIds.vue'
import { hasView, toBody, toForm } from './model-list'

/**
 * Add / edit form of 模型管理, opened with `openDialog(WfModelForm, { id })`: the model's key, form
 * type and process type (tree or BPMN designer) are fixed once added (a custom model's view
 * component one of the web's views); a dynamic model's form (`wf_form`, publishing takes its fields and layout); who may start it
 * (users, depts with their subtrees, roles; none = everyone), its process managers (changed only with
 * `wf.model.managers`) and whether the initiator may cancel / an approver withdraw.
 */
defineOptions({ name: 'WfModelForm' })
const { id } = defineProps<{ id?: number }>()
const emit = defineEmits<{ done: [saved: Form & { id: number }]; cancel: [] }>()
const { t } = useI18n()
const perm = usePerm()
const managers = perm.has(wfPerms.model.managers)

type Form = WfModelCreate & { initiatorScope: WfInitiatorScope; managerUserIds: number[] }
const { model, formRef, rules, loading, submitting, submit } = useCrudForm({
  api: {
    get: (id: number) => wfModelApi.get(id).then(toForm),
    create: (m: Form) => wfModelApi.create(toBody(m, managers)),
    update: (id: number, m: Form) => wfModelApi.update(id, toBody(m, managers)),
  },
  schema: wfModelCreate,
  emptyModel: () => ({
    modelKey: '',
    name: '',
    // the dict's default entry (and the column's)
    category: 'other',
    icon: '',
    description: '',
    formKind: 'dynamic' as const,
    flowKind: 'tree' as const,
    formId: null,
    createRoute: null,
    viewComponent: null,
    initiatorScope: { userIds: [], deptIds: [], roleIds: [] },
    managerUserIds: [],
    allowCancel: true,
    allowWithdraw: true,
    enabled: true,
    sortNo: 0,
  }),
  id,
  emit,
})
// replaced as a whole when the model loads
const scope = computed(() => model.initiatorScope)
// the instance detail loads it through the views glob (viewLoader): it must be one of them
rules.viewComponent!.push({
  trigger: 'blur',
  validator: (_rule, path: string | null, callback) =>
    !path || hasView(path) ? callback() : callback(new Error(t('wf.model.form.noView', { path }))),
})

/** the forms a dynamic model binds (a disabled one stays shown when bound); none without `wf.form.browse` */
const forms = shallowRef<WfFormVo[]>([])
if (perm.has(wfPerms.form.browse))
  wfFormApi
    .page({ pageSize: PAGE_SIZE_MAX, sort: 'name' })
    .then((p) => (forms.value = p.items))
    .catch(() => undefined) // the request layer showed it

const roles = shallowRef<RoleOption[]>([])
roleApi
  .options()
  .then((r) => (roles.value = r))
  .catch(() => undefined) // the request layer showed it
</script>

<template>
  <el-form ref="formRef" v-loading="loading" :model="model" :rules="rules" label-position="left">
    <el-form-item :label="t('field.wf.model.modelKey')" prop="modelKey">
      <el-input v-model="model.modelKey" maxlength="64" :disabled="id != null" />
    </el-form-item>
    <el-form-item :label="t('field.wf.model.name')" prop="name">
      <el-input v-model="model.name" maxlength="128" />
    </el-form-item>
    <el-form-item :label="t('field.wf.model.category')" prop="category">
      <DictSelect v-model="model.category" code="wf.category" :clearable="false" />
    </el-form-item>
    <el-form-item :label="t('field.wf.model.icon')" prop="icon">
      <IconPicker v-model="model.icon" />
    </el-form-item>
    <el-form-item :label="t('field.wf.model.formKind')" prop="formKind">
      <el-radio-group v-model="model.formKind" :disabled="id != null">
        <el-radio v-for="k in WF_FORM_KINDS" :key="k" :value="k">
          {{ t(`wf.model.formKinds.${k}`) }}
        </el-radio>
      </el-radio-group>
    </el-form-item>
    <el-form-item :label="t('field.wf.model.flowKind')" prop="flowKind">
      <el-radio-group v-model="model.flowKind" :disabled="id != null">
        <el-radio v-for="k in WF_FLOW_KINDS" :key="k" :value="k">
          {{ t(`wf.model.flowKinds.${k}`) }}
        </el-radio>
      </el-radio-group>
      <p class="wf-model-form__hint">{{ t('wf.model.form.flowKindHint') }}</p>
    </el-form-item>
    <template v-if="model.formKind === 'custom'">
      <el-form-item :label="t('field.wf.model.createRoute')" prop="createRoute">
        <el-input v-model="model.createRoute" maxlength="255" placeholder="/biz/leave/new" />
      </el-form-item>
      <el-form-item :label="t('field.wf.model.viewComponent')" prop="viewComponent">
        <el-input v-model="model.viewComponent" maxlength="255" placeholder="biz/leave/view" />
      </el-form-item>
    </template>
    <el-form-item v-else :label="t('field.wf.model.formId')" prop="formId">
      <el-select v-model="model.formId" clearable filterable name="formId">
        <el-option
          v-for="f in forms"
          :key="f.id"
          :label="tx(f.name)"
          :value="f.id"
          :disabled="!f.enabled && f.id !== model.formId"
        />
      </el-select>
      <p class="wf-model-form__hint">{{ t('wf.model.form.formHint') }}</p>
    </el-form-item>
    <el-form-item :label="t('field.wf.model.initiatorScope')" prop="initiatorScope">
      <div class="wf-model-form__scope">
        <p class="wf-model-form__hint">{{ t('wf.model.form.scopeHint') }}</p>
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
    <el-form-item :label="t('field.wf.model.managerUserIds')" prop="managerUserIds">
      <WfUserIds v-model="model.managerUserIds" :disabled="!managers" />
      <p class="wf-model-form__hint">{{ t('wf.model.form.managersHint') }}</p>
      <p v-if="!managers" class="wf-model-form__hint">{{ t('wf.model.form.managersLocked') }}</p>
    </el-form-item>
    <el-form-item :label="t('field.wf.model.allowCancel')" prop="allowCancel">
      <el-switch v-model="model.allowCancel" />
    </el-form-item>
    <el-form-item :label="t('field.wf.model.allowWithdraw')" prop="allowWithdraw">
      <el-switch v-model="model.allowWithdraw" />
    </el-form-item>
    <el-form-item :label="t('field.wf.model.enabled')" prop="enabled">
      <el-switch v-model="model.enabled" />
    </el-form-item>
    <el-form-item :label="t('field.wf.model.sortNo')" prop="sortNo">
      <el-input-number v-model="model.sortNo" :min="0" :max="999999" controls-position="right" />
    </el-form-item>
    <el-form-item :label="t('field.wf.model.description')" prop="description">
      <el-input
        v-model="model.description"
        type="textarea"
        :rows="3"
        maxlength="500"
        show-word-limit
      />
    </el-form-item>
  </el-form>
  <div class="qw-dialog-footer">
    <el-button @click="emit('cancel')">{{ t('common.action.cancel') }}</el-button>
    <el-button type="primary" :loading="submitting" @click="submit">
      {{ t('crud.action.save') }}
    </el-button>
  </div>
</template>

<style scoped>
.wf-model-form__scope {
  width: 100%;
}
.wf-model-form__scope .el-form-item {
  margin-bottom: 12px;
}
.wf-model-form__hint {
  width: 100%;
  margin: 0 0 8px;
  font-size: 12px;
  line-height: 18px;
  color: var(--qw-text-3);
}
</style>
