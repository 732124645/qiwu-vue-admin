<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  WF_ASSIGNEE_ID_KINDS,
  WF_ASSIGNEE_KINDS,
  type PositionOption,
  type RoleOption,
  type WfAssignee,
  type WfAssigneeKind,
  type WfFields,
  type WfFieldType,
} from '@qiwu/shared'
import { positionApi } from '@/api/platform/iam/position'
import { roleApi } from '@/api/platform/iam/role'
import DeptTreeSelect from '@/core/components/DeptTreeSelect.vue'
import { tx } from '@/core/i18n'
import WfUserIds from './WfUserIds.vue'

/**
 * Who a review / notify node goes to (11 kinds; see docs/design-notes.md#workflow); `v-model` = the assignee, replaced on each change.
 * `reorder`: specific users can be put in order (a review's order for `ordered` sign).
 */
defineOptions({ name: 'WfAssignee' })
const model = defineModel<WfAssignee>({ required: true })
const { fields, reorder = false } = defineProps<{ fields: WfFields; reorder?: boolean }>()
const { t } = useI18n()

const FIELD_TYPE: Partial<Record<WfAssigneeKind, WfFieldType>> = {
  formFieldUser: 'user',
  formFieldDeptHead: 'dept',
}
const fieldType = computed(() => FIELD_TYPE[model.value.kind])
const fieldsOf = (type: WfFieldType) => Object.keys(fields).filter((f) => fields[f] === type)

/** a kind switch starts over: its ids to pick, one level of heads, the first form field of its type */
function setKind(kind: WfAssigneeKind) {
  const next: WfAssignee = { kind }
  if ((WF_ASSIGNEE_ID_KINDS as readonly string[]).includes(kind)) next.ids = []
  if (kind === 'deptHeadChain') next.levels = 1
  const type = FIELD_TYPE[kind]
  const field = type && fieldsOf(type)[0]
  if (field) next.field = field
  model.value = next
}
const ids = computed({
  get: () => model.value.ids ?? [],
  set: (v: number[]) => (model.value = { ...model.value, ids: v }),
})
const levels = computed({
  get: () => model.value.levels ?? 1,
  set: (v: number) => (model.value = { ...model.value, levels: v }),
})
/** no `levels` = up to the top dept (the engine's reading) */
const toTop = computed({
  get: () => model.value.levels == null,
  set: (on: boolean) => {
    const next: WfAssignee = { ...model.value, levels: 1 }
    if (on) delete next.levels
    model.value = next
  },
})
const field = computed({
  get: () => model.value.field,
  set: (v?: string) => (model.value = { ...model.value, field: v }),
})

const roles = shallowRef<RoleOption[]>([])
const positions = shallowRef<PositionOption[]>([])
watch(
  () => model.value.kind,
  (kind) => {
    if (kind === 'roles' && !roles.value.length)
      roleApi
        .options()
        .then((r) => (roles.value = r))
        .catch(() => undefined) // the request layer showed it
    if (kind === 'positions' && !positions.value.length)
      positionApi
        .options()
        .then((p) => (positions.value = p))
        .catch(() => undefined)
  },
  { immediate: true },
)
</script>

<template>
  <el-form-item :label="t('wf.designer.assignee.kind')">
    <el-radio-group
      :model-value="model.kind"
      class="qw-radio-grid"
      @change="(k: WfAssigneeKind) => setKind(k)"
    >
      <el-radio v-for="k in WF_ASSIGNEE_KINDS" :key="k" :value="k">
        {{ t(`wf.designer.assignee.kinds.${k}`) }}
      </el-radio>
    </el-radio-group>
    <p class="wf-assignee__hint">{{ t(`wf.designer.assignee.hints.${model.kind}`) }}</p>
  </el-form-item>

  <el-form-item v-if="model.kind === 'users'" :label="t('wf.designer.assignee.users')">
    <WfUserIds v-model="ids" :reorder />
    <p v-if="reorder" class="wf-assignee__hint">{{ t('wf.designer.assignee.orderHint') }}</p>
  </el-form-item>
  <el-form-item v-else-if="model.kind === 'roles'" :label="t('wf.designer.assignee.roles')">
    <el-select
      v-model="ids"
      multiple
      filterable
      name="roles"
      :placeholder="t('wf.designer.assignee.rolesPlaceholder')"
    >
      <el-option v-for="r in roles" :key="r.id" :label="tx(r.name)" :value="r.id" />
    </el-select>
  </el-form-item>
  <el-form-item v-else-if="model.kind === 'positions'" :label="t('wf.designer.assignee.positions')">
    <el-select
      v-model="ids"
      multiple
      filterable
      name="positions"
      :placeholder="t('wf.designer.assignee.positionsPlaceholder')"
    >
      <el-option v-for="p in positions" :key="p.id" :label="tx(p.name)" :value="p.id" />
    </el-select>
  </el-form-item>
  <el-form-item
    v-else-if="model.kind === 'deptMembers' || model.kind === 'deptHead'"
    :label="t('wf.designer.assignee.depts')"
  >
    <DeptTreeSelect v-model="ids" multiple />
  </el-form-item>
  <el-form-item
    v-else-if="model.kind === 'deptHeadChain'"
    :label="t('wf.designer.assignee.levels')"
  >
    <el-checkbox v-model="toTop" name="toTop">{{ t('wf.designer.assignee.toTop') }}</el-checkbox>
    <el-input-number
      v-if="!toTop"
      v-model="levels"
      class="wf-assignee__levels"
      name="levels"
      :min="1"
      :max="20"
      step-strictly
      value-on-clear="min"
      controls-position="right"
    />
  </el-form-item>
  <el-form-item v-else-if="fieldType" :label="t('wf.designer.assignee.field')">
    <el-select v-if="fieldsOf(fieldType).length" v-model="field" name="field">
      <el-option v-for="f in fieldsOf(fieldType)" :key="f" :label="f" :value="f" />
    </el-select>
    <p v-else class="wf-assignee__missing">
      {{ t('wf.designer.assignee.noField', { type: t(`wf.designer.fieldTypes.${fieldType}`) }) }}
    </p>
  </el-form-item>
</template>

<style scoped>
.wf-assignee__hint,
.wf-assignee__missing {
  width: 100%;
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--qw-text-3);
}
.wf-assignee__missing {
  color: var(--qw-danger);
}
.wf-assignee__levels {
  margin-left: 16px;
}
</style>
