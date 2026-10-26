<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { agentPerms } from '@qiwu/shared'
import { agentProviderApi } from '@/api/platform/agent-admin'
import QwTable from '@/core/components/QwTable.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { openDialog } from '@/core/dialog'
import { useAuthStore } from '@/core/stores/auth'
import ProviderForm from './ProviderForm.vue'
import { useList } from './use-list'

/** “模型”标签：兼容 OpenAI 的模型提供方及其模型清单；密钥只显示是否已保存。只有 root 能改，其他人只读。 */
defineOptions({ name: 'AgentProviderTab' })
const { t } = useI18n()
const modify = agentPerms.setting.modify
const auth = useAuthStore()
const { rows, loading, refresh, remove } = useList(agentProviderApi.list)
const columns: QwColumn[] = [
  { prop: 'name', label: 'field.agent.provider.name', width: 160, showOverflowTooltip: true },
  { prop: 'hasKey', label: 'field.agent.provider.apiKey', width: 100 },
  { prop: 'enabled', label: 'field.agent.provider.enabled', width: 90 },
  { prop: 'isDefault', label: 'field.agent.provider.isDefault', width: 90 },
  {
    prop: 'models',
    label: 'field.agent.provider.models',
    minWidth: 200,
    showOverflowTooltip: true,
  },
  {
    prop: 'baseUrl',
    label: 'field.agent.provider.baseUrl',
    minWidth: 200,
    showOverflowTooltip: true,
  },
]

/** 新增（无 id）或编辑提供方，保存后重新载入。 */
async function openForm(id?: number) {
  const name = () => t('agent.admin.provider.entity')
  const saved = await openDialog(
    ProviderForm,
    { id },
    { title: () => t(id ? 'crud.title.edit' : 'crud.title.create', { name: name() }), width: 960 },
  )
  if (saved) await refresh()
}
</script>

<template>
  <div>
    <p v-if="!auth.platformRoot" class="agent-setting__hint">{{ t('agent.admin.rootOnly') }}</p>
    <TableToolbar
      table-id="agent.provider"
      :columns="columns"
      :searchable="false"
      @refresh="refresh"
    >
      <el-button v-if="auth.platformRoot" v-perm="modify" type="primary" @click="openForm()">
        {{ t('crud.action.create') }}
      </el-button>
    </TableToolbar>
    <QwTable
      table-id="agent.provider"
      :columns="columns"
      :data="rows"
      :loading="loading"
      row-key="id"
    >
      <template #cell-hasKey="{ row }">
        <el-tag size="small" :type="row.hasKey ? 'success' : 'warning'" disable-transitions>
          {{ t(row.hasKey ? 'agent.admin.keyStored' : 'agent.admin.keyMissing') }}
        </el-tag>
      </template>
      <template #cell-enabled="{ row }">
        <el-tag size="small" :type="row.enabled ? 'success' : 'info'" disable-transitions>
          {{ t(row.enabled ? 'agent.admin.on' : 'agent.admin.off') }}
        </el-tag>
      </template>
      <template #cell-isDefault="{ row }">
        <el-tag v-if="row.isDefault" size="small" disable-transitions>
          {{ t('agent.admin.default') }}
        </el-tag>
      </template>
      <template #cell-models="{ row }">
        <div v-for="m in row.models" :key="m.id">
          {{ m.label || m.id }} ·
          {{
            t(
              m.pricing
                ? 'agent.admin.model.pricingConfigured'
                : 'agent.admin.model.pricingMissing',
            )
          }}
        </div>
      </template>
      <template #actions="{ row }">
        <el-button
          v-if="auth.platformRoot"
          v-perm="modify"
          link
          type="primary"
          @click="openForm(row.id)"
        >
          {{ t('crud.action.edit') }}
        </el-button>
        <el-button
          v-if="auth.platformRoot"
          v-perm="modify"
          link
          type="danger"
          @click="remove(() => agentProviderApi.remove(row.id))"
        >
          {{ t('crud.action.delete') }}
        </el-button>
      </template>
    </QwTable>
  </div>
</template>
