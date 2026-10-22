<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { type AgentItemVo, markdownTables } from '@qiwu/shared'
import { agentOutputApi } from '@/api/platform/agent-output'
import QwChart from '@/core/components/QwChart.vue'
import { toastRest } from '@/core/composables/use-crud'
import { Icon } from '@/core/icons'
import { saveBlob } from '@/core/request/http'
import { MarkdownText } from './markdown'
import { chartOption, fileName, reportMarkdown } from './output'

type OutputItem = Extract<AgentItemVo, { kind: 'chart' | 'image' | 'report' | 'subagent' }>

/**
 * 智能体产出的卡片：图表（声明式配置交给 QwChart，表格类直接渲染成表格）、生成的图片（按本人的权限取私有
 * 文件预览）、研究报告（Markdown 安全子集、编号来源、未核实的标出；导出 Markdown、打印为 PDF、逐张表格导出
 * xlsx）、子任务（各自的状态与摘要，可在新窗口打开子会话）。颜色只用 `--qw-*`；模型给的文字一律作为文本渲染。
 * `readonly`（分享的快照）时不提供导出与下载。
 */
defineOptions({ name: 'AgentOutputCard' })
const { item, readonly = false } = defineProps<{ item: OutputItem; readonly?: boolean }>()
const { t } = useI18n()
const route = useRoute()
const router = useRouter()

// ---- 导出（同一时间只做一件，按钮在请求期间转圈并禁用）----
const busy = ref<string | null>(null)
async function exportXlsx(title: string, table?: number) {
  if (busy.value) return
  busy.value = table == null ? 'xlsx' : `table-${table}`
  try {
    await agentOutputApi.xlsx(item.id, `${fileName(title, 'export')}.xlsx`, table)
  } catch (e) {
    toastRest(e)
  } finally {
    busy.value = null
  }
}

// ---- 图表 ----
const option = computed(() => (item.kind === 'chart' ? chartOption(item.payload) : null))

// ---- 图片：私有文件按本人的会话取出，换成本地地址预览；卸载时释放。分享的快照不取（文件只给本人）----
const imageUrl = ref<string | null>(null)
const imageFailed = ref(false)
/** 取到的图片的扩展名（按实际类型），下载时用 */
const imageExt = ref('png')
const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}
let objectUrl: string | null = null
function releaseImage() {
  if (objectUrl) URL.revokeObjectURL(objectUrl)
  objectUrl = null
}
watch(
  () => (item.kind === 'image' ? item.payload.fileId : null),
  async (fileId) => {
    releaseImage()
    imageUrl.value = null
    imageFailed.value = false
    if (fileId == null || readonly) return
    try {
      const blob = await agentOutputApi.image(fileId)
      imageExt.value = IMAGE_EXT[blob.type] ?? 'png'
      objectUrl = URL.createObjectURL(blob)
      imageUrl.value = objectUrl
    } catch {
      imageFailed.value = true
    }
  },
  { immediate: true },
)
onBeforeUnmount(releaseImage)
function downloadImage() {
  if (item.kind !== 'image' || !imageUrl.value) return
  const a = document.createElement('a')
  a.href = imageUrl.value
  a.download = `${fileName(item.payload.prompt, 'image')}.${imageExt.value}`
  a.click()
}

// ---- 报告 ----
const tables = computed(() => (item.kind === 'report' ? markdownTables(item.payload.text) : []))
function exportMarkdown() {
  if (item.kind !== 'report') return
  saveBlob(
    new Blob([reportMarkdown(item.payload)], { type: 'text/markdown;charset=utf-8' }),
    `${fileName(item.payload.title, 'report')}.md`,
  )
}
const reportEl = useTemplateRef<HTMLElement>('report')
/** 打印为 PDF：打印期间只显示这份报告（见下方的打印样式），打印对话框关闭后还原。 */
function printReport() {
  const el = reportEl.value
  if (!el) return
  document.body.classList.add('qw-print-report')
  el.classList.add('qw-print-target')
  const done = () => {
    document.body.classList.remove('qw-print-report')
    el.classList.remove('qw-print-target')
    window.removeEventListener('afterprint', done)
  }
  window.addEventListener('afterprint', done)
  window.print()
}

