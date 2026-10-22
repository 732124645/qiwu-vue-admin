<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toolTitle } from '../../agent/tool-presentation'
import { ACCESS_TOKEN_STATES, mcpPerms, type AccessTokenAdminVo } from '@qiwu/shared'
import { mcpTokenApi, tokenState } from '@/api/platform/mcp'
import DictTag from '@/core/components/DictTag.vue'
import Pagination from '@/core/components/Pagination.vue'
import QwTable from '@/core/components/QwTable.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import UserSelect from '@/core/components/UserSelect.vue'
import { useCrudList } from '@/core/composables/use-crud'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { Icon } from '@/core/icons'
import TokenState from './TokenState.vue'
import { revokeToken, tokenTime } from './token-actions'

/**
 * 租户管理员的“访问令牌”页：本租户全部用户的个人访问令牌（不含令牌本身，只有尾号），按用户、
 * 名称、状态筛选，可吊销；吊销立即生效且不可恢复。别的租户的令牌服务端看不到。
 */
defineOptions({ name: 'McpToken' })

const { t } = useI18n()
const { query, rows, total, loading, filtered, search, reset, refresh, onSortChange } = useCrudList(
  {
    api: mcpTokenApi,
    filters: { userId: null as number | null, name: '', state: null as string | null },
    sort: '-createdAt',
  },
)
const showSearch = ref(true)
const columns: QwColumn[] = [
  { prop: 'user', label: 'field.mcp.token.userId', width: 180, showOverflowTooltip: true },
  { prop: 'name', label: 'field.mcp.token.name', minWidth: 160, showOverflowTooltip: true },
  { prop: 'tokenHint', label: 'mcp.token.col.hint', width: 110 },
  { prop: 'tools', label: 'field.mcp.token.tools', width: 220, showOverflowTooltip: true },
  { prop: 'allowWrite', label: 'mcp.token.col.write', width: 100 },
  { prop: 'state', label: 'field.mcp.token.state', width: 100 },
  { prop: 'expiresAt', label: 'mcp.token.col.expiresAt', sortable: true, width: 160 },
  { prop: 'lastUsedAt', label: 'mcp.token.col.lastUsedAt', sortable: true, width: 160 },
  { prop: 'createdAt', label: 'field.common.createdAt', sortable: true, width: 160 },
]

/** 正在吊销的令牌 id：操作按钮在请求期间显示加载并禁用。 */
const revoking = ref<number>()
/** 确认后吊销一个令牌并重新载入列表。 */
async function revoke(row: AccessTokenAdminVo) {
  if (revoking.value != null) return
  try {
    const done = await revokeToken(row, () => {
      revoking.value = row.id
      return mcpTokenApi.revoke(row.id)
    })
    if (done) await refresh()
  } finally {
    revoking.value = undefined
  }
}
</script>

<template>
  <div class="qw-page">
    <el-card v-show="showSearch" class="qw-search-panel">
      <el-form :model="query" inline @submit.prevent="search">
        <el-form-item :label="t('field.mcp.token.userId')">
          <UserSelect v-model="query.userId" />
        </el-form-item>
        <el-form-item :label="t('field.mcp.token.name')">
          <el-input v-model="query.name" name="name" maxlength="64" clearable />
        </el-form-item>
        <el-form-item :label="t('field.mcp.token.state')">
          <el-select v-model="query.state" :aria-label="t('field.mcp.token.state')" clearable>
            <el-option
              v-for="s in ACCESS_TOKEN_STATES"
              :key="s"
              :label="t(`mcp.token.state.${s}`)"
              :value="s"
            />
          </el-select>
        </el-form-item>
        <el-form-item class="qw-search-actions">
          <el-button type="primary" plain native-type="submit">
            <el-icon class="el-icon--left"><Icon icon="lucide:search" /></el-icon>
            {{ t('crud.action.search') }}
          </el-button>
          <el-button @click="reset">{{ t('crud.action.reset') }}</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card class="qw-table-panel">
      <TableToolbar
        v-model:search="showSearch"
        table-id="mcp.token"
        :columns="columns"
        @refresh="refresh"
      />

      <QwTable
        table-id="mcp.token"
        :columns="columns"
        :data="rows"
        :loading="loading"
        :filtered
        @sort-change="onSortChange"
        @reset-filters="reset"
      >
        <template #cell-user="{ row }">{{ row.displayName }} ({{ row.username }})</template>
        <template #cell-tokenHint="{ row }">
          <code class="mcp-token__mono">…{{ row.tokenHint }}</code>
        </template>
        <template #cell-tools="{ row }">
          {{
            row.tools
              ? row.tools.map((name: string) => toolTitle(name)).join(', ')
              : t('mcp.token.allTools')
          }}
        </template>
        <template #cell-allowWrite="{ row }">
          <DictTag code="core.yes_no" :value="row.allowWrite" />
        </template>
        <template #cell-state="{ row }"><TokenState :token="row" /></template>
        <template #cell-expiresAt="{ row }">
          {{ row.expiresAt ? tokenTime(row.expiresAt) : t('mcp.token.never') }}
        </template>
        <template #cell-lastUsedAt="{ row }">
          {{ row.lastUsedAt ? tokenTime(row.lastUsedAt) : t('mcp.token.neverUsed') }}
        </template>
        <template #cell-createdAt="{ row }">{{ tokenTime(row.createdAt) }}</template>
        <template #actions="{ row }">
          <el-button
            v-perm="mcpPerms.token.revoke"
            link
            type="danger"
            :disabled="tokenState(row) !== 'active' || (revoking != null && revoking !== row.id)"
            :loading="revoking === row.id"
            @click="revoke(row)"
          >
            {{ t('menu.action.revoke') }}
          </el-button>
        </template>
      </QwTable>

      <Pagination
        v-model:page="query.page"
        v-model:page-size="query.pageSize"
        :total="total"
        @change="refresh"
      />
    </el-card>
  </div>
</template>

<style scoped>
.mcp-token__mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
</style>
