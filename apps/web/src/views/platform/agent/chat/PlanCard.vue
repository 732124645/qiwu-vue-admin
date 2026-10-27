<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import type { AgentItemVo, AgentPlanDecide } from '@qiwu/shared'
import { agentApi } from '@/api/platform/agent'
import { toastRest } from '@/core/composables/use-crud'

type Decision = AgentPlanDecide['decision']

/**
 * 方案卡：计划模式下智能体用 `plan.propose` 提交的方案（标题、概述、编号步骤、预计改动、前提假设），本轮停下等
 * 本人选择。三个选项：“批准并自动审查执行”（平台提供自动审查时才有，此时是主按钮）、“批准并逐个确认”、
 * “继续完善”（先展开意见框，可不填）。批准后服务器切换会话模式并另开一轮执行。卡片本身获得焦点时 Enter
 * 等于主按钮（焦点在按钮或意见框上时不拦截）；意见框里 Enter 提交、Esc 收起。请求进行中按钮都不可再点；
 * 决定后只读显示所选的选项与时间。在输入框直接发消息等于带这条消息“继续完善”（服务器处理）。
 */
defineOptions({ name: 'AgentPlanCard' })
const {
  item,
  readonly = false,
  autoReview = false,
} = defineProps<{
  item: Extract<AgentItemVo, { kind: 'question' }>
  /** 分享的只读快照：只看不操作 */
  readonly?: boolean
  /** 平台提供自动审查模式 */
  autoReview?: boolean
}>()
const emit = defineEmits<{ decided: [decision: Decision] }>()
const { t } = useI18n()

const plan = computed(() => item.payload.proposal!)
const primary = computed<Decision>(() => (autoReview ? 'auto_review' : 'ask'))
const feedback = ref('')
const feedbackBox = ref<{ focus: () => void }>()
const refining = ref(false)
const pending = ref<Decision | null>(null)
/** 本页已提交成功、等待推送的选择 */
const sent = ref<Decision | null>(null)
const open = computed(() => !readonly && item.status === 'pending' && !sent.value)
const choice = computed(() => item.payload.choice?.decision ?? sent.value)

/** 提交选择；失败时恢复可点。只有“继续完善”带意见。 */
async function decide(decision: Decision) {
  if (!open.value || pending.value) return
  pending.value = decision
  try {
    const text = decision === 'refine' ? feedback.value.trim() : ''
    await agentApi.decidePlan(item.id, { decision, ...(text && { feedback: text }) })
    sent.value = decision
    emit('decided', decision)
  } catch (e) {
    toastRest(e)
  } finally {
    pending.value = null
  }
}
/** 展开意见框并把焦点放进去。 */
async function startRefine() {
  if (!open.value || pending.value) return
  refining.value = true
  await nextTick()
  feedbackBox.value?.focus()
}
/** 只处理卡片本身的 Enter：按钮与意见框上的按键保持原来的行为。 */
function onKey(e: KeyboardEvent) {
  if (e.isComposing || e.target !== e.currentTarget || e.key !== 'Enter') return
  e.preventDefault()
  void decide(primary.value)
}
/** 意见框里 Enter 提交“继续完善”（Shift+Enter 换行）、Esc 收起。 */
function onFeedbackKey(e: KeyboardEvent) {
  if (e.isComposing) return
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void decide('refine')
  } else if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    refining.value = false
  }
}
</script>

<template>
  <section
    class="agent-card agent-plan-card"
    :tabindex="open ? 0 : undefined"
    :aria-label="t('agent.chat.planCard.title')"
    @keydown="open && onKey($event)"
  >
    <header class="agent-card__head">
      <span class="agent-card__title">{{ t('agent.chat.planCard.title') }}</span>
      <el-tag v-if="choice" size="small" :type="choice === 'refine' ? 'info' : 'success'">
        {{ t(`agent.chat.planCard.choice.${choice}`) }}
      </el-tag>
      <el-tag v-else-if="item.status !== 'pending'" size="small" type="info">
        {{ t('agent.chat.planCard.closed') }}
      </el-tag>
    </header>
    <h4 class="agent-plan-card__name">{{ plan.title }}</h4>
    <p class="agent-msg__text">{{ plan.summary }}</p>
    <ol class="agent-plan-card__steps">
      <li v-for="(s, k) in plan.steps" :key="k">{{ s }}</li>
    </ol>
    <dl v-if="plan.changes || plan.assumptions?.length" class="agent-card__fields">
      <template v-if="plan.changes">
        <dt>{{ t('agent.chat.planCard.changes') }}</dt>
        <dd>{{ plan.changes }}</dd>
      </template>
      <template v-if="plan.assumptions?.length">
        <dt>{{ t('agent.chat.planCard.assumptions') }}</dt>
        <dd>
          <ul class="agent-plan-card__assumptions">
            <li v-for="(a, k) in plan.assumptions" :key="k">{{ a }}</li>
          </ul>
        </dd>
      </template>
    </dl>
    <template v-if="open && refining">
      <el-input
        ref="feedbackBox"
        v-model="feedback"
        type="textarea"
        :autosize="{ minRows: 2, maxRows: 6 }"
        :aria-label="t('agent.chat.planCard.feedback')"
        :placeholder="t('agent.chat.planCard.feedback')"
        maxlength="2000"
        :disabled="!!pending"
        @keydown="onFeedbackKey"
      />
      <div class="agent-card__actions">
        <span class="agent-card__meta">{{ t('agent.chat.planCard.feedbackKeys') }}</span>
        <el-button :disabled="!!pending" @click="refining = false">
          {{ t('agent.chat.planCard.back') }}
        </el-button>
        <el-button
          type="primary"
          :loading="pending === 'refine'"
          :disabled="!!pending"
          @click="decide('refine')"
        >
          {{ t('agent.chat.planCard.action.refine') }}
        </el-button>
      </div>
    </template>
    <div v-else-if="open" class="agent-card__actions">
      <span class="agent-card__meta">{{ t('agent.chat.planCard.keys') }}</span>
      <el-button
        v-if="autoReview"
        type="primary"
        data-decision="auto_review"
        :loading="pending === 'auto_review'"
        :disabled="!!pending"
        @click="decide('auto_review')"
      >
        {{ t('agent.chat.planCard.action.auto_review') }}
      </el-button>
      <el-button
        :type="autoReview ? undefined : 'primary'"
        data-decision="ask"
        :loading="pending === 'ask'"
        :disabled="!!pending"
        @click="decide('ask')"
      >
        {{ t('agent.chat.planCard.action.ask') }}
      </el-button>
      <el-button data-decision="refine" :disabled="!!pending" @click="startRefine">
        {{ t('agent.chat.planCard.action.refine') }}
      </el-button>
    </div>
    <p v-else-if="item.payload.choice" class="agent-card__meta">
      <span>{{ dayjs(item.payload.choice.decidedAt).format('YYYY-MM-DD HH:mm') }}</span>
      <span v-if="item.payload.choice.feedback"> · {{ item.payload.choice.feedback }}</span>
    </p>
  </section>
</template>

<style scoped>
.agent-plan-card__name {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--qw-text);
}
.agent-plan-card__steps,
.agent-plan-card__assumptions {
  margin: 0;
  padding-left: 20px;
  color: var(--qw-text-2);
}
.agent-plan-card__steps li + li {
  margin-top: 4px;
}
</style>