// ---- 子任务 ----
const STATUS_TAG = {
  queued: 'info',
  running: 'info',
  waiting: 'warning',
  completed: 'success',
  failed: 'danger',
  cancelled: 'warning',
} as const
const threadHref = (threadId: number) =>
  router.resolve({ path: route.path, query: { thread: String(threadId) } }).href
</script>

<template>
  <section
    v-if="item.kind === 'chart'"
    class="agent-card agent-output"
    :aria-label="item.payload.title || t('agent.output.chart.title')"
  >
    <header class="agent-output__head">
      <span class="agent-card__title">{{
        item.payload.title || t('agent.output.chart.title')
      }}</span>
      <el-button
        v-if="!readonly"
        size="small"
        :loading="busy === 'xlsx'"
        :disabled="busy !== null"
        @click="exportXlsx(item.payload.title)"
      >
        <Icon icon="lucide:sheet" /> {{ t('agent.output.export.xlsx') }}
      </el-button>
    </header>
    <div v-if="item.payload.kind === 'table'" class="agent-output__table">
      <table>
        <thead>
          <tr>
            <th v-for="(c, k) in item.payload.categories" :key="k">{{ c }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(s, r) in item.payload.series" :key="r">
            <td v-for="(_, k) in item.payload.categories" :key="k">{{ s.data[k] ?? '' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <QwChart
      v-else-if="option"
      class="agent-output__chart"
      :option
      :title="item.payload.title || t('agent.output.chart.title')"
    />
  </section>

  <section
    v-else-if="item.kind === 'image'"
    class="agent-card agent-output"
    :aria-label="t('agent.output.image.title')"
  >
    <header class="agent-output__head">
      <span class="agent-card__title">{{ t('agent.output.image.title') }}</span>
      <el-button v-if="!readonly && imageUrl" size="small" @click="downloadImage">
        <Icon icon="lucide:download" /> {{ t('agent.output.image.download') }}
      </el-button>
    </header>
    <img v-if="imageUrl" class="agent-output__image" :src="imageUrl" :alt="item.payload.prompt" />
    <p v-else-if="readonly" class="agent-card__meta">{{ t('agent.output.image.shared') }}</p>
    <p v-else-if="imageFailed" class="agent-card__meta">{{ t('agent.output.image.failed') }}</p>
    <p class="agent-card__meta agent-output__prompt">{{ item.payload.prompt }}</p>
  </section>

  <article
    v-else-if="item.kind === 'report'"
    ref="report"
    class="agent-card agent-output agent-report"
    :aria-label="item.payload.title"
  >
    <header class="agent-output__head">
      <span class="agent-card__meta">{{ t('agent.output.report.label') }}</span>
      <div v-if="!readonly" class="agent-output__actions">
        <el-button size="small" @click="exportMarkdown">
          <Icon icon="lucide:file-text" /> {{ t('agent.output.report.markdown') }}
        </el-button>
        <el-button size="small" @click="printReport">
          <Icon icon="lucide:printer" /> {{ t('agent.output.report.print') }}
        </el-button>
        <el-button
          v-for="(_, k) in tables"
          :key="k"
          size="small"
          :loading="busy === `table-${k}`"
          :disabled="busy !== null"
          @click="exportXlsx(item.payload.title, k)"
        >
          <Icon icon="lucide:sheet" />
          {{
            tables.length > 1
              ? t('agent.output.report.tableN', { n: k + 1 })
              : t('agent.output.report.table')
          }}
        </el-button>
      </div>
    </header>
    <h3 class="agent-report__title">{{ item.payload.title }}</h3>
    <MarkdownText :text="item.payload.text" />
    <template v-if="item.payload.citations.length">
      <span class="agent-card__meta">{{ t('agent.output.report.sources') }}</span>
      <ol class="agent-report__sources">
        <li v-for="(c, k) in item.payload.citations" :key="k">
          <a
            v-if="/^https?:/i.test(c.url)"
            :href="c.url"
            target="_blank"
            rel="noopener noreferrer"
            >{{ c.title || c.url }}</a
          >
          <template v-else>
            <span>{{ c.title }}</span>
            <el-tag size="small" type="warning">{{ t('agent.output.report.unverified') }}</el-tag>
          </template>
        </li>
      </ol>
    </template>
  </article>

  <section
    v-else-if="item.kind === 'subagent'"
    class="agent-card agent-output"
    :aria-label="t('agent.output.subagent.title')"
  >
    <span class="agent-card__title">{{ t('agent.output.subagent.title') }}</span>
    <ul class="agent-subagents">
      <li v-for="task in item.payload.tasks" :key="task.threadId" class="agent-subagents__task">
        <div class="agent-subagents__head">
          <span class="agent-subagents__name">{{ task.title }}</span>
          <el-tag size="small" :type="STATUS_TAG[task.status]">
            {{ t(`agent.output.subagent.status.${task.status}`) }}
          </el-tag>
          <a
            v-if="!readonly"
            class="agent-subagents__open"
            :href="threadHref(task.threadId)"
            target="_blank"
            rel="noopener"
            >{{ t('agent.output.subagent.open') }}</a
          >
        </div>
        <details v-if="task.summary" class="agent-subagents__summary">
          <summary>{{ t('agent.output.subagent.summary') }}</summary>
          <MarkdownText :text="task.summary" />
        </details>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.agent-output__head {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
}
.agent-output__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.agent-output__actions .el-button + .el-button {
  margin-left: 0;
}
.agent-output__chart {
  height: 280px;
}
.agent-output__table {
  overflow: auto;
}
.agent-output__table table {
  width: 100%;
  border-collapse: collapse;
}
.agent-output__table th,
.agent-output__table td {
  padding: 4px 8px;
  text-align: left;
  border: 1px solid var(--qw-border);
}
.agent-output__table th {
  background: var(--qw-surface-2);
}
.agent-output__image {
  display: block;
  max-width: 100%;
  max-height: 480px;
  border-radius: var(--qw-radius-sm);
}
.agent-output__prompt {
  white-space: pre-wrap;
}
.agent-report__title {
  margin: 4px 0;
  font-size: 18px;
  color: var(--qw-text);
}
.agent-report__sources {
  padding-left: 20px;
  margin: 0;
  color: var(--qw-text-2);
}
.agent-report__sources li {
  display: flex;
  gap: 6px;
  align-items: center;
}
.agent-subagents {
  display: grid;
  gap: 6px;
  padding: 0;
  margin: 0;
  list-style: none;
}
.agent-subagents__task {
  padding: 6px 8px;
  background: var(--qw-surface-2);
  border-radius: var(--qw-radius-sm);
}
.agent-subagents__head {
  display: flex;
  gap: 8px;
  align-items: center;
}
.agent-subagents__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-subagents__open {
  color: var(--qw-brand-text);
}
.agent-subagents__summary summary {
  color: var(--qw-text-3);
  cursor: pointer;
}
</style>

<style>
/* print as PDF: only the chosen report (printReport sets the classes, afterprint removes them) */
@media print {
  body.qw-print-report * {
    visibility: hidden;
  }
  body.qw-print-report .qw-print-target,
  body.qw-print-report .qw-print-target * {
    visibility: visible;
  }
  body.qw-print-report .qw-print-target {
    position: absolute;
    inset: 0 auto auto 0;
    width: 100%;
    border: 0;
  }
  body.qw-print-report .qw-print-target .agent-output__actions {
    display: none;
  }
}
</style>
