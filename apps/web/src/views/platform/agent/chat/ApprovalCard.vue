<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toolTitle, toolPermission } from '../tool-presentation'
import dayjs from 'dayjs'
import type { AgentApprovalDecide, AgentItemVo } from '@qiwu/shared'
import { agentApi } from '@/api/platform/agent'
import { toastRest } from '@/core/composables/use-crud'
import { show } from './thread-state'

type Decision = AgentApprovalDecide['decision']

/**
 * 审批卡片：智能体要执行一次写入，先给发起人看工具、目标记录、逐字段的旧值 → 新值与本轮引用的来源。
 * 待审批时可“确认”、“本会话内同意”（同一工具同一目标不再问）、“拒绝”或“取消”（结束本轮），可附说明；
 * 卡片本身获得焦点时 Enter 确认、Esc 拒绝（焦点在按钮、链接或说明框上时不拦截，免得 Tab 到“拒绝”按 Enter
 * 却成了确认）。平台关闭“信任本会话”时不给“本会话内同意”。请求进行中按钮都不可再点，防止重复提交；决定后显示结果。
 * 被权限、会话模式或平台策略拦下时不给按钮，只说明怎样才能做。服务端仍校验只有本人能决定（已决定的返回 409）。
 * 经过自动审查的卡片显示审查结论（已通过、驳回或交给人）与理由。
 */
defineOptions({ name: 'AgentApprovalCard' })
const {
  item,
  readonly = false,
  trust = true,
} = defineProps<{
  item: Extract<AgentItemVo, { kind: 'approval' }>
  /** 分享的只读快照：只看不操作 */
  readonly?: boolean
  /** 是否提供“本会话内同意”（系统参数 agent.trust_mode） */
  trust?: boolean
}>()
const emit = defineEmits<{ decided: [] }>()
const { t } = useI18n()

const DECISIONS = computed<{ value: Decision; primary?: boolean }[]>(() => [
  { value: 'approve', primary: true },
  ...(trust ? [{ value: 'approve_session' as const }] : []),
  { value: 'reject' },
  { value: 'cancel' },
])
const note = ref('')
const pending = ref<Decision | null>(null)
/** 本页已提交成功、等待服务端推送新状态的决定 */
const sent = ref<Decision | null>(null)
const blocked = computed(() => item.payload.blocked)
const open = computed(() => !readonly && item.status === 'pending' && !sent.value && !blocked.value)
/** 已作出的决定：服务端记录的优先，推送到达前用本页刚提交的 */
const decided = computed(() => item.payload.decision ?? sent.value)
/**
 * 自动审查的结论（通过、驳回或交给人）与理由；理由只当文字显示。放行与驳回的理由是审查模型写的，注明
 * “审查模型的说法”；交给人的说明可能是系统自己的（出错、超时、额度），只写“说明”。
 */
const review = computed(() => (item.payload.auto?.by === 'review' ? item.payload.auto : null))

/** 提交决定；失败时恢复可点，成功后交给页面补齐最新状态。 */
async function decide(decision: Decision) {
  if (!open.value || pending.value) return
  pending.value = decision
  try {
    const text = note.value.trim()
    await agentApi.decide(item.id, text ? { decision, note: text } : { decision })
    sent.value = decision
    emit('decided')
  } catch (e) {
    toastRest(e)
  } finally {
    pending.value = null
  }
}
/** 只处理卡片本身的按键：按钮、链接与说明框上的 Enter / Esc 保持原来的行为。 */
function onKey(e: KeyboardEvent) {
  if (e.isComposing || e.target !== e.currentTarget) return
  if (e.key === 'Enter') {
    e.preventDefault()
    void decide('approve')
  } else if (e.key === 'Escape') {
    e.preventDefault()
    void decide('reject')
  }
}
</script>

