<script setup lang="ts">
import { computed, nextTick, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AgentItemVo, AgentQuestionAnswer } from '@qiwu/shared'
import { agentApi } from '@/api/platform/agent'
import { toastRest } from '@/core/composables/use-crud'
import { formFields } from './thread-state'

/**
 * 反问卡片：智能体（或外部 MCP 服务器）向发起人提问，本轮停下等回答。每题单选或多选，外加一个总在的
 * “其他”自由填写；外部服务器也可以要一张表单（扁平 JSON Schema 的文字、数字、开关与枚举字段）。
 * 整张卡片一次提交，也可以“不回答”（告诉智能体用户拒绝回答）；请求进行中按钮不可再点。
 * 卡片获得焦点时数字键选择当前题目的第 n 个选项（选项之后的下一个数字是“其他”）。回答后只读显示。
 * 外部服务器的提问醒目提示回答会发给那台服务器。
 */
defineOptions({ name: 'AgentQuestionCard' })
const { item, readonly = false } = defineProps<{
  item: Extract<AgentItemVo, { kind: 'question' }>
  /** 分享的只读快照：只看不操作 */
  readonly?: boolean
}>()
const emit = defineEmits<{ answered: [] }>()
const { t } = useI18n()

/** “其他”在选项下标里的取值 */
const OTHER = -1
const questions = computed(() => item.payload.questions)
const state = reactive(
  item.payload.questions.map(() => ({
    one: undefined as number | undefined,
    many: [] as number[],
    other: '',
  })),
)
const picks = (i: number) => {
  const s = state[i]!
  return questions.value[i]!.multiSelect ? s.many : s.one == null ? [] : [s.one]
}
const otherOn = (i: number) => picks(i).includes(OTHER)

/** 每题的回答：所选选项的文字，以及勾选“其他”时填写的内容。 */
const answers = computed<AgentQuestionAnswer['answers']>(() =>
  questions.value.map((q, i) => {
    const idx = picks(i)
    const other = idx.includes(OTHER) ? state[i]!.other.trim() : ''
    return {
      header: q.header,
      selected: idx.filter((k) => k >= 0).map((k) => q.options[k]!.label),
      ...(other ? { other } : {}),
    }
  }),
)

// 表单：字段值，未填的不提交
const fields = computed(() => (item.payload.form ? formFields(item.payload.form.schema) : []))
const form = reactive<Record<string, string | number | boolean | undefined>>({})
const filled = (v: unknown) => v !== undefined && v !== null && v !== ''
const formValues = computed(
  () =>
    Object.fromEntries(
      fields.value.flatMap((f) => {
        const v = form[f.key]
        return filled(v) ? [[f.key, typeof v === 'string' ? v.trim() : v]] : []
      }),
    ) as Record<string, string | number | boolean>,
)
const complete = computed(
  () =>
    answers.value.every((a) => a.selected.length || a.other) &&
    fields.value.every((f) => !f.required || filled(formValues.value[f.key])),
)

const pending = ref<'answer' | 'decline' | null>(null)
const sent = ref<'answer' | 'decline' | null>(null)
const open = computed(() => !readonly && item.status === 'pending' && !sent.value)

/** 提交整张卡片的回答，或“不回答”；失败时恢复可提交。 */
async function submit(kind: 'answer' | 'decline') {
  if (!open.value || pending.value || (kind === 'answer' && !complete.value)) return
  pending.value = kind
  try {
    await agentApi.answer(
      item.id,
      kind === 'decline'
        ? { decline: true }
        : { answers: answers.value, ...(fields.value.length ? { form: formValues.value } : {}) },
    )
    sent.value = kind
    emit('answered')
  } catch (e) {
    toastRest(e)
  } finally {
    pending.value = null
  }
}

// 数字键选项：作用于焦点所在（或最近一次操作）的题目
const active = ref(0)
const root = ref<HTMLElement>()
function pick(i: number, k: number) {
  const s = state[i]!
  if (!questions.value[i]!.multiSelect) s.one = k
  else s.many = s.many.includes(k) ? s.many.filter((x) => x !== k) : [...s.many, k]
}
async function onKey(e: KeyboardEvent) {
  if (!open.value || pending.value || e.ctrlKey || e.metaKey || e.altKey) return
  // 在输入框里打字时数字就是文字
  if ((e.target as HTMLElement).closest('input[type="text"], input[type="number"], textarea'))
    return
  const n = Number(e.key)
  const q = questions.value[active.value]
  if (!q || !Number.isInteger(n) || n < 1 || n > q.options.length + 1) return
  e.preventDefault()
  const k = n <= q.options.length ? n - 1 : OTHER
  pick(active.value, k)
  if (k === OTHER && otherOn(active.value)) {
    await nextTick()
    root.value?.querySelector<HTMLInputElement>(`input[data-other="${active.value}"]`)?.focus()
  }
}

/** 已回答时某题显示的文字；推送到达前先显示本页刚提交的回答。 */
function answerText(header: string) {
  const list = item.payload.answers ?? (sent.value === 'answer' ? answers.value : [])
  const a = list.find((x) => x.header === header)
  const parts = [...(a?.selected ?? []), ...(a?.other ? [a.other] : [])]
  return parts.join(t('agent.chat.question.sep')) || t('agent.chat.question.none')
}
const closedText = computed(() =>
  t(
    `agent.chat.question.status.${sent.value === 'decline' ? 'declined' : item.status === 'answered' || sent.value ? 'answered' : 'closed'}`,
  ),
)
</script>

