<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import dayjs from 'dayjs'
import type { AgentMemoryVo } from '@qiwu/shared'
import { agentMemoryApi } from '@/api/platform/agent-memory'
import Pagination from '@/core/components/Pagination.vue'
import QwTable from '@/core/components/QwTable.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import { toastRest, useCrudList } from '@/core/composables/use-crud'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { openDialog } from '@/core/dialog'
import MemoryForm from './MemoryForm.vue'

/**
 * 对话页打开的“我的记忆”面板（`openDialog(MemoryPanel)`）：本人的记忆分页列出，可搜索、新增、编辑、删除；
 * “全部忘记”要输入当前密码。只作用于本人的记忆。
 */
defineOptions({ name: 'AgentMemoryPanel' })
const emit = defineEmits<{ done: []; cancel: [] }>()
const { t } = useI18n()
const columns: QwColumn[] = [
  {
    prop: 'content',
    label: 'field.agent.memory.content',
    minWidth: 260,
    showOverflowTooltip: true,
  },
  { prop: 'source', label: 'field.agent.memory.source', width: 120 },
  { prop: 'createdAt', label: 'field.agent.memory.createdAt', width: 150, sortable: true },
  { prop: 'lastUsedAt', label: 'field.agent.memory.lastUsedAt', width: 150, sortable: true },
]
const { query, rows, total, loading, filtered, search, reset, refresh, onSortChange, remove } =
  useCrudList<AgentMemoryVo, { keyword: string }>({
    api: { page: agentMemoryApi.page, remove: agentMemoryApi.remove },
    filters: { keyword: '' },
    sort: '-createdAt',
  })
const forgetting = ref(false)
const time = (at: string | null) => (at ? dayjs(at).format('YYYY-MM-DD HH:mm') : '-')

/** 新增（无 id）或编辑一条记忆，保存后重新载入。 */
async function openForm(id?: number) {
  const saved = await openDialog(
    MemoryForm,
    { id },
    {
      title: () =>
        t(id ? 'crud.title.edit' : 'crud.title.create', { name: t('agent.memory.entity') }),
      width: 520,
    },
  )
  if (saved) await refresh()
}

/** 全部忘记：输入当前密码确认后删除本人的全部记忆；密码错误由请求层提示。 */
async function forgetAll() {
  if (forgetting.value) return
  let password: string
  try {
    const { value } = await ElMessageBox.prompt(
      t('agent.memory.forgetPrompt'),
      t('agent.memory.forgetAll'),
      {
        type: 'warning',
        inputType: 'password',
        inputPlaceholder: t('field.agent.memory.currentPassword'),
        inputValidator: (v) => !!v,
        confirmButtonText: t('agent.memory.forgetAll'),
        cancelButtonText: t('common.action.cancel'),
      },
    )
    password = value
  } catch {
    return
  }
  forgetting.value = true
  try {
    const { removed } = await agentMemoryApi.forgetAll(password)
    ElMessage.success(t('agent.memory.forgotten', { n: removed }))
    await search()
  } catch (e) {
    toastRest(e)
  } finally {
    forgetting.value = false
  }
}
</script>

<template>
  <div>
    <p class="agent-panel__hint">{{ t('agent.memory.hint') }}</p>
    <el-form :model="query" inline @submit.prevent="search">
      <el-form-item>
        <el-input
          v-model="query.keyword"
          clearable
          :placeholder="t('agent.memory.keyword')"
          :aria-label="t('agent.memory.keyword')"
          @clear="reset"
        />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" plain native-type="submit">{{
          t('crud.action.search')
        }}</el-button>
      </el-form-item>
    </el-form>
    <TableToolbar table-id="agent.memory" :columns="columns" :searchable="false" @refresh="refresh">
      <el-button type="primary" @click="openForm()">{{ t('crud.action.create') }}</el-button>
      <el-button type="danger" plain :loading="forgetting" :disabled="!total" @click="forgetAll">
        {{ t('agent.memory.forgetAll') }}
      </el-button>
    </TableToolbar>
    <QwTable
      table-id="agent.memory"
      :columns="columns"
      :data="rows"
      :loading="loading"
      :filtered
      row-key="id"
      @sort-change="onSortChange"
      @reset-filters="reset"
    >
      <template #cell-source="{ row }">{{ t(`agent.memory.source.${row.source}`) }}</template>
      <template #cell-createdAt="{ row }">{{ time(row.createdAt) }}</template>
      <template #cell-lastUsedAt="{ row }">{{ time(row.lastUsedAt) }}</template>
      <template #actions="{ row }">
        <el-button link type="primary" @click="openForm(row.id)">
          {{ t('crud.action.edit') }}
        </el-button>
        <el-button link type="danger" @click="remove([row.id])">
          {{ t('crud.action.delete') }}
        </el-button>
      </template>
    </QwTable>
    <Pagination
      v-model:page="query.page"
      v-model:page-size="query.pageSize"
      :total="total"
      @change="refresh"
    />
    <div class="qw-dialog-footer">
      <el-button @click="emit('done')">{{ t('agent.admin.close') }}</el-button>
    </div>
  </div>
</template>

<style scoped>
.agent-panel__hint {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 20px;
  color: var(--qw-text-2);
}
</style>
