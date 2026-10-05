<script setup lang="ts">
import { computed, shallowRef, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  WF_FIELD_OPS,
  WF_INITIATOR_OPS,
  type RoleOption,
  type WfCondition,
  type WfFields,
  type WfOp,
} from '@qiwu/shared'
import { roleApi } from '@/api/platform/iam/role'
import DeptTreeSelect from '@/core/components/DeptTreeSelect.vue'
import IconButton from '@/core/components/IconButton.vue'
import UserSelect from '@/core/components/UserSelect.vue'
import { tx } from '@/core/i18n'
import WfUserIds from './WfUserIds.vue'
import { INITIATOR_LABEL, LIST_OPS } from './tree'
import { useUserNames } from './user-names'

/**
 * A fork path's conditions (see docs/design-notes.md#workflow): OR of AND groups over the form `fields` (each type offers its own
 * ops) plus the initiator's department (subtrees included) and roles. `v-model` = `path.when`,
 * edited in place; a group is dropped with its last condition.
 */
defineOptions({ name: 'WfCondBuilder' })
const when = defineModel<WfCondition[][]>({ required: true })
const { fields } = defineProps<{ fields: WfFields }>()
const { t } = useI18n()

const isInitiator = (f: string): f is keyof typeof WF_INITIATOR_OPS =>
  Object.hasOwn(WF_INITIATOR_OPS, f)
const formFields = computed(() => Object.keys(fields))

function opsOf(field: string): readonly WfOp[] {
  if (isInitiator(field)) return [WF_INITIATOR_OPS[field]]
  const type = fields[field]
  return type ? WF_FIELD_OPS[type] : []
}
const isList = (op: WfOp) => LIST_OPS.includes(op)
function blank(field = formFields.value[0] ?? '$initiator.dept'): WfCondition {
  const op = opsOf(field)[0] ?? 'eq'
  return { field, op, value: isList(op) ? [] : '' }
}

const addGroup = () => when.value.push([blank()])
function removeCond(group: WfCondition[], k: number) {
  group.splice(k, 1)
  if (!group.length) when.value.splice(when.value.indexOf(group), 1)
}
/** a new field starts with its first op and no value */
const setField = (c: WfCondition, field: string) => Object.assign(c, blank(field))
function setOp(c: WfCondition, op: WfOp) {
  if (isList(op) !== isList(c.op)) c.value = isList(op) ? [] : ''
  c.op = op
}

/** which value input a condition gets */
function editor(c: WfCondition) {
  if (c.field === '$initiator.dept') return 'depts'
  if (c.field === '$initiator.roles') return 'roles'
  const type = fields[c.field] ?? 'string'
  return isList(c.op) ? `${type}s` : type
}
const numberOrNull = (v: WfCondition['value']) => (typeof v === 'number' ? v : null)
const list = (v: WfCondition['value']) => (Array.isArray(v) ? v : [])
const ids = (v: WfCondition['value']) => list(v).filter((x): x is number => typeof x === 'number')
const texts = (v: WfCondition['value']) => list(v).map(String)
const numbers = (v: string[] | undefined) => (v ?? []).map(Number).filter((n) => Number.isFinite(n))
// the names of "user equals" values saved earlier
const userNames = useUserNames(() =>
  when.value
    .flat()
    .flatMap((c) => (editor(c) === 'user' && typeof c.value === 'number' ? [c.value] : [])),
)

const roles = shallowRef<RoleOption[]>()
watchEffect(() => {
  if (roles.value || !when.value.some((g) => g.some((c) => c.field === '$initiator.roles'))) return
  roles.value = []
  roleApi
    .options()
    .then((r) => (roles.value = r))
    .catch(() => undefined) // the request layer showed it
})
</script>

