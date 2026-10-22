<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { agentPerms, type AgentOptionsVo, type AgentProfileVo } from '@qiwu/shared'
import { agentProfileApi } from '@/api/platform/agent-memory'
import QwTable from '@/core/components/QwTable.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { openDialog } from '@/core/dialog'
import { usePerm } from '@/core/permission'
import { useList } from '../setting/use-list'
import ProfileForm from './ProfileForm.vue'

/**
 * 对话页打开的“配置方案”面板（`openDialog(ProfilePanel, { options })`）：本人的与全租户共用的方案。本人的
 * 随时可改；全租户的增改删要 `agent.skill.modify`，能否修改一行以服务端给的 `editable` 为准。关闭时
 * 发出 `done`，对话页据此重读方案列表。
 */
defineOptions({ name: 'AgentProfilePanel' })
const { options = null } = defineProps<{ options?: AgentOptionsVo | null }>()
const emit = defineEmits<{ done: [changed: boolean]; cancel: [] }>()
const { t } = useI18n()
const perm = usePerm()
const canTenant = computed(() => perm.has(agentPerms.skill.modify))
const columns: QwColumn[] = [
  { prop: 'name', label: 'field.agent.profile.name', width: 160, showOverflowTooltip: true },
  { prop: 'scope', label: 'field.agent.profile.scope', width: 100 },
  { prop: 'model', label: 'field.agent.profile.model', width: 140, showOverflowTooltip: true },
  { prop: 'approvalMode', label: 'field.agent.profile.approvalMode', width: 120 },
  { prop: 'tools', label: 'field.agent.profile.tools', minWidth: 160, showOverflowTooltip: true },
]

const { rows, loading, refresh, remove: confirmRemove } = useList(() => agentProfileApi.list())
let changed = false

/** 新增（无 id）或编辑方案，保存后重新载入。 */
async function openForm(id?: number) {
  const saved = await openDialog(
    ProfileForm,
    { id, canTenant: canTenant.value, options },
    {
      title: () =>
        t(id ? 'crud.title.edit' : 'crud.title.create', { name: t('agent.profile.entity') }),
      width: 640,
    },
  )
  if (saved) {
    changed = true
    await refresh()
  }
}

/** 确认后删除一个方案并重新载入（用着它的会话退回默认行为）。 */
const remove = (row: AgentProfileVo) =>
  confirmRemove(async () => {
    await agentProfileApi.remove(row.id)
    changed = true
  })
</script>

<template>
  <div>
    <p class="agent-panel__hint">{{ t('agent.profile.hint') }}</p>
    <TableToolbar
      table-id="agent.profile"
      :columns="columns"
      :searchable="false"
      @refresh="refresh"
    >
      <el-button type="primary" @click="openForm()">{{ t('crud.action.create') }}</el-button>
    </TableToolbar>
    <QwTable
      table-id="agent.profile"
      :columns="columns"
      :data="rows"
      :loading="loading"
      row-key="id"
    >
      <template #cell-name="{ row }">
        {{ row.name }}
        <el-tag v-if="row.isDefault" size="small" type="success" disable-transitions>
          {{ t('agent.profile.default') }}
        </el-tag>
      </template>
      <template #cell-scope="{ row }">
        <el-tag size="small" :type="row.scope === 'user' ? 'info' : 'primary'" disable-transitions>
          {{ t(`agent.admin.scope.${row.scope}`) }}
        </el-tag>
      </template>
      <template #cell-model="{ row }">{{ row.model ?? t('agent.profile.modelDefault') }}</template>
      <template #cell-approvalMode="{ row }">{{
        t(`agent.chat.mode.${row.approvalMode}`)
      }}</template>
      <template #cell-tools="{ row }">
        {{ row.tools?.join(', ') ?? t('agent.profile.toolsAll') }}
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
    <div class="qw-dialog-footer">
      <el-button @click="emit('done', changed)">{{ t('agent.admin.close') }}</el-button>
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
