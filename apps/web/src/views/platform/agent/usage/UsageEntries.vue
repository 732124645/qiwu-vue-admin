<script setup lang="ts">
import { onBeforeUnmount, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import type { AgentUsageEntryVo } from '@qiwu/shared'
import { agentUsageApi } from '@/api/platform/agent-admin'
import CodeViewer from '@/core/components/CodeViewer.vue'
import Pagination from '@/core/components/Pagination.vue'
import QwTable from '@/core/components/QwTable.vue'
import { toastRest } from '@/core/composables/use-crud'
import type { QwColumn } from '@/core/composables/use-table-prefs'

/** 分页检查供应商原始用量与已保存的费率快照，未知和旧记录都不补算成0。 */
defineOptions({ name: 'AgentUsageEntries' })
const { from, to } = defineProps<{ from: string; to: string }>()
const emit = defineEmits<{ cancel: [] }>()
const { t } = useI18n()
const page = ref(1)
const pageSize = ref(10)
const total = ref(0)
const rows = shallowRef<AgentUsageEntryVo[]>([])
const selected = shallowRef<AgentUsageEntryVo>()
const loading = ref(false)
const columns: QwColumn[] = [
  { prop: 'createdAt', label: 'agent.admin.diag.f.at', width: 160 },
  { prop: 'status', label: 'agent.admin.usage.invocationStatus', width: 120 },
  { prop: 'providerName', label: 'agent.admin.provider.entity', minWidth: 150 },
  { prop: 'model', label: 'agent.admin.model.id', minWidth: 160 },
  { prop: 'credits', label: 'agent.admin.usage.credits', width: 130 },
  { prop: 'usageReported', label: 'agent.admin.usage.rawUsage', minWidth: 170 },
]
let seq = 0
onBeforeUnmount(() => seq++)
/** 仅展示当前页的应答，旧分页请求不得覆盖较新的选择。 */
async function load() {
  const mine = ++seq
  loading.value = true
  selected.value = undefined
  try {
    const result = await agentUsageApi.entries({
      from,
      to,
      page: page.value,
      pageSize: pageSize.value,
      sort: '-createdAt',
    })
    if (mine !== seq) return
    rows.value = result.items
    total.value = result.total
  } catch (error) {
    if (mine === seq) toastRest(error)
  } finally {
    if (mine === seq) loading.value = false
  }
}
void load()
</script>

<template>
  <div>
    <p>{{ t('agent.admin.usage.hint') }}</p>
    <QwTable
      table-id="agent.usageEntry"
      :columns="columns"
      :data="rows"
      :loading="loading"
      row-key="id"
    >
      <template #cell-createdAt="{ row }">{{
        dayjs(row.createdAt).format('YYYY-MM-DD HH:mm:ss')
      }}</template>
      <template #cell-status="{ row }">
        <el-tag
          :type="
            row.status === 'unknown' ? 'warning' : row.status === 'pending' ? 'info' : 'success'
          "
        >
          {{ t(`agent.admin.usage.state.${row.status ?? 'complete'}`) }}
        </el-tag>
      </template>
      <template #cell-credits="{ row }">{{
        row.credits ??
        t(
          row.status === 'pending'
            ? 'agent.admin.usage.state.pending'
            : 'agent.admin.usage.unpriced',
        )
      }}</template>
      <template #cell-usageReported="{ row }">{{
        row.status === 'pending'
          ? t('agent.admin.usage.state.pending')
          : row.usageReported
            ? t('agent.admin.on')
            : t(
                row.usage?.estimated
                  ? 'agent.admin.usage.estimated'
                  : 'agent.admin.usage.unreported',
              )
      }}</template>
      <template #actions="{ row }"
        ><el-button link type="primary" @click="selected = row">{{
          t('agent.admin.usage.entry')
        }}</el-button></template
      >
    </QwTable>
    <Pagination v-model:page="page" v-model:page-size="pageSize" :total="total" @change="load" />
    <section v-if="selected" class="usage-entries__detail">
      <h3>{{ selected.providerName }} / {{ selected.model }}</h3>
      <p v-if="selected.status === 'pending'">{{ t('agent.admin.usage.pendingHint') }}</p>
      <p v-else-if="!selected.usage && !selected.pricing">{{ t('agent.admin.usage.legacy') }}</p>
      <p v-else-if="!selected.usageReported">
        {{
          t(
            selected.usage?.estimated
              ? 'agent.admin.usage.estimated'
              : 'agent.admin.usage.unreported',
          )
        }}
      </p>
      <p>
        {{ t('agent.admin.usage.credits') }}:
        {{
          selected.credits ??
          t(
            selected.status === 'pending'
              ? 'agent.admin.usage.state.pending'
              : 'agent.admin.usage.unpriced',
          )
        }}
      </p>
      <CodeViewer
        :files="[
          { path: 'usage.json', content: JSON.stringify(selected.usage, null, 2) },
          { path: 'pricing.json', content: JSON.stringify(selected.pricing, null, 2) },
          { path: 'entry.json', content: JSON.stringify(selected, null, 2) },
        ]"
        height="320px"
      />
    </section>
    <div class="qw-dialog-footer">
      <el-button @click="emit('cancel')">{{ t('agent.admin.close') }}</el-button>
    </div>
  </div>
</template>

<style scoped>
.usage-entries__detail {
  margin-top: 16px;
}
</style>
