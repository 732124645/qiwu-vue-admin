<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import { mcpPerms, type McpToolVo } from '@qiwu/shared'
import { mcpToolApi } from '@/api/platform/mcp'
import QwTable from '@/core/components/QwTable.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import { toastRest } from '@/core/composables/use-crud'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { Icon } from '@/core/icons'
import { usePerm } from '@/core/permission'
import { toolTitle, toolDescription, toolPermission } from '../../agent/tool-presentation'

/**
 * 平台页“MCP 工具”：列出已注册的智能体工具（类型、所需权限、启用状态），有修改权限时可逐个停用；
 * 停用对所有租户与令牌立即生效。页头给出智能体客户端要连接的端点地址。
 */
defineOptions({ name: 'McpTool' })

const { t } = useI18n()
const rows = shallowRef<McpToolVo[]>([])
const loading = ref(false)
const columns: QwColumn[] = [
  { prop: 'name', label: 'mcp.tool.col.name', minWidth: 240 },
  { prop: 'kind', label: 'mcp.tool.col.kind', width: 100 },
  { prop: 'perm', label: 'mcp.tool.col.perm', width: 180 },
  { prop: 'enabled', label: 'mcp.tool.col.enabled', width: 100 },
  {
    prop: 'description',
    label: 'mcp.tool.col.description',
    minWidth: 240,
  },
]
const perm = usePerm()
const canModify = computed(() => perm.has(mcpPerms.tool.modify))
// 智能体客户端填的地址：本站的 /api/mcp（经反向代理时即用户访问的域名）
const endpoint = `${location.origin}/api/mcp`

/** 重新载入工具列表；失败由请求层提示。 */
async function refresh() {
  loading.value = true
  try {
    rows.value = await mcpToolApi.list()
  } catch (e) {
    toastRest(e)
  } finally {
    loading.value = false
  }
}
void refresh()

/** 正在切换的工具名：开关在请求期间显示加载并禁用，防止重复提交。 */
const switching = ref<string>()
/** 停用 / 启用一个工具，完成后重新载入，以服务端保存的状态为准。 */
async function setEnabled(row: McpToolVo, enabled: boolean) {
  if (switching.value) return
  switching.value = row.name
  try {
    await mcpToolApi.setEnabled(row.name, enabled)
  } catch (e) {
    toastRest(e)
  } finally {
    await refresh()
    switching.value = undefined
  }
}

/** 复制端点地址；没有剪贴板权限时提示手动复制，输入框仍可选中。 */
async function copyEndpoint() {
  try {
    await navigator.clipboard.writeText(endpoint)
    ElMessage.success(t('mcp.copied'))
  } catch {
    ElMessage.error(t('mcp.copyFailed'))
  }
}
</script>

<template>
  <div class="qw-page">
    <el-card class="qw-search-panel">
      <p class="mcp-tool__intro">{{ t('mcp.tool.intro') }}</p>
      <el-form label-position="left" class="mcp-tool__endpoint" @submit.prevent>
        <el-form-item :label="t('mcp.tool.endpoint')">
          <el-input :model-value="endpoint" readonly class="mcp-tool__mono">
            <template #append>
              <el-button :aria-label="t('mcp.copy')" @click="copyEndpoint">
                <Icon icon="lucide:copy" />
              </el-button>
            </template>
          </el-input>
        </el-form-item>
      </el-form>
      <p class="mcp-tool__hint">
        <Icon icon="lucide:book-open" />
        {{ t('mcp.tool.docsHint') }}
      </p>
    </el-card>

    <el-card class="qw-table-panel">
      <TableToolbar table-id="mcp.tool" :columns="columns" :searchable="false" @refresh="refresh" />
      <QwTable
        table-id="mcp.tool"
        :columns="columns"
        :data="rows"
        :loading="loading"
        row-key="name"
      >
        <template #cell-name="{ row }">
          <strong>{{ toolTitle(row.name, row.title) }}</strong>
          <div class="mcp-tool__muted mcp-tool__mono">{{ row.name }}</div>
        </template>
        <template #cell-description="{ row }">{{
          toolDescription(row.name, row.description)
        }}</template>
        <template #cell-kind="{ row }">
          <el-tag
            size="small"
            :type="row.kind === 'write' ? 'warning' : 'info'"
            disable-transitions
          >
            {{ t(`mcp.tool.kind.${row.kind}`) }}
          </el-tag>
        </template>
        <template #cell-perm="{ row }">
          <span v-if="row.perm" :title="row.perm">{{ toolPermission(row.perm) }}</span>
          <span v-else class="mcp-tool__muted">{{ t('mcp.tool.anyUser') }}</span>
        </template>
        <template #cell-enabled="{ row }">
          <el-switch
            v-if="canModify"
            size="small"
            :model-value="row.enabled"
            :loading="switching === row.name"
            :disabled="switching != null"
            :aria-label="`${t('mcp.tool.col.enabled')} ${row.name}`"
            @change="setEnabled(row, $event as boolean)"
          />
          <el-tag v-else size="small" :type="row.enabled ? 'success' : 'info'" disable-transitions>
            {{ t(row.enabled ? 'mcp.tool.on' : 'mcp.tool.off') }}
          </el-tag>
        </template>
      </QwTable>
    </el-card>
  </div>
</template>

<style scoped>
.mcp-tool__intro {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 20px;
  color: var(--qw-text-2);
}
.mcp-tool__endpoint {
  max-width: 640px;
}
.mcp-tool__endpoint :deep(.el-form-item) {
  margin-bottom: 8px;
}
.mcp-tool__hint {
  display: flex;
  gap: 6px;
  align-items: center;
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--qw-text-3);
}
.mcp-tool__mono,
.mcp-tool__mono :deep(input) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.mcp-tool__muted {
  color: var(--qw-text-3);
}
</style>
