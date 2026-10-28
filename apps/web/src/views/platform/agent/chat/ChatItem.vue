<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AgentPlanDecide } from '@qiwu/shared'
import { toolTitle } from '../tool-presentation'
import { ElMessage, ElMessageBox } from 'element-plus'
import { agentApi } from '@/api/platform/agent'
import IconButton from '@/core/components/IconButton.vue'
import { toastRest } from '@/core/composables/use-crud'
import { Icon } from '@/core/icons'
import ApprovalCard from './ApprovalCard.vue'
import { MarkdownText, safeMarkdownHref } from './markdown'
import { saveBlob } from '@/core/request/http'
import OutputCard from './OutputCard.vue'
import PlanCard from './PlanCard.vue'
import QuestionCard from './QuestionCard.vue'
import { show, type ChatRow } from './thread-state'

/**
 * 对话里的一行：用户气泡（附件、排队标记）、助手回答（Markdown 安全子集、编号来源、后续建议）、
 * 可折叠的“思考”、压缩分隔线、工具调用与结果合成的折叠卡（轮次结束仍没有结果的显示“已停止”）、审批卡、
 * 反问卡、方案卡（计划模式的 `plan.propose`）、计划清单、图表 / 图片 / 报告 / 子任务卡片（OutputCard）、错误提示（显示翻译后的说明，不显示错误码）。
 * 消息上的操作只有一行，悬停或焦点在这条消息里时才显示：用户消息复制、从这里重新编辑（原地回退到这条并把它
 * 放回输入框）、分叉；回答复制、分叉，最后一条回答还有“重新生成”，其余（查看源码、下载、展开阅读、点赞 / 点踩，
 * 可附说明）收在“更多”里，展开后接在同一行。回退与重新生成由页面先确认再执行。批准方案后
 * 运行时写的那条执行消息只显示一行“按已批准的方案执行”，原文可展开查看。
 */
defineOptions({ name: 'AgentChatItem' })
const {
  row,
  canFork = false,
  canEdit = false,
  canRegenerate = false,
  last = false,
  readonly = false,
  canInspect = true,
  autoReview = false,
} = defineProps<{
  row: ChatRow
  canFork?: boolean
  /** 本人的用户消息且此刻可以回退：提供“从这里重新编辑” */
  canEdit?: boolean
  /** 最后一条回答且此刻可以回退：提供“重新生成” */
  canRegenerate?: boolean
  /** 最后一行：显示后续建议 */
  last?: boolean
  /** 分享的只读快照 */
  readonly?: boolean
  /** 已位于只读详情时不重复提供没有接收方的展开按钮。 */
  canInspect?: boolean
  /** 平台提供自动审查模式：方案卡多给一个“批准并自动审查执行” */
  autoReview?: boolean
}>()
const emit = defineEmits<{
  fork: [seq: number]
  edit: [seq: number]
  regenerate: []
  suggest: [text: string]
  changed: []
  planDecided: [decision: AgentPlanDecide['decision']]
  inspect: [itemId: number]
  inspectChild: [threadId: number]
}>()
const { t, te } = useI18n()
const raw = ref(false)
/** 回答的“更多”操作（源码、下载、展开阅读、点赞点踩）是否展开在同一行里 */
const moreOpen = ref(false)
const moreId = `agent-msg-more-${Math.random().toString(36).slice(2, 8)}`
/** 下载原始 Markdown，不从渲染后的 HTML 或高亮节点还原。 */
function downloadMarkdown() {
  if (row.kind !== 'item' || row.item.kind !== 'assistant') return
  saveBlob(
    new Blob([row.item.payload.text], { type: 'text/markdown;charset=utf-8' }),
    `message-${row.item.id}.md`,
  )
}

/** 错误的显示文字：本页认识的错误码用本页翻译，否则用服务端按发起人语言写好的说明，从不只显示错误码。 */
function errorText(err: { code: string; message: string }) {
  const key = `agent.chat.error.${err.code}`
  return te(key) ? t(key) : err.message || t('agent.chat.error.generic')
}

const TOOL_TAG = { running: 'info', stopped: 'warning', done: 'success', failed: 'danger' } as const
/** 工具卡的状态：有结果看成败；没有结果时所在轮次已结束为“已停止”，否则“执行中” */
const toolState = computed<keyof typeof TOOL_TAG>(() => {
  if (row.kind !== 'tool') return 'running'
  if (row.result) return row.result.payload.ok ? 'done' : 'failed'
  return row.stopped ? 'stopped' : 'running'
})

