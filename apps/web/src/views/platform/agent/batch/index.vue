<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useDebounceFn, useDocumentVisibility } from '@vueuse/core'
import { ElMessage } from 'element-plus'
import { RT, type AgentBatchDetailVo } from '@qiwu/shared'
import { agentBatchApi } from '@/api/platform/agent-batch'
import { toastRest } from '@/core/composables/use-crud'
import { onRealtime } from '@/core/realtime/socket'
import { Icon } from '@/core/icons'
import ApprovalCard from '../chat/ApprovalCard.vue'

/**
 * 批次审批页（`?id=<批次>`，从列表的“让智能体补齐”打开）：每条记录一行，显示轮次状态与等待确认的修改
 * （逐字段旧值 → 新值与来源，可逐条确认），也可一次确认或拒绝全部（目标不是该行记录的会被跳过，留在列表里
 * 逐条决定）；每行可打开对应会话。批次未完成时每隔几秒刷新一次，收到这些会话的 `agent:event` 也刷新；
 * 页面隐藏（keep-alive 切走或浏览器标签不可见）时停止轮询，回来时立即刷新。
 */
defineOptions({ name: 'AgentBatch' })
const POLL_MS = 3000
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const detail = shallowRef<AgentBatchDetailVo | null>(null)
const loading = ref(false)
const deciding = ref<'approve' | 'reject' | null>(null)
const id = computed(() => Number(route.query.id))
const pendingCount = computed(
  () => detail.value?.rows.reduce((n, r) => n + r.pending.length, 0) ?? 0,
)
let timer: ReturnType<typeof setTimeout> | undefined
let active = true
const visibility = useDocumentVisibility()

/** 读批次；进行中且页面显示着时稍后再读。 */
async function load() {
  clearTimeout(timer)
  if (!active || !Number.isInteger(id.value) || id.value <= 0) return
  loading.value = !detail.value
  try {
    detail.value = await agentBatchApi.get(id.value)
  } catch (e) {
    toastRest(e)
    return
  } finally {
    loading.value = false
  }
  if (detail.value.batch.status === 'running' && active && visibility.value !== 'hidden')
    timer = setTimeout(() => void load(), POLL_MS)
}
const refresh = useDebounceFn(load, 300)
// 本批次的会话有变化（新的审批、轮次结束）时尽快刷新，不必等下一次轮询
onRealtime(RT.agentEvent, (ev) => {
  if (detail.value?.rows.some((r) => r.threadId === ev.threadId)) void refresh()
})
watch(visibility, (v) => (v === 'hidden' ? clearTimeout(timer) : void load()))
onActivated(() => {
  if (active) return
  active = true
  void load()
})
onDeactivated(() => {
  active = false
  clearTimeout(timer)
})

/** 一次确认或拒绝全部等待中的修改；请求进行中两个按钮都不可点。 */
async function decideAll(decision: 'approve' | 'reject') {
  if (deciding.value) return
  deciding.value = decision
  try {
    const { decided, skipped } = await agentBatchApi.decide(id.value, decision)
    ElMessage.success(t('agent.batch.decided', { count: decided }))
    // 改的不是该行记录的审批服务端不批量处理，留在列表里逐条决定
    if (skipped > 0) ElMessage.warning(t('agent.batch.skipped', { count: skipped }))
    await load()
  } catch (e) {
    toastRest(e)
  } finally {
    deciding.value = null
  }
}

/** 一行的记录名：批次目标的显示名，没有时只显示编号。 */
function recordOf(row: AgentBatchDetailVo['rows'][number]): string {
  return row.label || `#${row.targetId}`
}

function openThread(threadId: number) {
  void router.push({ name: 'agent-chat', query: { thread: String(threadId) } })
}

watch(id, () => void load(), { immediate: true })
onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <div v-loading="loading" class="qw-page agent-batch">
    <el-card v-if="detail" class="qw-table-panel">
      <header class="agent-batch__head">
        <div class="agent-batch__summary">
          <h2 class="agent-batch__title">{{ t('agent.batch.title') }}</h2>
          <el-tag size="small" :type="detail.batch.status === 'running' ? 'primary' : 'success'">
            {{ t(`agent.batch.status.${detail.batch.status}`) }}
          </el-tag>
          <span class="agent-batch__meta">
            {{
              t('agent.batch.summary', {
                skill: detail.batch.skill,
                total: detail.batch.total,
                finished: detail.batch.finished,
                failed: detail.batch.failed,
              })
            }}
          </span>
        </div>
        <div class="agent-batch__actions">
          <el-button
            type="primary"
            :disabled="!pendingCount || deciding !== null"
            :loading="deciding === 'approve'"
            @click="decideAll('approve')"
          >
            <el-icon class="el-icon--left"><Icon icon="lucide:check-check" /></el-icon>
            {{ t('agent.batch.approveAll', { count: pendingCount }) }}
          </el-button>
          <el-button
            :disabled="!pendingCount || deciding !== null"
            :loading="deciding === 'reject'"
            @click="decideAll('reject')"
          >
            {{ t('agent.batch.rejectAll') }}
          </el-button>
        </div>
      </header>

      <ul class="agent-batch__rows">
        <li v-for="row in detail.rows" :key="row.threadId" class="agent-batch__row">
          <div class="agent-batch__row-head">
            <span class="agent-batch__record">{{ recordOf(row) }}</span>
            <el-tag size="small" type="info">
              {{
                row.turnStatus ? t(`agent.chat.turn.${row.turnStatus}`) : t('agent.batch.queued')
              }}
            </el-tag>
            <el-button link type="primary" @click="openThread(row.threadId)">
              {{ t('agent.batch.open') }}
            </el-button>
          </div>
          <ApprovalCard v-for="item in row.pending" :key="item.id" :item="item" @decided="load" />
        </li>
      </ul>
    </el-card>
    <el-empty v-else-if="!loading" :description="t('agent.batch.missing')" />
  </div>
</template>

<style scoped>
.agent-batch__head {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.agent-batch__summary {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.agent-batch__title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}
.agent-batch__meta {
  color: var(--qw-text-2);
}
.agent-batch__rows {
  display: grid;
  gap: 12px;
  padding: 0;
  margin: 0;
  list-style: none;
}
.agent-batch__row {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius);
}
.agent-batch__row-head {
  display: flex;
  gap: 8px;
  align-items: center;
}
.agent-batch__record {
  font-weight: 600;
}
</style>
