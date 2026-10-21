<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import { agentApi } from '@/api/platform/agent'
import IconButton from '@/core/components/IconButton.vue'
import { toastRest } from '@/core/composables/use-crud'
import { Icon } from '@/core/icons'
import ApprovalCard from './ApprovalCard.vue'
import { MarkdownText } from './markdown'
import QuestionCard from './QuestionCard.vue'
import { show, type ChatRow } from './thread-state'

/**
 * 对话里的一行：用户气泡（附件、排队标记）、助手回答（Markdown 安全子集、编号来源、后续建议）、
 * 可折叠的“思考”、压缩分隔线、工具调用与结果合成的折叠卡（轮次结束仍没有结果的显示“已停止”）、审批卡、
 * 反问卡、计划清单、错误提示（显示翻译后的说明，不显示错误码）。
 * 消息上的操作：复制、从这里分叉、编辑最后一条用户消息重发、给回答点赞 / 点踩（可附说明）；计划模式下
 * 最后一条回答可“执行此计划”。
 */
defineOptions({ name: 'AgentChatItem' })
const {
  row,
  canFork = false,
  canEdit = false,
  last = false,
  readonly = false,
  trust = true,
  canRunPlan = false,
  runningPlan = false,
} = defineProps<{
  row: ChatRow
  canFork?: boolean
  /** 最后一条用户消息：可编辑后重发 */
  canEdit?: boolean
  /** 最后一行：显示后续建议 */
  last?: boolean
  /** 分享的只读快照 */
  readonly?: boolean
  /** 审批卡是否提供“本会话内同意” */
  trust?: boolean
  /** 计划模式下最后一条已完成的回答：可执行此计划 */
  canRunPlan?: boolean
  runningPlan?: boolean
}>()
const emit = defineEmits<{
  fork: [seq: number]
  edit: [seq: number, text: string]
  suggest: [text: string]
  changed: []
  runPlan: []
}>()
const { t, te } = useI18n()

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
      <span class="agent-card__title">{{ row.call.payload.title || row.call.payload.tool }}</span>
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
    <div v-if="row.item.kind === 'user'" class="agent-msg agent-msg--user">
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
          @click="emit('edit', row.item.seq, row.item.payload.text)"
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
        <MarkdownText v-if="row.item.payload.text" :text="row.item.payload.text" />
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
              v-if="/^https?:/i.test(c.url)"
              :href="c.url"
              target="_blank"
              rel="noopener noreferrer"
              >{{ c.title || c.url }}</a
            >
            <span v-else>{{ c.title || c.url }}</span>
          </li>
        </ol>
        <div v-if="row.item.status !== 'running'" class="agent-msg__actions">
          <IconButton
            icon="lucide:copy"
            :label="t('agent.chat.action.copy')"
            @click="copy(row.item.payload.text)"
          />
          <template v-if="!readonly">
            <IconButton
              v-if="canFork"
              icon="lucide:git-branch"
              :label="t('agent.chat.fork')"
              @click="emit('fork', row.item.seq)"
            />
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
        </div>
        <el-button
          v-if="canRunPlan && !readonly && row.item.status === 'done'"
          type="primary"
          size="small"
          class="agent-msg__run-plan"
          :loading="runningPlan"
          :disabled="runningPlan"
          @click="emit('runPlan')"
        >
          {{ t('agent.chat.planRun.action') }}
        </el-button>
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
      :trust
      @decided="emit('changed')"
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