const PLAN_ICON = {
  pending: 'lucide:circle',
  doing: 'lucide:circle-dot',
  done: 'lucide:circle-check',
}

/** 复制消息原文（Markdown）；剪贴板不可用时提示。 */
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success(t('agent.chat.action.copied'))
  } catch {
    ElMessage.error(t('agent.chat.action.copyFailed'))
  }
}

// 点赞 / 点踩：先问可选说明，取消则不提交；同一条只记一次
const rated = ref<1 | -1 | null>(null)
const rating = ref(false)
async function rate(itemId: number, value: 1 | -1) {
  if (rating.value || rated.value) return
  let comment = ''
  try {
    const res = (await ElMessageBox.prompt(
      t('agent.chat.feedback.prompt'),
      t(`agent.chat.feedback.${value > 0 ? 'up' : 'down'}`),
      {
        inputPlaceholder: t('agent.chat.feedback.placeholder'),
        inputValidator: (v) => (v ?? '').length <= 1000,
        confirmButtonText: t('agent.chat.feedback.send'),
        cancelButtonText: t('common.action.cancel'),
      },
    )) as { value?: string }
    comment = res.value?.trim() ?? ''
  } catch {
    return
  }
  rating.value = true
  try {
    await agentApi.feedback({ itemId, rating: value, ...(comment ? { comment } : {}) })
    rated.value = value
    ElMessage.success(t('agent.chat.feedback.thanks'))
  } catch (e) {
    toastRest(e)
  } finally {
    rating.value = false
  }
}
</script>

