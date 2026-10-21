<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { agentPerms, type AgentPromptVo } from '@qiwu/shared'
import { agentPromptApi } from '@/api/platform/agent-admin'
import QwTable from '@/core/components/QwTable.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { openDialog } from '@/core/dialog'
import { usePerm } from '@/core/permission'
import { useList } from '../setting/use-list'
import PromptForm from './PromptForm.vue'

/**
 * 提示词模板（本人与本租户）：对话页输入框里可直接选用。本人的随时可改；租户模板的增改删要
 * `agent.skill.modify`，能否修改一行以服务端给的 `editable` 为准。
 */
defineOptions({ name: 'AgentPromptList' })
const { t } = useI18n()
const perm = usePerm()
const canTenant = computed(() => perm.has(agentPerms.skill.modify))
const columns: QwColumn[] = [
  { prop: 'name', label: 'field.agent.prompt.name', width: 180, showOverflowTooltip: true },
  { prop: 'scope', label: 'field.agent.prompt.scope', width: 100 },
  { prop: 'body', label: 'field.agent.prompt.body', minWidth: 240, showOverflowTooltip: true },
]

const { rows, loading, refresh, remove: confirmRemove } = useList(() => agentPromptApi.list())

/** 新增（无 id）或编辑模板，保存后重新载入。 */
async function openForm(id?: number) {
  const name = () => t('agent.admin.prompt.entity')
  const saved = await openDialog(
    PromptForm,
    { id, canTenant: canTenant.value },
    { title: () => t(id ? 'crud.title.edit' : 'crud.title.create', { name: name() }), width: 640 },
  )
  if (saved) await refresh()
}

/** 确认后删除一个模板并重新载入。 */
const remove = (row: AgentPromptVo) => confirmRemove(() => agentPromptApi.remove(row.id))
</script>

<template>
  <div>
    <TableToolbar table-id="agent.prompt" :columns="columns" :searchable="false" @refresh="refresh">
      <el-button type="primary" @click="openForm()">{{ t('crud.action.create') }}</el-button>
    </TableToolbar>
    <QwTable
      table-id="agent.prompt"
      :columns="columns"
      :data="rows"
      :loading="loading"
      row-key="id"
    >
      <template #cell-scope="{ row }">
        <el-tag size="small" :type="row.scope === 'user' ? 'info' : 'primary'" disable-transitions>
          {{ t(`agent.admin.scope.${row.scope}`) }}
        </el-tag>
      </template>
      <template #actions="{ row }">
        <template v-if="row.editable">
          <el-button link type="primary" @click="openForm(row.id)">
            {{ t('crud.action.edit') }}
          </el-button>
          <el-button link type="danger" @click="remove(row)">
            {{ t('crud.action.delete') }}
          </el-button>
        </template>
      </template>
    </QwTable>
  </div>
</template>
