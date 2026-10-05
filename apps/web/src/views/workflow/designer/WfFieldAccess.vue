<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { WF_FIELD_ACCESS, type WfFieldAccess, type WfFields } from '@qiwu/shared'

type Access = (typeof WF_FIELD_ACCESS)[number]

/**
 * Field access of a begin / review node (dynamic forms; see docs/design-notes.md#workflow): each form field editable, read-only or
 * hidden for whoever holds the node's task; a field not set reads as read-only. `v-model` = `node.access`.
 */
defineOptions({ name: 'WfFieldAccess' })
const access = defineModel<WfFieldAccess>()
const { fields } = defineProps<{ fields: WfFields }>()
const { t } = useI18n()

const rows = computed(() => Object.keys(fields).map((field) => ({ field })))
const valueOf = (field: string): Access => access.value?.[field] ?? 'read'
const set = (field: string, v: Access) => (access.value = { ...access.value, [field]: v })
const setAll = (v: Access) =>
  (access.value = Object.fromEntries(rows.value.map((r) => [r.field, v])))
</script>

<template>
  <el-form-item :label="t('wf.designer.access.title')" class="wf-access">
    <el-table :data="rows" size="small" :empty-text="t('wf.designer.access.empty')">
      <el-table-column prop="field" :label="t('wf.designer.access.field')" min-width="120" />
      <el-table-column v-for="v in WF_FIELD_ACCESS" :key="v" width="108" align="center">
        <template #header>
          <el-button
            link
            type="primary"
            :disabled="!rows.length"
            :title="t('wf.designer.access.setAll', { access: t(`wf.designer.access.${v}`) })"
            @click="setAll(v)"
          >
            {{ t(`wf.designer.access.${v}`) }}
          </el-button>
        </template>
        <template #default="{ row }">
          <el-radio
            :model-value="valueOf(row.field)"
            :value="v"
            :name="`access-${row.field}`"
            @change="set(row.field, v)"
          >
            <span class="wf-access__name">{{ row.field }} {{ t(`wf.designer.access.${v}`) }}</span>
          </el-radio>
        </template>
      </el-table-column>
    </el-table>
  </el-form-item>
</template>

<style scoped>
.wf-access :deep(.el-table) {
  width: 100%;
}
.wf-access :deep(.el-radio) {
  margin-right: 0;
}
/* the radio's name is for screen readers; the row and column show it */
.wf-access__name {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