<template>
  <div class="wf-cond">
    <p class="wf-cond__hint">{{ t('wf.designer.cond.hint') }}</p>
    <template v-for="(group, g) in when" :key="g">
      <div v-if="g" class="wf-cond__or">{{ t('wf.designer.cond.or') }}</div>
      <fieldset class="wf-cond__group">
        <legend class="wf-cond__legend">{{ t('wf.designer.cond.group', { n: g + 1 }) }}</legend>
        <template v-for="(c, k) in group" :key="k">
          <div v-if="k" class="wf-cond__and">{{ t('wf.designer.cond.and') }}</div>
          <div class="wf-cond__row">
            <el-select
              :model-value="c.field"
              class="wf-cond__field"
              filterable
              :aria-label="t('wf.designer.cond.field')"
              @update:model-value="(f: string) => setField(c, f)"
            >
              <el-option-group v-if="formFields.length" :label="t('wf.designer.cond.formFields')">
                <el-option v-for="f in formFields" :key="f" :label="f" :value="f">
                  {{ f }}
                  <span class="wf-cond__type">{{ t(`wf.designer.fieldTypes.${fields[f]}`) }}</span>
                </el-option>
              </el-option-group>
              <el-option-group :label="t('wf.designer.cond.initiator')">
                <el-option
                  v-for="(key, f) in INITIATOR_LABEL"
                  :key="f"
                  :label="t(key)"
                  :value="f"
                />
              </el-option-group>
            </el-select>
            <el-select
              :model-value="c.op"
              class="wf-cond__op"
              :aria-label="t('wf.designer.cond.op')"
              @update:model-value="(op: WfOp) => setOp(c, op)"
            >
              <el-option
                v-for="op in opsOf(c.field)"
                :key="op"
                :label="t(`wf.designer.op.${op}`)"
                :value="op"
              />
            </el-select>
            <div class="wf-cond__value">
              <el-input-number
                v-if="editor(c) === 'number'"
                :model-value="numberOrNull(c.value)"
                controls-position="right"
                :aria-label="t('wf.designer.cond.value')"
                @update:model-value="(v?: number | null) => (c.value = v ?? '')"
              />
              <el-date-picker
                v-else-if="editor(c) === 'date'"
                :model-value="typeof c.value === 'string' ? c.value : ''"
                type="date"
                value-format="YYYY-MM-DD"
                :aria-label="t('wf.designer.cond.value')"
                @update:model-value="(v: string | null) => (c.value = v ?? '')"
              />
              <UserSelect
                v-else-if="editor(c) === 'user'"
                :model-value="numberOrNull(c.value)"
                :label="typeof c.value === 'number' ? userNames.get(c.value) : null"
                @update:model-value="(v) => (c.value = v ?? '')"
              />
              <WfUserIds
                v-else-if="editor(c) === 'users'"
                :model-value="ids(c.value)"
                @update:model-value="(v) => (c.value = v)"
              />
              <DeptTreeSelect
                v-else-if="editor(c) === 'dept'"
                :model-value="numberOrNull(c.value)"
                :aria-label="t('wf.designer.cond.value')"
                @update:model-value="(v) => (c.value = typeof v === 'number' ? v : '')"
              />
              <DeptTreeSelect
                v-else-if="editor(c) === 'depts'"
                :model-value="ids(c.value)"
                multiple
                :aria-label="t('wf.designer.cond.value')"
                @update:model-value="(v) => (c.value = Array.isArray(v) ? v : [])"
              />
              <el-select
                v-else-if="editor(c) === 'roles'"
                :model-value="ids(c.value)"
                multiple
                filterable
                :aria-label="t('wf.designer.cond.value')"
                :placeholder="t('wf.designer.assignee.rolesPlaceholder')"
                @update:model-value="(v: number[]) => (c.value = v)"
              >
                <el-option v-for="r in roles" :key="r.id" :label="tx(r.name)" :value="r.id" />
              </el-select>
              <el-input-tag
                v-else-if="editor(c) === 'numbers' || editor(c) === 'strings'"
                :model-value="texts(c.value)"
                :placeholder="t('wf.designer.cond.values')"
                :aria-label="t('wf.designer.cond.value')"
                @update:model-value="
                  (v?: string[]) => (c.value = editor(c) === 'numbers' ? numbers(v) : (v ?? []))
                "
              />
              <el-input
                v-else
                :model-value="String(c.value)"
                :aria-label="t('wf.designer.cond.value')"
                @update:model-value="(v: string) => (c.value = v)"
              />
            </div>
            <IconButton
              icon="lucide:x"
              :label="t('wf.designer.cond.remove')"
              @click="removeCond(group, k)"
            />
          </div>
        </template>
        <el-button link type="primary" @click="group.push(blank())">
          {{ t('wf.designer.cond.addCond') }}
        </el-button>
      </fieldset>
    </template>
    <el-button @click="addGroup">
      {{ t('wf.designer.cond.addGroup') }}
    </el-button>
  </div>
</template>

<style scoped>
.wf-cond {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
  margin-bottom: 18px;
}
.wf-cond__hint {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--qw-text-3);
}
.wf-cond__group {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
  width: 100%;
  min-width: 0;
  padding: 8px 12px 10px;
  margin: 0;
  container-type: inline-size;
  background: var(--qw-surface-2);
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius-sm);
}
.wf-cond__legend {
  padding: 0 4px;
  font-size: 12px;
  color: var(--qw-text-2);
}
.wf-cond__row {
  display: flex;
  gap: 6px;
  align-items: center;
  width: 100%;
}
.wf-cond__field {
  flex: 0 0 140px;
}
.wf-cond__op {
  flex: 0 0 136px;
}
.wf-cond__value {
  flex: 1;
  min-width: 0;
}
.wf-cond__value > * {
  width: 100%;
}
.wf-cond__type {
  float: right;
  margin-left: 12px;
  font-size: 12px;
  color: var(--qw-text-3);
}
.wf-cond__and,
.wf-cond__or {
  font-size: 12px;
  font-weight: 600;
  color: var(--qw-text-2);
}
.wf-cond__or {
  align-self: center;
  color: var(--qw-brand-text);
}
/* the BPMN settings panel is narrower than the tree designer's drawer: there the value goes below */
@container (max-width: 400px) {
  .wf-cond__row {
    flex-wrap: wrap;
  }
  .wf-cond__field,
  .wf-cond__op {
    flex: 1 1 calc(50% - 3px);
    min-width: 0;
  }
  .wf-cond__value {
    flex-basis: calc(100% - 38px);
  }
}
</style>