<template>
  <section
    class="agent-card agent-approval"
    :tabindex="open ? 0 : undefined"
    :aria-label="t('agent.chat.approval.title')"
    @keydown="open && onKey($event)"
  >
    <header class="agent-card__head">
      <span class="agent-card__title">{{ t('agent.chat.approval.title') }}</span>
      <el-tag
        v-if="decided"
        size="small"
        :type="decided.startsWith('approve') ? 'success' : 'info'"
      >
        {{ t(`agent.chat.approval.decision.${decided}`) }}
      </el-tag>
      <el-tag v-else-if="item.status && item.status !== 'pending'" size="small" type="info">
        {{ t(`agent.chat.approval.status.${item.status}`) }}
      </el-tag>
    </header>
    <dl class="agent-card__fields">
      <dt>{{ t('agent.chat.approval.tool') }}</dt>
      <dd>{{ toolTitle(item.payload.tool, item.payload.title) }}</dd>
      <template v-if="item.payload.changes">
        <dt>{{ t('agent.chat.approval.target') }}</dt>
        <dd>{{ item.payload.changes.target }}</dd>
      </template>
    </dl>
    <table v-if="item.payload.changes?.fields.length" class="agent-approval__changes">
      <thead>
        <tr>
          <th scope="col">{{ t('agent.chat.approval.field') }}</th>
          <th scope="col">{{ t('agent.chat.approval.from') }}</th>
          <th scope="col">{{ t('agent.chat.approval.to') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="f in item.payload.changes.fields" :key="f.field">
          <td>{{ f.field }}</td>
          <td class="agent-approval__from">{{ show(f.from) || t('agent.chat.approval.empty') }}</td>
          <td class="agent-approval__to">{{ show(f.to) || t('agent.chat.approval.empty') }}</td>
        </tr>
      </tbody>
    </table>
    <pre v-else class="agent-card__pre">{{ show(item.payload.args) }}</pre>
    <div v-if="item.payload.sources.length" class="agent-approval__sources">
      <span>{{ t('agent.chat.approval.sources') }}</span>
      <ul>
        <li v-for="s in item.payload.sources" :key="s.url">
          <a
            v-if="/^https?:/i.test(s.url)"
            :href="s.url"
            target="_blank"
            rel="noopener noreferrer"
            >{{ s.title || s.url }}</a
          >
          <span v-else>{{ s.title || s.url }}</span>
        </li>
      </ul>
    </div>
    <p
      v-if="review"
      class="agent-approval__review"
      :class="`agent-approval__review--${review.verdict}`"
      role="status"
    >
      <strong>{{ t(`agent.review.card.${review.verdict}`) }}</strong>
      <span class="agent-approval__review-said">{{
        t(review.verdict === 'escalate' ? 'agent.review.card.note' : 'agent.review.card.said')
      }}</span>
      <span>{{ review.reason }}</span>
    </p>
    <el-alert
      v-if="blocked"
      type="warning"
      :closable="false"
      show-icon
      :title="
        t(`agent.chat.approval.blocked.${blocked.reason}`, {
          perm: blocked.perm ? toolPermission(blocked.perm) : '',
        })
      "
    />
    <template v-else-if="open">
      <el-input
        v-model="note"
        :aria-label="t('agent.chat.approval.note')"
        :placeholder="t('agent.chat.approval.note')"
        maxlength="500"
        :disabled="!!pending"
      />
      <div class="agent-card__actions">
        <span class="agent-card__meta">{{ t('agent.chat.approval.keys') }}</span>
        <el-button
          v-for="d in DECISIONS"
          :key="d.value"
          :type="d.primary ? 'primary' : undefined"
          :loading="pending === d.value"
          :disabled="!!pending"
          @click="decide(d.value)"
        >
          {{ t(`agent.chat.approval.action.${d.value}`) }}
        </el-button>
      </div>
    </template>
    <p v-else-if="item.payload.decidedAt || item.payload.note" class="agent-card__meta">
      <span v-if="item.payload.decidedAt">{{
        dayjs(item.payload.decidedAt).format('YYYY-MM-DD HH:mm')
      }}</span>
      <span v-if="item.payload.note">{{ item.payload.note }}</span>
    </p>
  </section>
</template>

<style scoped>
.agent-approval__review {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  padding: 6px 10px;
  border-radius: var(--qw-radius-sm);
  font-size: 13px;
  color: var(--qw-text-2);
  background: var(--qw-neutral-weak);
}
.agent-approval__review strong {
  font-weight: 600;
}
.agent-approval__review-said {
  color: var(--qw-text-3);
}
.agent-approval__review--approve {
  background: var(--qw-success-weak);
}
.agent-approval__review--approve strong {
  color: var(--qw-success);
}
.agent-approval__review--reject {
  background: var(--qw-danger-weak);
}
.agent-approval__review--reject strong {
  color: var(--qw-danger);
}
.agent-approval__review--escalate {
  background: var(--qw-warning-weak);
}
.agent-approval__review--escalate strong {
  color: var(--qw-warning);
}
</style>