<template>
  <section
    ref="root"
    class="agent-card agent-question"
    :tabindex="open ? 0 : undefined"
    :aria-label="t('agent.chat.question.title')"
    @keydown="onKey"
  >
    <header class="agent-card__head">
      <span class="agent-card__title">{{
        item.payload.form?.title || t('agent.chat.question.title')
      }}</span>
      <span v-if="item.payload.from !== 'agent'" class="agent-card__meta">
        {{ t('agent.chat.question.from', { name: item.payload.from }) }}
      </span>
      <el-tag v-if="!open" size="small" type="info">{{ closedText }}</el-tag>
    </header>
    <template v-if="open">
      <!-- 外部服务器的提问：回答会原样交给那台服务器，提醒用户不要填不该外发的内容 -->
      <el-alert
        v-if="item.payload.from !== 'agent'"
        class="agent-question__external"
        type="warning"
        :closable="false"
        show-icon
        :title="t('agent.chat.question.external', { name: item.payload.from })"
      />
      <fieldset
        v-for="(q, i) in questions"
        :key="i"
        class="agent-question__q"
        @focusin="active = i"
        @click="active = i"
      >
        <legend class="agent-question__legend">
          <el-tag size="small">{{ q.header }}</el-tag>
          <span>{{ q.question }}</span>
        </legend>
        <el-checkbox-group
          v-if="q.multiSelect"
          v-model="state[i]!.many"
          :disabled="!!pending"
          class="agent-question__options"
        >
          <el-checkbox v-for="(o, k) in q.options" :key="k" :value="k">
            <span>{{ k + 1 }}. {{ o.label }}</span>
            <span v-if="o.description" class="agent-question__desc">{{ o.description }}</span>
          </el-checkbox>
          <el-checkbox :value="OTHER"
            >{{ q.options.length + 1 }}. {{ t('agent.chat.question.other') }}</el-checkbox
          >
        </el-checkbox-group>
        <el-radio-group
          v-else
          v-model="state[i]!.one"
          :disabled="!!pending"
          class="agent-question__options"
        >
          <el-radio v-for="(o, k) in q.options" :key="k" :value="k">
            <span>{{ k + 1 }}. {{ o.label }}</span>
            <span v-if="o.description" class="agent-question__desc">{{ o.description }}</span>
          </el-radio>
          <el-radio :value="OTHER"
            >{{ q.options.length + 1 }}. {{ t('agent.chat.question.other') }}</el-radio
          >
        </el-radio-group>
        <el-input
          v-if="otherOn(i)"
          v-model="state[i]!.other"
          :data-other="i"
          maxlength="1000"
          :disabled="!!pending"
          :aria-label="t('agent.chat.question.otherLabel', { header: q.header })"
          :placeholder="t('agent.chat.question.otherLabel', { header: q.header })"
        />
      </fieldset>
      <el-form
        v-if="fields.length"
        label-position="top"
        class="agent-question__form"
        @submit.prevent
      >
        <el-form-item v-for="f in fields" :key="f.key" :label="f.label" :required="f.required">
          <el-select
            v-if="f.type === 'enum'"
            v-model="form[f.key]"
            clearable
            :aria-label="f.label"
            :disabled="!!pending"
          >
            <el-option v-for="o in f.options" :key="o" :value="o" :label="o" />
          </el-select>
          <el-input-number
            v-else-if="f.type === 'number'"
            :model-value="typeof form[f.key] === 'number' ? (form[f.key] as number) : undefined"
            @update:model-value="(v: number | undefined) => (form[f.key] = v ?? undefined)"
            :aria-label="f.label"
            :disabled="!!pending"
          />
          <el-switch
            v-else-if="f.type === 'boolean'"
            v-model="form[f.key]"
            :aria-label="f.label"
            :disabled="!!pending"
          />
          <el-input
            v-else
            :model-value="String(form[f.key] ?? '')"
            maxlength="2000"
            :aria-label="f.label"
            :disabled="!!pending"
            @update:model-value="(v: string) => (form[f.key] = v)"
          />
          <span v-if="f.description" class="agent-card__meta">{{ f.description }}</span>
        </el-form-item>
      </el-form>
      <div class="agent-card__actions">
        <span v-if="questions.length" class="agent-card__meta">{{
          t('agent.chat.question.keys')
        }}</span>
        <el-button
          :loading="pending === 'decline'"
          :disabled="!!pending"
          @click="submit('decline')"
        >
          {{ t('agent.chat.question.decline') }}
        </el-button>
        <el-button
          type="primary"
          :loading="pending === 'answer'"
          :disabled="!!pending || !complete"
          @click="submit('answer')"
        >
          {{ t('agent.chat.question.submit') }}
        </el-button>
      </div>
    </template>
    <dl v-else-if="questions.length" class="agent-card__fields agent-question__answers">
      <template v-for="(q, i) in questions" :key="i">
        <dt>{{ q.header }}</dt>
        <dd>{{ answerText(q.header) }}</dd>
      </template>
    </dl>
  </section>
</template>
