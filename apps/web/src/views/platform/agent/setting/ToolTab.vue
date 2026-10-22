<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { agentPerms, type AgentToolPolicy, type AgentToolVo } from '@qiwu/shared'
import { agentToolApi } from '@/api/platform/agent-admin'
import QwTable from '@/core/components/QwTable.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import { toastRest } from '@/core/composables/use-crud'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { usePerm } from '@/core/permission'
import { useAuthStore } from '@/core/stores/auth'
import { useList } from './use-list'

/**
 * “工具策略”标签：本系统工具、内置联网工具与智能体内置工具的审批策略。写入工具只能“询问”、“自动审查”
 * 或“禁用”，从不自动执行；改过的可恢复为按类型的默认（只读自动、写入询问）。内置工具在这里启停（本系统
 * 其他工具在 MCP 工具页）。只有 root 能改，其他人只读。
 */
defineOptions({ name: 'AgentToolTab' })
const { t } = useI18n()
const perm = usePerm()
const auth = useAuthStore()
const canModify = computed(() => auth.platformRoot && perm.has(agentPerms.setting.modify))
const { rows, loading, refresh } = useList(agentToolApi.list)
const columns: QwColumn[] = [
  { prop: 'name', label: 'agent.admin.tool.name', width: 220, showOverflowTooltip: true },
  { prop: 'title', label: 'agent.admin.tool.title', minWidth: 160, showOverflowTooltip: true },
  { prop: 'kind', label: 'agent.admin.tool.kind', width: 90 },
  { prop: 'source', label: 'agent.admin.tool.source', width: 90 },
  { prop: 'perm', label: 'agent.admin.tool.perm', width: 200, showOverflowTooltip: true },
  { prop: 'policy', label: 'agent.admin.tool.policy', width: 150 },
  { prop: 'enabled', label: 'agent.admin.tool.enabled', width: 90 },
]
/** 一个工具可选的策略：写入工具不提供“自动”，“自动审查”只给写入工具。 */
const toolPolicies = (tool: Pick<AgentToolVo, 'kind'>): AgentToolPolicy[] =>
  tool.kind === 'write' ? ['ask', 'review', 'deny'] : ['auto', 'ask', 'deny']
/** 正在保存的工具名：其控件加载并禁用 */
const busy = ref<string>()

/** 设策略（`null` 恢复默认），完成后以服务端为准重新载入。 */
async function setPolicy(row: AgentToolVo, policy: AgentToolPolicy | null) {
  if (busy.value) return
  busy.value = row.name
  try {
    await agentToolApi.setPolicy(row.name, policy)
  } catch (e) {
    toastRest(e)
  } finally {
    await refresh()
    busy.value = undefined
  }
}

/** 启用或停用一个内置工具，完成后以服务端为准重新载入。 */
async function setEnabled(row: AgentToolVo, enabled: boolean) {
  if (busy.value) return
  busy.value = row.name
  try {
    await agentToolApi.setEnabled(row.name, enabled)
  } catch (e) {
    toastRest(e)
  } finally {
    await refresh()
    busy.value = undefined
  }
}
</script>

<template>
  <div>
    <p v-if="!auth.platformRoot" class="agent-setting__hint">{{ t('agent.admin.rootOnly') }}</p>
    <TableToolbar table-id="agent.tool" :columns="columns" :searchable="false" @refresh="refresh" />
    <QwTable
      table-id="agent.tool"
      :columns="columns"
      :data="rows"
      :loading="loading"
      row-key="name"
    >
      <template #cell-name="{ row }">
        <code class="tool-tab__mono">{{ row.name }}</code>
      </template>
      <template #cell-kind="{ row }">
        <el-tag size="small" :type="row.kind === 'write' ? 'warning' : 'info'" disable-transitions>
          {{ t(`agent.admin.tool.kinds.${row.kind}`) }}
        </el-tag>
      </template>
      <template #cell-source="{ row }">{{ t(`agent.admin.tool.sources.${row.source}`) }}</template>
      <template #cell-perm="{ row }">
        <code v-if="row.perm" class="tool-tab__mono">{{ row.perm }}</code>
        <span v-else class="tool-tab__muted">{{ t('agent.admin.tool.anyUser') }}</span>
      </template>
      <template #cell-policy="{ row }">
        <el-select
          size="small"
          class="tool-tab__policy"
          :model-value="row.policy"
          :disabled="!canModify || busy != null"
          :aria-label="`${t('agent.admin.tool.policy')} ${row.name}`"
          @change="setPolicy(row, $event as AgentToolPolicy)"
        >
          <el-option
            v-for="p in toolPolicies(row)"
            :key="p"
            :value="p"
            :label="t(`agent.admin.policy.${p}`)"
          />
        </el-select>
      </template>
      <template #cell-enabled="{ row }">
        <el-switch
          v-if="row.source === 'builtin'"
          size="small"
          :model-value="row.enabled"
          :disabled="!canModify || busy != null"
          :loading="busy === row.name"
          :aria-label="t('agent.admin.tool.enabledToggle', { name: row.name })"
          @change="setEnabled(row, $event as boolean)"
        />
      </template>
      <template #actions="{ row }">
        <el-button
          v-if="canModify && !row.defaulted"
          link
          type="primary"
          :loading="busy === row.name"
          :disabled="busy != null"
          @click="setPolicy(row, null)"
        >
          {{ t('agent.admin.tool.reset') }}
        </el-button>
        <span v-else-if="row.defaulted" class="tool-tab__muted">{{
          t('agent.admin.default')
        }}</span>
      </template>
    </QwTable>
  </div>
</template>

<style scoped>
.tool-tab__mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.tool-tab__muted {
  font-size: 12px;
  color: var(--qw-text-3);
}
.tool-tab__policy {
  width: 120px;
}
</style>
