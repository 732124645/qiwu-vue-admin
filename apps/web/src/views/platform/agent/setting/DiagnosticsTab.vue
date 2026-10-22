<script setup lang="ts">
import { ref, shallowRef } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import type { AgentDiagnosticsVo } from '@qiwu/shared'
import { agentDiagnosticsApi, type AgentProbeResult } from '@/api/platform/agent-admin'
import { toastRest } from '@/core/composables/use-crud'

/**
 * “诊断”标签：模型、搜索与外部 MCP 的配置概况，轮次队列积压，所有租户里进行中与今天失败的轮次数，
 * 最近失败的轮次（只有编号、租户、原因码与说明）和孤儿轮次清理统计；可对每一项做连通测试，结果（用时
 * 或原因说明）显示在该行。整个标签只给 root（设置页对其他人不显示它）。
 */
defineOptions({ name: 'AgentDiagnosticsTab' })
type Kind = 'provider' | 'search' | 'mcp'
const { t, te } = useI18n()
const vo = shallowRef<AgentDiagnosticsVo | null>(null)
const loading = ref(false)
/** 窄屏下各组概况改为一列，避免横向溢出 */
const narrow = useMediaQuery('(max-width: 767px)')
/** 正在测试的行（`<kind>-<id>`）与各行最近一次的结果 */
const testing = ref<string | null>(null)
const results = ref<Record<string, AgentProbeResult>>({})

/** 重新载入概况。 */
async function refresh() {
  loading.value = true
  try {
    vo.value = await agentDiagnosticsApi.get()
  } catch (e) {
    toastRest(e)
  } finally {
    loading.value = false
  }
}
void refresh()

/** 测试一行；同一时刻只测一项（每项都会向外发请求）。 */
async function test(kind: Kind, id: number) {
  const key = `${kind}-${id}`
  testing.value = key
  try {
    results.value = { ...results.value, [key]: await agentDiagnosticsApi.test(kind, id) }
  } catch (e) {
    toastRest(e)
  } finally {
    testing.value = null
  }
}

/** 原因码的说明：常见的翻译，`http_<状态码>` 带上状态码，不认识的原样显示。 */
function reasonText(code: string) {
  const http = /^http_(\d{3})$/.exec(code)
  if (http) return t('agent.admin.diag.reason.http', { status: http[1] })
  const key = `agent.admin.diag.reason.${code}`
  return te(key) ? t(key) : code
}
const resultText = (r: AgentProbeResult) =>
  r.ok
    ? t('agent.admin.diag.ok', { ms: r.ms })
    : t('agent.admin.diag.failed', { error: reasonText(r.error ?? 'failed'), ms: r.ms })
const time = (iso: string | null) =>
  iso ? dayjs(iso).format('YYYY-MM-DD HH:mm:ss') : t('agent.admin.diag.never')
const QUEUE = ['waiting', 'active', 'failed', 'delayed'] as const
const TURNS = ['running', 'waiting', 'failedToday'] as const
</script>

