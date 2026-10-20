<script setup lang="ts">
import { ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AccessTokenCreatedVo, AccessTokenVo } from '@qiwu/shared'
import { myTokenApi, tokenState } from '@/api/platform/mcp'
import DictTag from '@/core/components/DictTag.vue'
import QwTable from '@/core/components/QwTable.vue'
import { toastRest } from '@/core/composables/use-crud'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { openDialog } from '@/core/dialog'
import { Icon } from '@/core/icons'
import TokenState from '@/views/platform/mcp/token/TokenState.vue'
import { revokeToken, tokenTime } from '@/views/platform/mcp/token/token-actions'
import AccessTokenCreated from './AccessTokenCreated.vue'
import AccessTokenForm from './AccessTokenForm.vue'

/**
 * 个人中心“访问令牌”：本人的个人访问令牌（供智能体经 MCP 以本人身份调用工具），新建、查看与吊销。
 * 列表里只有令牌尾号，完整令牌仅在新建后显示一次。
 */
defineOptions({ name: 'AccessTokens' })
const { t } = useI18n()
const rows = shallowRef<AccessTokenVo[]>([])
const loading = ref(false)
const columns: QwColumn[] = [
  { prop: 'name', label: 'field.mcp.token.name', minWidth: 140, showOverflowTooltip: true },
  { prop: 'tokenHint', label: 'mcp.token.col.hint', width: 110 },
  { prop: 'tools', label: 'field.mcp.token.tools', width: 180, showOverflowTooltip: true },
  { prop: 'allowWrite', label: 'mcp.token.col.write', width: 100 },
  { prop: 'state', label: 'field.mcp.token.state', width: 100 },
  { prop: 'expiresAt', label: 'mcp.token.col.expiresAt', width: 160 },
  { prop: 'lastUsedAt', label: 'mcp.token.col.lastUsedAt', width: 160, hidden: true },
]

/** 重新载入本人的令牌；失败由请求层提示。 */
async function refresh() {
  loading.value = true
  try {
    rows.value = await myTokenApi.list()
  } catch (e) {
    toastRest(e)
  } finally {
    loading.value = false
  }
}
void refresh()

/** 新建令牌：表单提交成功后刷新列表，再显示一次完整令牌（ESC 不会误关）。 */
async function create() {
  const created = await openDialog<AccessTokenCreatedVo>(
    AccessTokenForm,
    {},
    { title: () => t('mcp.token.create'), width: '600px' },
  )
  if (!created) return
  await refresh()
  await openDialog(
    AccessTokenCreated,
    { token: created.token },
    { title: () => t('mcp.token.createdTitle'), closeOnPressEscape: false },
  )
}

const revoking = ref<number>()
/** 确认后吊销本人的一个令牌并重新载入。 */
async function revoke(row: AccessTokenVo) {
  if (revoking.value != null) return
  try {
    const done = await revokeToken(row, () => {
      revoking.value = row.id
      return myTokenApi.revoke(row.id)
    })
    if (done) await refresh()
  } finally {
    revoking.value = undefined
  }
}
</script>

<template>
  <div class="tokens">
    <el-alert
      type="info"
      :title="t('mcp.token.intro')"
      :closable="false"
      show-icon
      class="tokens__intro"
    />
    <div class="tokens__bar">
      <el-button type="primary" @click="create">
        <el-icon class="el-icon--left"><Icon icon="lucide:plus" /></el-icon>
        {{ t('mcp.token.create') }}
      </el-button>
    </div>
    <QwTable
      table-id="mcp.myToken"
      :columns="columns"
      :data="rows"
      :loading="loading"
      :actions-width="100"
    >
      <template #cell-tokenHint="{ row }">
        <code class="tokens__mono">…{{ row.tokenHint }}</code>
      </template>
      <template #cell-tools="{ row }">
        {{ row.tools ? row.tools.join(', ') : t('mcp.token.allTools') }}
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
      <template #actions="{ row }">
        <el-button
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
  </div>
</template>

<style scoped>
.tokens {
  padding-top: 8px;
}
.tokens__intro {
  margin-bottom: 12px;
}
.tokens__bar {
  margin-bottom: 12px;
}
.tokens__mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
</style>
