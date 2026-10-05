<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import type { CgImportableVo, CgImportVo } from '@qiwu/shared'
import { codegenApi } from '@/api/platform/codegen'
import EmptyState from '@/core/components/EmptyState.vue'

/**
 * Import dialog of the generator list (`openDialog` content): the tables of this database not imported yet
 * (the server leaves out framework tables `meta_` / `test_` / `cg_`), filtered here by name or comment;
 * the ticked ones are imported in one request (all or none), `done` with the new config ids. A table
 * without `deleted_at` cannot be ticked, the reason in its row (the server refuses it: 422 C3010).
 */
defineOptions({ name: 'CodegenImportTables' })
const emit = defineEmits<{ done: [result: CgImportVo]; cancel: [] }>()
const { t } = useI18n()

const tables = shallowRef<CgImportableVo[]>([])
const loading = ref(true)
codegenApi
  .importable()
  .then((list) => (tables.value = list))
  .catch(() => undefined) // toasted by the request layer
  .finally(() => (loading.value = false))

const keyword = ref('')
const shown = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  return k
    ? tables.value.filter((r) => `${r.tableName} ${r.tableComment}`.toLowerCase().includes(k))
    : tables.value
})
const picked = shallowRef<CgImportableVo[]>([])

const submitting = ref(false)
async function submit() {
  if (!picked.value.length || submitting.value) return
  submitting.value = true
  try {
    const result = await codegenApi.import(picked.value.map((r) => r.tableName))
    ElMessage.success(t('codegen.table.import.done', { count: result.ids.length }))
    // a unique key without alive: imported anyway, fix the DDL; no menu group of its own yet: its parent is biz
    const texts = {
      alive: 'codegen.table.import.noAlive',
      parent_menu: 'codegen.table.import.noParentMenu',
    }
    for (const h of result.hints)
      ElMessage.warning({
        message: t(texts[h.missing], { table: h.tableName, key: h.key }),
        duration: 10_000,
        showClose: true,
      })
    emit('done', result)
  } catch {
    // toasted by the request layer (422: a table went away or its name is outside the whitelist)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="import-tables">
    <p class="import-tables__hint">{{ t('codegen.table.import.hint') }}</p>
    <el-input
      v-model="keyword"
      name="keyword"
      :placeholder="t('codegen.table.import.filter')"
      clearable
      class="import-tables__filter"
    />
    <!-- row-key + reserve-selection: ticks survive the filter -->
    <el-table
      v-loading="loading"
      :data="shown"
      row-key="tableName"
      max-height="420"
      @selection-change="(rows: CgImportableVo[]) => (picked = rows)"
    >
      <el-table-column
        type="selection"
        width="48"
        reserve-selection
        :selectable="(row: CgImportableVo) => !row.noDeletedAt"
      />
      <el-table-column
        prop="tableName"
        :label="t('field.codegen.tableName')"
        width="240"
        show-overflow-tooltip
      />
      <el-table-column
        prop="tableComment"
        :label="t('field.codegen.tableComment')"
        min-width="200"
        show-overflow-tooltip
      >
        <template #default="{ row }: { row: CgImportableVo }">
          <span v-if="row.noDeletedAt" class="import-tables__blocked">
            {{ t('codegen.table.import.noDeletedAt') }}
          </span>
          {{ row.tableComment }}
        </template>
      </el-table-column>
      <template #empty>
        <EmptyState :title="t('codegen.table.import.empty')" />
      </template>
    </el-table>
    <div class="qw-dialog-footer">
      <el-button @click="emit('cancel')">{{ t('common.action.cancel') }}</el-button>
      <el-button type="primary" :disabled="!picked.length" :loading="submitting" @click="submit">
        {{ t('codegen.table.import.submit') }}
      </el-button>
    </div>
  </div>
</template>

<style scoped>
.import-tables__hint {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--qw-text-3);
}
.import-tables__filter {
  margin-bottom: 12px;
}
.import-tables__blocked {
  margin-right: 8px;
  color: var(--qw-warning);
}
</style>