<template>
  <details v-if="row.kind === 'tool'" class="agent-card agent-tool">
    <summary class="agent-tool__summary">
      <Icon icon="lucide:wrench" class="agent-tool__icon" />
      <span class="agent-card__title">{{
        toolTitle(row.call.payload.tool, row.call.payload.title)
      }}</span>
      <el-tag v-if="row.result?.payload.untrusted" size="small" type="warning">
        {{ t('agent.chat.tool.external') }}
      </el-tag>
      <el-tag size="small" :type="TOOL_TAG[toolState]">
        {{ t(`agent.chat.tool.${toolState}`) }}
      </el-tag>
    </summary>
    <div class="agent-tool__body">
      <span class="agent-card__meta">{{ t('agent.chat.tool.args') }}</span>
      <pre class="agent-card__pre">{{ show(row.call.payload.args) }}</pre>
      <template v-if="row.result">
        <span class="agent-card__meta">{{ t('agent.chat.tool.result') }}</span>
        <p v-if="row.result.payload.error" class="agent-tool__error">
          {{ errorText(row.result.payload.error) }}
        </p>
        <pre v-if="row.result.payload.preview" class="agent-card__pre">{{
          row.result.payload.preview
        }}</pre>
      </template>
    </div>
  </details>

  <template v-else>
    <details
      v-if="row.item.kind === 'user' && row.item.payload.fromPlan"
      class="agent-reasoning agent-msg__from-plan"
    >
      <summary>{{ t('agent.chat.planCard.started') }}</summary>
      <p class="agent-msg__text">{{ row.item.payload.text }}</p>
    </details>
    <div v-else-if="row.item.kind === 'user'" class="agent-msg agent-msg--user">
      <div class="agent-msg__bubble">
        <div
          v-if="
            row.item.payload.skill ||
            row.item.payload.context ||
            row.item.payload.attachments?.length
          "
          class="agent-msg__tags"
        >
          <el-tag v-if="row.item.payload.skill" size="small">${{ row.item.payload.skill }}</el-tag>
          <el-tag v-if="row.item.payload.context" size="small" type="info">
            {{ row.item.payload.context.title || row.item.payload.context.route }}
            <template v-if="row.item.payload.context.ids?.length">
              · {{ t('agent.chat.context.selected', { n: row.item.payload.context.ids.length }) }}
            </template>
          </el-tag>
          <el-tag
            v-for="a in row.item.payload.attachments ?? []"
            :key="a.fileId"
            size="small"
            type="info"
          >
            <Icon icon="lucide:paperclip" /> {{ a.name }}
          </el-tag>
        </div>
        <p class="agent-msg__text">{{ row.item.payload.text }}</p>
        <el-tag
          v-if="row.item.payload.mode === 'queue' && row.item.status === 'pending'"
          size="small"
          type="warning"
          class="agent-msg__queued"
        >
          {{ t('agent.chat.queued') }}
        </el-tag>
        <el-tag
          v-else-if="
            row.item.payload.mode === 'queue' &&
            row.item.status === 'expired' &&
            row.item.turnId === null
          "
          size="small"
          type="info"
          class="agent-msg__queued-expired"
          >{{ t('agent.chat.composer.queueExpired') }}</el-tag
        >
      </div>
      <div class="agent-msg__actions">
        <IconButton
          icon="lucide:copy"
          :label="t('agent.chat.action.copy')"
          @click="copy(row.item.payload.text)"
        />
        <IconButton
          v-if="canEdit && !readonly"
          icon="lucide:pencil"
          :label="t('agent.chat.action.edit')"
          @click="emit('edit', row.item.seq)"
        />
        <IconButton
          v-if="canFork && !readonly"
          icon="lucide:git-branch"
          :label="t('agent.chat.fork')"
          @click="emit('fork', row.item.seq)"
        />
      </div>
    </div>

    <div v-else-if="row.item.kind === 'assistant'" class="agent-msg agent-msg--assistant">
      <div class="agent-msg__answer">
        <p v-if="row.item.status === 'failed'" class="agent-card__meta agent-msg__interrupted">
          {{ t('agent.chat.message.interrupted') }}
        </p>
        <template v-if="row.item.payload.text">
          <pre v-if="raw" class="agent-msg__raw">{{ row.item.payload.text }}</pre>
          <MarkdownText v-else :text="row.item.payload.text" />
        </template>
        <p v-else-if="row.item.status === 'running'" class="agent-card__meta">
          {{ t('agent.chat.thinking') }}
        </p>
        <ol
          v-if="row.item.payload.citations?.length"
          class="agent-msg__citations"
          :aria-label="t('agent.chat.citations')"
        >
          <li v-for="(c, k) in row.item.payload.citations" :key="k">
            <a
              v-if="safeMarkdownHref(c.url)"
              :href="safeMarkdownHref(c.url)!"
              target="_blank"
              rel="noopener noreferrer"
              >{{ c.title || c.url }}</a
            >
            <span v-else>{{ c.title || c.url }}</span>
          </li>
        </ol>
        <div
          v-if="row.item.payload.text || row.item.status !== 'running'"
          class="agent-msg__actions"
        >
          <template v-if="row.item.status !== 'running'">
            <IconButton
              icon="lucide:copy"
              :label="t('agent.chat.action.copy')"
              @click="copy(row.item.payload.text)"
            />
            <IconButton
              v-if="canRegenerate && !readonly"
              icon="lucide:refresh-cw"
              :label="t('agent.chat.action.regenerate')"
              @click="emit('regenerate')"
            />
            <IconButton
              v-if="canFork && !readonly"
              icon="lucide:git-branch"
              :label="t('agent.chat.fork')"
              @click="emit('fork', row.item.seq)"
            />
          </template>
          <IconButton
            icon="lucide:ellipsis"
            :label="t('agent.chat.action.more')"
            :aria-expanded="moreOpen"
            :aria-controls="moreId"
            @click="moreOpen = !moreOpen"
          />
          <span v-show="moreOpen" :id="moreId" class="agent-msg__more">
            <template v-if="row.item.payload.text">
              <IconButton
                icon="lucide:code"
                :label="t(raw ? 'agent.chat.markdown.rendered' : 'agent.chat.markdown.source')"
                :aria-pressed="raw"
                @click="raw = !raw"
              />
              <IconButton
                icon="lucide:download"
                :label="t('agent.chat.markdown.download')"
                @click="downloadMarkdown"
              />
              <IconButton
                v-if="canInspect"
                icon="lucide:expand"
                :label="t('agent.chat.markdown.expand')"
                @click="emit('inspect', row.item.id)"
              />
            </template>
            <template v-if="!readonly && row.item.status !== 'running'">
              <IconButton
                icon="lucide:thumbs-up"
                :label="t('agent.chat.feedback.up')"
                :aria-pressed="rated === 1"
                :disabled="rating || rated !== null"
                @click="rate(row.item.id, 1)"
              />
              <IconButton
                icon="lucide:thumbs-down"
                :label="t('agent.chat.feedback.down')"
                :aria-pressed="rated === -1"
                :disabled="rating || rated !== null"
                @click="rate(row.item.id, -1)"
              />
            </template>
          </span>
        </div>
        <div
          v-if="last && !readonly && row.item.payload.suggestions?.length"
          class="agent-msg__suggest"
        >
          <el-button
            v-for="s in row.item.payload.suggestions"
            :key="s"
            size="small"
            round
            @click="emit('suggest', s)"
          >
            {{ s }}
          </el-button>
        </div>
      </div>
    </div>

    <details v-else-if="row.item.kind === 'reasoning'" class="agent-reasoning">
      <summary>
        {{
          t(
            row.item.status === 'running'
              ? 'agent.chat.thought.running'
              : 'agent.chat.thought.title',
          )
        }}
        <span v-if="row.item.status === 'failed'" class="agent-card__meta agent-msg__interrupted">
          · {{ t('agent.chat.message.interrupted') }}</span
        >
      </summary>
      <p class="agent-msg__text">{{ row.item.payload.text }}</p>
    </details>

    <div v-else-if="row.item.kind === 'compaction'" class="agent-divider" role="separator">
      {{ t(row.item.payload.auto ? 'agent.chat.compaction.auto' : 'agent.chat.compaction.manual') }}
    </div>

    <ApprovalCard
      v-else-if="row.item.kind === 'approval'"
      :item="row.item"
      :readonly
      @decided="emit('changed')"
    />
    <PlanCard
      v-else-if="row.item.kind === 'question' && row.item.payload.proposal"
      :item="row.item"
      :readonly
      :auto-review="autoReview"
      @decided="emit('planDecided', $event)"
    />
    <QuestionCard
      v-else-if="row.item.kind === 'question'"
      :item="row.item"
      :readonly
      @answered="emit('changed')"
    />

    <section
      v-else-if="row.item.kind === 'plan'"
      class="agent-card agent-plan"
      :aria-label="t('agent.chat.plan')"
    >
      <span class="agent-card__title">{{ t('agent.chat.plan') }}</span>
      <ul class="agent-plan__steps">
        <li v-for="(s, k) in row.item.payload.steps" :key="k" :class="`is-${s.status}`">
          <Icon :icon="PLAN_ICON[s.status]" class="agent-plan__icon" />
          <span>{{ s.text }}</span>
          <span class="agent-sr-only">{{ t(`agent.chat.planStatus.${s.status}`) }}</span>
        </li>
      </ul>
    </section>

    <template v-else-if="row.item.kind === 'report'">
      <div v-if="canInspect" class="agent-msg__actions agent-msg__reading">
        <IconButton
          icon="lucide:expand"
          :label="t('agent.chat.markdown.expand')"
          @click="emit('inspect', row.item.id)"
        />
      </div>
      <OutputCard :item="row.item" :readonly />
    </template>

    <OutputCard
      v-else-if="
        row.item.kind === 'chart' || row.item.kind === 'image' || row.item.kind === 'subagent'
      "
      :item="row.item"
      :readonly
      @inspect-child="emit('inspectChild', $event)"
    />

    <el-alert
      v-else-if="row.item.kind === 'error'"
      type="error"
      :closable="false"
      show-icon
      :title="errorText(row.item.payload)"
    />

    <!-- 没有对应调用的工具结果 -->
    <pre v-else-if="row.item.kind === 'tool_result'" class="agent-card__pre">{{
      row.item.payload.preview
    }}</pre>
  </template>
</template>

<style scoped>
.agent-msg__raw {
  max-width: 100%;
  margin: 0 0 8px;
  padding: 12px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--qw-text);
  background: var(--qw-surface-2);
  border-radius: var(--qw-radius-sm);
}
.agent-msg__reading {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  margin-top: 8px;
}
.agent-msg__more {
  display: inline-flex;
  gap: 2px;
  padding-left: 4px;
  margin-left: 2px;
  border-left: 1px solid var(--qw-border);
}
:deep(.qw-md__task) {
  list-style: none;
}
:deep(.qw-md__task > input) {
  margin: 0 6px 0 0;
}
</style>
