<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
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
 * 待审批时从窄到宽：“允许这一次”、“本会话内不再询问「工具」”（服务端给出 `sessionAllow` 时才有；整个工具在本会话
 * 内不再问，可在会话设置里撤销）、“拒绝”（先展开说明框“告诉助手怎么做”，再提交）。取消本轮交给输入框的停止键。
 * 卡片本身获得焦点时 Enter 允许这一次、Esc 展开拒绝说明（焦点在按钮、链接或说明框上时不拦截，免得 Tab 到
 * “拒绝”按 Enter 却成了确认）；说明框里 Enter 提交拒绝、Esc 收起。请求进行中按钮都不可再点，防止重复提交；
 * 决定后显示结果，因本会话放行而自动执行的卡片注明这一点。被权限、会话模式、平台或租户策略、技能或方案的工具清单
 * 拦下时不给按钮，只说明怎样才能做。服务端仍校验只有本人能决定（已决定的返回 409）。经过自动审查的卡片显示审查结论与理由；审查
 * 建议拒绝的卡片仍待本人决定；自动审查模式下没有送审的卡片说明原因。
 */
defineOptions({ name: 'AgentApprovalCard' })
const { item, readonly = false } = defineProps<{
  item: Extract<AgentItemVo, { kind: 'approval' }>
  /** 分享的只读快照：只看不操作 */
  readonly?: boolean
}>()
const emit = defineEmits<{ decided: [] }>()
const { t, te } = useI18n()

const tool = computed(() => toolTitle(item.payload.tool, item.payload.title))
/** 逐次本人确认的操作永远不给“本会话内不再询问”，即使服务端误给了 sessionAllow */
const sessionAllow = computed(
  () => !!item.payload.sessionAllow && !item.payload.perCallConfirmation,
)
const note = ref('')
const noteBox = ref<{ focus: () => void }>()
/** 正在写拒绝说明：说明框展开，提交后才真正拒绝 */
const rejecting = ref(false)
const pending = ref<Decision | null>(null)
/** 本页已提交成功、等待服务端推送新状态的决定 */
const sent = ref<Decision | null>(null)
// 新预览不是旧同意的延续：同一卡片换 token 后必须恢复为可重新确认。
watch(
  () => item.payload.confirmationToken,
  () => {
    sent.value = null
  },
)
const blocked = computed(() => item.payload.blocked)
const open = computed(() => !readonly && item.status === 'pending' && !sent.value && !blocked.value)
/** 已作出的决定：服务端记录的优先，推送到达前用本页刚提交的 */
const decided = computed(() => item.payload.decision ?? sent.value)
/**
 * 自动审查的结论（通过、驳回或交给人）与理由；理由只当文字显示。放行与驳回的理由是审查模型写的，注明
 * “审查模型的说法”；交给人的说明可能是系统自己的（出错、超时、额度），只写“说明”。驳回但仍待本人决定时
 * 写“建议拒绝”。
 */
const review = computed(() => (item.payload.auto?.by === 'review' ? item.payload.auto : null))
const reviewTitle = computed(() =>
  review.value?.verdict === 'reject' && item.status === 'pending'
    ? t('agent.review.card.rejectPending')
    : t(`agent.review.card.${review.value?.verdict}`),
)
/** 未送审的原因：服务端可能新增原因码，本页不认识的用通用说明 */
const unreviewedText = computed(() => {
  const key = `agent.review.card.unreviewed.${item.payload.unreviewed}`
  return te(key) ? t(key) : t('agent.review.card.unreviewed.other')
})
/**
 * 为什么要问你（各模式都给）：本人逐次确认、租户或平台设为仅人工确认、读取设为需确认、写入需确认。
 * 只说原因的类别，不带平台或其他租户的配置细节；本页不认识的原因码不显示。被拦下的卡片不需要；
 * 服务端在决定怎么处理前就给每张卡带上原因，所以本会话已放行、审查模型放行和自动化预先放行的卡片
 * 也带着它，但这些从没问过人，同样不显示。
 */
const whyText = computed(() => {
  const { why, allowedBy, auto } = item.payload
  if (!why || blocked.value || allowedBy) return null
  if (auto && (auto.by === 'pre_approved' || auto.verdict === 'approve')) return null
  const key = `agent.chat.approval.why.${why}`
  return te(key) ? t(key) : null
})

