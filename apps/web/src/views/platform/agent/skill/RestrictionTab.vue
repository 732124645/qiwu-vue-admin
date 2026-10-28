<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  agentPerms,
  AGENT_TOOL_RESTRICTIONS,
  type AgentToolRestrictionPolicy,
  type AgentToolRestrictionVo,
} from '@qiwu/shared'
import { agentToolRestrictionApi } from '@/api/platform/agent-admin'
import QwTable from '@/core/components/QwTable.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import { toastRest } from '@/core/composables/use-crud'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { usePerm } from '@/core/permission'
import { toolTitle } from '../tool-presentation'
import { useList } from '../setting/use-list'

/**
 * “工具限制”标签：本租户在平台策略之上把工具收紧为“仅人工确认”或“停用”，或去掉收紧（“不限制”）。只能收紧：
 * 生效值总取平台与本租户中更严的一方，由服务端计算，这里只显示服务端给的结果。只作用于站内智能助手，个人访问
 * 令牌接入的 MCP 客户端不受影响。有 `agent.restriction.modify` 才能改，其他人只读。
 */
defineOptions({ name: 'AgentRestrictionTab' })
const { t } = useI18n()
const perm = usePerm()
const canModify = computed(() => perm.has(agentPerms.restriction.modify))
const { rows, loading, refresh } = useList(agentToolRestrictionApi.list)
const columns: QwColumn[] = [
  { prop: 'name', label: 'agent.admin.tool.name', minWidth: 240 },
  { prop: 'kind', label: 'agent.admin.tool.kind', width: 90 },
  { prop: 'origin', label: 'agent.admin.tool.source', width: 110 },
  { prop: 'platformPolicy', label: 'agent.admin.restriction.platform', width: 130 },
  { prop: 'tenantPolicy', label: 'agent.admin.restriction.tenant', width: 160 },
  { prop: 'effective', label: 'agent.admin.restriction.effective', width: 130 },
]
/** 选择框里“不限制”的取值（el-select 不便用 null 作选项值），保存时换回 null */
const NONE = 'none'
const choices = [NONE, ...AGENT_TOOL_RESTRICTIONS] as const

/** 筛选框：按标题或工具名不分大小写筛选 */
const keyword = ref('')
const shown = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  if (!k) return rows.value
  return rows.value.filter((r) =>
    `${toolTitle(r.name, r.title)} ${r.name}`.toLowerCase().includes(k),
  )
})

/** 正在保存的工具名：保存期间所有选择框禁用，防止重复提交 */
const busy = ref<string>()
/** 设本租户的收紧（`none` 去掉），成功后用服务端回的一行替换；失败提示后以服务端为准重新载入。 */
async function setRestriction(row: AgentToolRestrictionVo, value: string) {
  if (busy.value) return
  busy.value = row.name
  const policy = value === NONE ? null : (value as AgentToolRestrictionPolicy)
  try {
    const next = await agentToolRestrictionApi.set(row.name, policy)
    rows.value = rows.value.map((r) => (r.name === next.name ? next : r))
  } catch (e) {
    toastRest(e)
    await refresh()
  } finally {
    busy.value = undefined
  }
}
</script>

<template>
  <div class="restriction-tab">
    <p class="restriction-tab__hint">{{ t('agent.admin.restriction.note') }}</p>
    <TableToolbar
      table-id="agent.restriction"
      :columns="columns"
      :searchable="false"
      @refresh="refresh"
    >
      <el-input
        v-model="keyword"
        clearable
        class="restriction-tab__filter"
        :placeholder="t('agent.admin.restriction.filter')"
        :aria-label="t('agent.admin.restriction.filter')"
      />
    </TableToolbar>
    <QwTable
      table-id="agent.restriction"
      :columns="columns"
      :data="shown"
      :loading="loading"
      row-key="name"
    >
      <template #cell-name="{ row }">
        <strong>{{ toolTitle(row.name, row.title) }}</strong>
        <div class="restriction-tab__muted restriction-tab__mono">{{ row.name }}</div>
      </template>
      <template #cell-kind="{ row }">
        <el-tag size="small" :type="row.kind === 'write' ? 'warning' : 'info'" disable-transitions>
          {{ t(`agent.admin.tool.kinds.${row.kind}`) }}
        </el-tag>
      </template>
      <template #cell-origin="{ row }">{{ t(`agent.admin.tool.sources.${row.origin}`) }}</template>
      <template #cell-platformPolicy="{ row }">{{
        t(`agent.admin.policy.${row.platformPolicy}`)
      }}</template>
      <template #cell-tenantPolicy="{ row }">
        <el-select
          size="small"
          class="restriction-tab__select"
          :model-value="row.tenantPolicy ?? NONE"
          :disabled="!canModify || busy != null"
          :aria-label="t('agent.admin.restriction.set', { name: row.name })"
          @change="setRestriction(row, $event as string)"
        >
          <el-option
            v-for="c in choices"
            :key="c"
            :value="c"
            :label="t(c === NONE ? 'agent.admin.restriction.none' : `agent.admin.policy.${c}`)"
          />
        </el-select>
      </template>
      <template #cell-effective="{ row }">
        <el-tag
          size="small"
          :type="
            row.effective === 'deny' ? 'danger' : row.effective === 'auto' ? 'info' : 'warning'
          "
          disable-transitions
        >
          {{ t(`agent.admin.policy.${row.effective}`) }}
        </el-tag>
      </template>
    </QwTable>
  </div>
</template>

<style scoped>
.restriction-tab {
  padding: 0 16px 16px;
}
.restriction-tab__hint {
  margin: 12px 0 0;
  font-size: 13px;
  color: var(--qw-text-2);
}
.restriction-tab__filter {
  width: 240px;
}
.restriction-tab__select {
  width: 130px;
}
.restriction-tab__mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.restriction-tab__muted {
  color: var(--qw-text-3);
}
</style>