<template>
  <div v-loading="loading" class="agent-diag">
    <div class="agent-diag__bar">
      <span class="agent-diag__spacer" />
      <el-button :loading @click="refresh">{{ t('crud.action.refresh') }}</el-button>
    </div>

    <template v-if="vo">
      <el-descriptions :column="narrow ? 1 : 4" border :title="t('agent.admin.diag.queue')">
        <el-descriptions-item v-for="k in QUEUE" :key="k" :label="t(`agent.admin.diag.q.${k}`)">
          {{ vo.queue[k] }}
        </el-descriptions-item>
      </el-descriptions>
      <el-descriptions :column="narrow ? 1 : 3" border :title="t('agent.admin.diag.turns')">
        <el-descriptions-item v-for="k in TURNS" :key="k" :label="t(`agent.admin.diag.turn.${k}`)">
          {{ vo.turns[k] }}
        </el-descriptions-item>
      </el-descriptions>
      <el-descriptions :column="narrow ? 1 : 3" border :title="t('agent.admin.diag.sweeps')">
        <el-descriptions-item :label="t('agent.admin.diag.sweep.lastAt')">
          {{ time(vo.sweeps.lastAt) }}
        </el-descriptions-item>
        <el-descriptions-item :label="t('agent.admin.diag.sweep.requeued')">
          {{ vo.sweeps.requeued }}
        </el-descriptions-item>
        <el-descriptions-item :label="t('agent.admin.diag.sweep.failed')">
          {{ vo.sweeps.failed }}
        </el-descriptions-item>
      </el-descriptions>

      <h3 class="agent-diag__title">{{ t('agent.admin.diag.providers') }}</h3>
      <el-table :data="vo.providers" row-key="id" data-kind="provider">
        <el-table-column prop="name" :label="t('agent.admin.diag.name')" min-width="160" />
        <el-table-column :label="t('agent.admin.diag.enabled')" width="90">
          <template #default="{ row }">{{
            t(row.enabled ? 'agent.admin.on' : 'agent.admin.off')
          }}</template>
        </el-table-column>
        <el-table-column :label="t('agent.admin.diag.key')" width="100">
          <template #default="{ row }">
            {{ t(row.hasKey ? 'agent.admin.keyStored' : 'agent.admin.keyMissing') }}
          </template>
        </el-table-column>
        <el-table-column :label="t('agent.admin.diag.result')" min-width="200">
          <template #default="{ row }">
            <template v-if="results[`provider-${row.id}`]">
              {{ resultText(results[`provider-${row.id}`]!) }}
            </template>
          </template>
        </el-table-column>
        <el-table-column :label="t('crud.action.operations')" width="100">
          <template #default="{ row }">
            <el-button
              link
              type="primary"
              :loading="testing === `provider-${row.id}`"
              :disabled="testing !== null"
              @click="test('provider', row.id)"
            >
              {{ t('agent.admin.diag.test') }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <h3 class="agent-diag__title">{{ t('agent.admin.diag.search') }}</h3>
      <el-table :data="vo.search" row-key="id" data-kind="search">
        <el-table-column prop="name" :label="t('agent.admin.diag.name')" min-width="160" />
        <el-table-column :label="t('agent.admin.diag.enabled')" width="90">
          <template #default="{ row }">{{
            t(row.enabled ? 'agent.admin.on' : 'agent.admin.off')
          }}</template>
        </el-table-column>
        <el-table-column :label="t('agent.admin.diag.result')" min-width="200">
          <template #default="{ row }">
            <template v-if="results[`search-${row.id}`]">
              {{ resultText(results[`search-${row.id}`]!) }}
            </template>
          </template>
        </el-table-column>
        <el-table-column :label="t('crud.action.operations')" width="100">
          <template #default="{ row }">
            <el-button
              link
              type="primary"
              :loading="testing === `search-${row.id}`"
              :disabled="testing !== null"
              @click="test('search', row.id)"
            >
              {{ t('agent.admin.diag.test') }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <h3 class="agent-diag__title">{{ t('agent.admin.diag.mcp') }}</h3>
      <el-table :data="vo.mcpServers" row-key="id" data-kind="mcp">
        <el-table-column prop="name" :label="t('agent.admin.diag.name')" min-width="160" />
        <el-table-column :label="t('agent.admin.diag.status')" width="110">
          <template #default="{ row }">{{ t(`agent.admin.mcp.state.${row.status}`) }}</template>
        </el-table-column>
        <el-table-column
          :label="t('agent.admin.diag.lastError')"
          min-width="160"
          show-overflow-tooltip
        >
          <template #default="{ row }">{{ row.lastError && reasonText(row.lastError) }}</template>
        </el-table-column>
        <el-table-column :label="t('agent.admin.diag.result')" min-width="200">
          <template #default="{ row }">
            <template v-if="results[`mcp-${row.id}`]">
              {{ resultText(results[`mcp-${row.id}`]!) }}
            </template>
          </template>
        </el-table-column>
        <el-table-column :label="t('crud.action.operations')" width="100">
          <template #default="{ row }">
            <el-button
              link
              type="primary"
              :loading="testing === `mcp-${row.id}`"
              :disabled="testing !== null"
              @click="test('mcp', row.id)"
            >
              {{ t('agent.admin.diag.test') }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <h3 class="agent-diag__title">{{ t('agent.admin.diag.failures') }}</h3>
      <el-table :data="vo.recentFailures" row-key="turnId" data-kind="failures">
        <el-table-column prop="turnId" :label="t('agent.admin.diag.f.turnId')" width="100" />
        <el-table-column prop="tenantId" :label="t('agent.admin.diag.f.tenantId')" width="90" />
        <el-table-column prop="code" :label="t('agent.admin.diag.f.code')" width="110" />
        <el-table-column
          prop="message"
          :label="t('agent.admin.diag.f.message')"
          min-width="200"
          show-overflow-tooltip
        />
        <el-table-column :label="t('agent.admin.diag.f.at')" width="180">
          <template #default="{ row }">{{ time(row.at) }}</template>
        </el-table-column>
      </el-table>
    </template>
  </div>
</template>

<style scoped>
.agent-diag {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.agent-diag__bar {
  display: flex;
  align-items: center;
}
.agent-diag__spacer {
  flex: 1;
}
.agent-diag__title {
  margin: 8px 0 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--qw-text);
}
</style>