/** 提交决定；失败时恢复可点，成功后交给页面补齐最新状态。只有拒绝带说明。 */
async function decide(decision: Decision) {
  if (!open.value || pending.value) return
  pending.value = decision
  try {
    const text = decision === 'reject' ? note.value.trim() : ''
    const token = item.payload.confirmationToken
    await agentApi.decide(item.id, {
      decision,
      ...(text && { note: text }),
      ...(item.payload.perCallConfirmation && { confirmationToken: token }),
    })
    if (!item.payload.perCallConfirmation || item.payload.confirmationToken === token)
      sent.value = decision
    emit('decided')
  } catch (e) {
    toastRest(e)
  } finally {
    pending.value = null
  }
}
/** 展开拒绝说明框并把焦点放进去。 */
async function startReject() {
  if (!open.value || pending.value) return
  rejecting.value = true
  await nextTick()
  noteBox.value?.focus()
}
/** 只处理卡片本身的按键：按钮、链接与说明框上的 Enter / Esc 保持原来的行为。 */
function onKey(e: KeyboardEvent) {
  if (e.isComposing || e.target !== e.currentTarget) return
  if (e.key === 'Enter') {
    e.preventDefault()
    void decide('approve')
  } else if (e.key === 'Escape') {
    e.preventDefault()
    void startReject()
  }
}
/** 说明框里 Enter 提交拒绝、Esc 收起说明框（输入法组字时不处理）。 */
function onNoteKey(e: KeyboardEvent) {
  if (e.isComposing) return
  if (e.key === 'Enter') {
    e.preventDefault()
    void decide('reject')
  } else if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    rejecting.value = false
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
      <dd>{{ tool }}</dd>
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
    <p v-if="whyText" class="agent-approval__why">
      <strong>{{ t('agent.chat.approval.whyTitle') }}</strong>
      <span>{{ whyText }}</span>
    </p>
    <p
      v-if="review"
      class="agent-approval__review"
      :class="`agent-approval__review--${review.verdict}`"
      role="status"
    >
      <strong>{{ reviewTitle }}</strong>
      <span class="agent-approval__review-said">{{
        t(review.verdict === 'escalate' ? 'agent.review.card.note' : 'agent.review.card.said')
      }}</span>
      <span>{{ review.reason }}</span>
    </p>
    <p
      v-else-if="item.payload.unreviewed"
      class="agent-approval__review agent-approval__review--escalate"
      role="status"
    >
      <strong>{{ t('agent.review.card.unreviewed.title') }}</strong>
      <span>{{ unreviewedText }}</span>
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
    <template v-else-if="open && rejecting">
      <el-input
        ref="noteBox"
        v-model="note"
        :aria-label="t('agent.chat.approval.note')"
        :placeholder="t('agent.chat.approval.note')"
        maxlength="500"
        :disabled="!!pending"
        @keydown="onNoteKey"
      />
      <div class="agent-card__actions">
        <span class="agent-card__meta">{{ t('agent.chat.approval.noteKeys') }}</span>
        <el-button :disabled="!!pending" @click="rejecting = false">
          {{ t('agent.chat.approval.back') }}
        </el-button>
        <el-button
          type="danger"
          :loading="pending === 'reject'"
          :disabled="!!pending"
          @click="decide('reject')"
        >
          {{ t('agent.chat.approval.action.reject') }}
        </el-button>
      </div>
    </template>
    <div v-else-if="open" class="agent-card__actions">
      <span class="agent-card__meta">{{ t('agent.chat.approval.keys') }}</span>
      <el-button
        type="primary"
        :loading="pending === 'approve'"
        :disabled="!!pending"
        @click="decide('approve')"
      >
        {{ t('agent.chat.approval.action.approve') }}
      </el-button>
      <el-button
        v-if="sessionAllow"
        :loading="pending === 'approve_session'"
        :disabled="!!pending"
        @click="decide('approve_session')"
      >
        {{ t('agent.chat.approval.action.approve_session', { tool }) }}
      </el-button>
      <el-button :disabled="!!pending" @click="startReject">
        {{ t('agent.chat.approval.action.reject') }}
      </el-button>
    </div>
    <p v-else-if="item.payload.allowedBy === 'session'" class="agent-card__meta" role="status">
      {{ t('agent.chat.approval.allowedBySession') }}
    </p>
    <p v-else-if="item.payload.decidedAt || item.payload.note" class="agent-card__meta">
      <span v-if="item.payload.decidedAt">{{
        dayjs(item.payload.decidedAt).format('YYYY-MM-DD HH:mm')
      }}</span>
      <span v-if="item.payload.note">{{ item.payload.note }}</span>
    </p>
  </section>
</template>

<style scoped>
.agent-approval__why {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  font-size: 13px;
  color: var(--qw-text-2);
}
.agent-approval__why strong {
  font-weight: 600;
}
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
