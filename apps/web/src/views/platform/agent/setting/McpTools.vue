<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessageBox } from 'element-plus'
import type { AgentExternalToolVo, AgentMcpServerVo, AgentToolPolicy } from '@qiwu/shared'
import { agentMcpServerApi } from '@/api/platform/agent-admin'
import { toastRest } from '@/core/composables/use-crud'

/**
 * 一个外部 MCP 服务器的工具（对话框内容，`openDialog(McpTools, { server, canModify })`）：逐个启用并设审批策略。
 * 服务器声明的“只读”不等于安全；管理员可逐工具明示信任，但选择“自动”前必须确认服务器、工具及风险。
 * 关闭后页面重新载入服务器列表。
 */
defineOptions({ name: 'AgentMcpTools' })
const { server, canModify = false } = defineProps<{
  server: AgentMcpServerVo
  canModify?: boolean
}>()
const emit = defineEmits<{ done: [closed: true]; cancel: [] }>()
const { t } = useI18n()
const tools = ref<AgentExternalToolVo[]>([...server.tools])
/** 正在保存的工具 id：其控件加载并禁用，防止重复提交 */
const busy = ref<number>()

const policies: AgentToolPolicy[] = ['auto', 'ask', 'review', 'deny']

/** 保存一个工具的启用或策略；选“自动”先确认。成功后以服务端应答替换该行。 */
async function update(
  tool: AgentExternalToolVo,
  dto: { enabled?: boolean; policy?: AgentToolPolicy },
) {
  if (busy.value || !canModify) return
  busy.value = tool.id
  try {
    if (dto.policy === 'auto') {
      try {
        await ElMessageBox.confirm(
          t('agent.admin.mcp.trustConfirm', { server: server.name, tool: tool.name }),
          t('crud.confirm.title'),
          {
            type: 'warning',
            cancelButtonText: t('common.action.cancel'),
          },
        )
      } catch {
        return
      }
    }
    const saved = await agentMcpServerApi.updateTool(server.id, tool.id, dto)
    tools.value = tools.value.map((x) => (x.id === tool.id ? saved : x))
  } catch (e) {
    toastRest(e)
  } finally {
    busy.value = undefined
  }
}
</script>

<template>
  <el-table :data="tools" max-height="480" row-key="id">
    <el-table-column :label="t('agent.admin.tool.name')" min-width="180">
      <template #default="{ row }">
        <code class="mcp-tools__mono">{{ row.name }}</code>
        <div v-if="row.title" class="mcp-tools__muted">{{ row.title }}</div>
      </template>
    </el-table-column>
    <el-table-column :label="t('agent.admin.mcp.readOnlyHint')" width="110">
      <template #default="{ row }">
        {{ t(row.readOnlyHint ? 'agent.admin.mcp.claimsRead' : 'agent.admin.mcp.claimsWrite') }}
      </template>
    </el-table-column>
    <el-table-column :label="t('agent.admin.on')" width="90">
      <template #default="{ row }">
        <el-switch
          size="small"
          :model-value="row.enabled"
          :disabled="!canModify || busy != null"
          :loading="busy === row.id"
          :aria-label="`${t('agent.admin.on')} ${row.name}`"
          @change="update(row, { enabled: $event as boolean })"
        />
      </template>
    </el-table-column>
    <el-table-column :label="t('agent.admin.tool.policy')" width="150">
      <template #default="{ row }">
        <el-select
          size="small"
          class="mcp-tools__policy"
          :model-value="row.policy"
          :disabled="!canModify || busy != null"
          :aria-label="`${t('agent.admin.tool.policy')} ${row.name}`"
          @change="update(row, { policy: $event as AgentToolPolicy })"
        >
          <el-option
            v-for="p in policies"
            :key="p"
            :value="p"
            :label="t(`agent.admin.policy.${p}`)"
          />
        </el-select>
      </template>
    </el-table-column>
    <el-table-column
      :label="t('agent.admin.tool.description')"
      prop="description"
      min-width="200"
      show-overflow-tooltip
    />
  </el-table>
  <div class="qw-dialog-footer">
    <el-button @click="emit('done', true)">{{ t('agent.admin.close') }}</el-button>
  </div>
</template>

<style scoped>
.mcp-tools__mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.mcp-tools__muted {
  font-size: 12px;
  color: var(--qw-text-3);
}
.mcp-tools__policy {
  width: 120px;
}
</style>
