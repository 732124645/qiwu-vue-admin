<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import { agentPerms, type AgentMcpServerVo } from '@qiwu/shared'
import { agentMcpServerApi } from '@/api/platform/agent-admin'
import QwTable from '@/core/components/QwTable.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import { toastRest } from '@/core/composables/use-crud'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { openDialog } from '@/core/dialog'
import { usePerm } from '@/core/permission'
import { useAuthStore } from '@/core/stores/auth'
import McpServerForm from './McpServerForm.vue'
import McpTools from './McpTools.vue'
import { useList } from './use-list'

/**
 * “外部 MCP”标签：外部服务器列表（地址、鉴权方式、连接状态、上次错误与同步时间），
 * 同步按钮重新连接并列出其工具，“工具”打开逐个启用与设策略的对话框。只有 root 能改，其他人只读。
 */
defineOptions({ name: 'AgentMcpTab' })
const { t, te } = useI18n()
const perm = usePerm()
const modify = agentPerms.setting.modify
const auth = useAuthStore()
const canModify = computed(() => auth.platformRoot && perm.has(modify))
const { rows, loading, refresh, remove } = useList(agentMcpServerApi.list)
const columns: QwColumn[] = [
  { prop: 'name', label: 'field.agent.mcpServer.name', width: 160, showOverflowTooltip: true },
  { prop: 'authKind', label: 'field.agent.mcpServer.authKind', width: 120 },
  { prop: 'status', label: 'agent.admin.mcp.status', minWidth: 200 },
  { prop: 'syncedAt', label: 'agent.admin.mcp.syncedAt', width: 160 },
  { prop: 'enabled', label: 'field.agent.mcpServer.enabled', width: 90 },
  { prop: 'url', label: 'field.agent.mcpServer.url', minWidth: 200, showOverflowTooltip: true },
]
/** 正在同步的服务器 id：同步按钮加载并禁用 */
const syncing = ref<number>()
/** 已知连接失败原因按页面语言显示，未知服务端错误保留原文。 */
function reasonText(code: string) {
  const http = /^http_(\d{3})$/.exec(code)
  if (http) return t('agent.admin.diag.reason.http', { status: http[1] })
  const key = `agent.admin.diag.reason.${code}`
  return te(key) ? t(key) : code
}

/** 新增（无 id）或编辑服务器，保存后重新载入。 */
async function openForm(id?: number) {
  const name = () => t('agent.admin.mcp.entity')
  const saved = await openDialog(
    McpServerForm,
    { id },
    { title: () => t(id ? 'crud.title.edit' : 'crud.title.create', { name: name() }), width: 640 },
  )
  if (saved) await refresh()
}

/** 同步：服务端连接并列出工具，返回最新状态，直接替换该行（失败时状态与错误也在应答里）。 */
async function sync(row: AgentMcpServerVo) {
  if (syncing.value) return
  syncing.value = row.id
  try {
    const saved = await agentMcpServerApi.sync(row.id)
    rows.value = rows.value.map((r) => (r.id === row.id ? saved : r))
  } catch (e) {
    toastRest(e)
  } finally {
    syncing.value = undefined
  }
}

/** 打开工具对话框，关闭后重新载入（启用与策略以服务端为准）。 */
async function openTools(row: AgentMcpServerVo) {
  await openDialog(
    McpTools,
    { server: row, canModify: canModify.value },
    { title: () => t('agent.admin.mcp.toolsOf', { name: row.name }), width: 880 },
  )
  await refresh()
}
</script>

<template>
  <div>
    <p v-if="!auth.platformRoot" class="agent-setting__hint">{{ t('agent.admin.rootOnly') }}</p>
    <TableToolbar
      table-id="agent.mcpServer"
      :columns="columns"
      :searchable="false"
      @refresh="refresh"
    >
      <el-button v-if="canModify" type="primary" @click="openForm()">
        {{ t('crud.action.create') }}
      </el-button>
    </TableToolbar>
    <QwTable
      table-id="agent.mcpServer"
      :columns="columns"
      :data="rows"
      :loading="loading"
      row-key="id"
    >
      <template #cell-authKind="{ row }">{{ t(`agent.admin.mcp.auth.${row.authKind}`) }}</template>
      <template #cell-status="{ row }">
        <el-tag
          size="small"
          :type="row.status === 'ok' ? 'success' : row.status === 'error' ? 'danger' : 'info'"
          class="mcp-tab__status"
          disable-transitions
        >
          {{ t(`agent.admin.mcp.state.${row.status}`) }}
        </el-tag>
        <span v-if="row.status === 'ok'" class="mcp-tab__muted">
          {{ t('agent.admin.mcp.toolCount', { n: row.tools.length }) }}
        </span>
        <span v-if="row.lastError" class="mcp-tab__error" :title="row.lastError">
          {{ reasonText(row.lastError) }}
        </span>
      </template>
      <template #cell-syncedAt="{ row }">
        {{ row.syncedAt ? dayjs(row.syncedAt).format('YYYY-MM-DD HH:mm') : '' }}
      </template>
      <template #cell-enabled="{ row }">
        <el-tag size="small" :type="row.enabled ? 'success' : 'info'" disable-transitions>
          {{ t(row.enabled ? 'agent.admin.on' : 'agent.admin.off') }}
        </el-tag>
      </template>
      <template #actions="{ row }">
        <el-button
          v-if="canModify"
          link
          type="primary"
          :loading="syncing === row.id"
          :disabled="syncing != null"
          @click="sync(row)"
        >
          {{ t('agent.admin.mcp.sync') }}
        </el-button>
        <el-button link type="primary" @click="openTools(row)">
          {{ t('agent.admin.mcp.tools') }}
        </el-button>
        <el-button v-if="canModify" link type="primary" @click="openForm(row.id)">
          {{ t('crud.action.edit') }}
        </el-button>
        <el-button
          v-if="canModify"
          link
          type="danger"
          @click="remove(() => agentMcpServerApi.remove(row.id))"
        >
          {{ t('crud.action.delete') }}
        </el-button>
      </template>
    </QwTable>
  </div>
</template>

<style scoped>
.mcp-tab__status {
  margin-right: 6px;
}
.mcp-tab__muted {
  font-size: 12px;
  color: var(--qw-text-3);
}
.mcp-tab__error {
  font-size: 12px;
  color: var(--qw-danger);
}
</style>
