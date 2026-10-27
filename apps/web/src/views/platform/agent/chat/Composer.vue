<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import {
  AGENT_MESSAGE_MAX,
  AGENT_REASONING,
  type AgentApprovalMode,
  type AgentOptionsVo,
  type FsObjectVo,
} from '@qiwu/shared'
import FileUpload from '@/core/components/FileUpload.vue'
import IconButton from '@/core/components/IconButton.vue'
import { isImage } from '@/core/composables/use-upload'
import { useAuthStore } from '@/core/stores/auth'
import { comboOf, DEFAULT_SHORTCUTS } from './shortcuts'
import {
  loadHistory,
  clearHistory,
  mentionedSkill,
  mentionPrefix,
  nextMode,
  pushHistory,
  skillOf,
  skillPrefix,
  slashMatches,
  togglePlanMode,
  type SlashCommand,
} from './thread-state'

/** 输入框的模型与模式设置；新会话时是草稿，已有会话时页面保存到会话上。 */
export interface ComposerSettings {
  providerId: number | null
  model: string | null
  reasoning: (typeof AGENT_REASONING)[number] | null
  approvalMode: AgentApprovalMode
}

/** 一次发送：文字、`$` 技能、已上传的附件，以及运行中时的发送方式。 */
export interface ComposerMessage {
  text: string
  skill?: string
  fileIds?: number[]
  mode?: 'steer' | 'queue'
  /** 仅在页面内核对发送时的草稿，不随请求正文送到服务端。 */
  draftRevision?: number
}

/**
 * 底部输入框：多行，Enter 发送、Shift+Enter 换行（输入法组字时不发送）；`$` 补全技能，整行 `/` 补全斜杠命令，
 * `@` 提及技能、外部服务器与当前页面带来的记录（插入可读的文字记号，模型直接读；提及技能同时作为本轮技能），
 * `/prompts` 与“提示词”菜单插入模板；↑/↓ 翻看本人发过的消息，Ctrl+R 搜索它们；附件（图片只给能看图的模型）；模型、
 * 快速档、推理强度与会话模式（只读 / 计划 / 每次询问 / 自动审查，只列平台此刻提供的；输入框里 Shift+Tab 循环）
 * 放在输入框下的一条工具栏里，按键说明是工具栏下一行淡色提示；上下文用量；运行中可选“追加到当前步骤”或“排到下一轮”，
 * 等待确认时提示“发送即拒绝待确认的操作”（服务端把这句话作为拒绝说明并继续本轮）；
 * 输入框为空时按停止键（默认 Esc，可在页面自定义）停止本轮。发送按钮在请求进行中 loading 且不可再点，失败时文字保留。
 */
defineOptions({ name: 'AgentComposer' })
const {
  options,
  submit,
  running = false,
  awaitingApproval = false,
  stopping = false,
  disabled = false,
  temporary = false,
  context = null,
  records = [],
  stopKey = DEFAULT_SHORTCUTS.stop,
} = defineProps<{
  options: AgentOptionsVo | null
  /** 发送一条消息，成功时为 true（此时才清空输入框与附件） */
  submit: (msg: ComposerMessage) => Promise<boolean>
  running?: boolean
  /** 本轮正停在待确认的操作上：此时发送等于拒绝它们并附上这句话 */
  awaitingApproval?: boolean
  stopping?: boolean
  disabled?: boolean
  /** 当前（或将要新建的）会话是临时会话：发出的消息不记进输入历史 */
  temporary?: boolean
  /** 当前会话的上下文用量（token），没有会话时为 null */
  context?: { used: number; window: number } | null
  /** 可以 `@` 提及的记录（当前页面或会话带来的选中记录） */
  records?: { target: string; id: number }[]
  /** 停止本轮的组合键（见 shortcuts.ts），默认 Esc */
  stopKey?: string
}>()
const settings = defineModel<ComposerSettings>('settings', { required: true })
const emit = defineEmits<{ stop: []; command: [cmd: SlashCommand] }>()
const { t } = useI18n()
const auth = useAuthStore()

const text = ref('')
const box = ref<{ textarea?: HTMLTextAreaElement; focus: () => void }>()
type Openable = { focus?: () => void; toggleMenu?: () => void }
const modelSelect = ref<Openable>()
const modeSelect = ref<Openable>()

/** 整体替换设置对象的某几项：页面据此保存到会话 */
const set = (p: Partial<ComposerSettings>) => (settings.value = { ...settings.value, ...p })

// ---- 模型、快速档、推理强度 ----
const models = computed(() =>
  (options?.providers ?? []).flatMap((p) => p.models.map((m) => ({ ...m, providerId: p.id }))),
)
const current = computed(() =>
  models.value.find(
    (m) => m.providerId === settings.value.providerId && m.id === settings.value.model,
  ),
)
const modelKey = computed({
  get: () =>
    current.value
      ? `${current.value.providerId}|${current.value.id}`
      : (settings.value.model ?? ''),
  set: (key: string) => {
    const m = models.value.find((x) => `${x.providerId}|${x.id}` === key)
    if (m)
      set({
        providerId: m.providerId,
        model: m.id,
        reasoning: m.reasoning ? settings.value.reasoning : null,
      })
  },
})
const fastModel = computed(() => models.value.find((m) => m.fast))
/** 切换前的模型：关掉快速档时回到它 */
let beforeFast = ''
function toggleFast() {
  const f = fastModel.value
  if (!f) return
  if (current.value?.fast) {
    const back = models.value.find((m) => `${m.providerId}|${m.id}` === beforeFast && !m.fast)
    const d = options?.defaults
    modelKey.value = back ? beforeFast : d ? `${d.providerId}|${d.model}` : modelKey.value
  } else {
    beforeFast = modelKey.value
    modelKey.value = `${f.providerId}|${f.id}`
  }
}
const reasoningChoices = computed(() =>
  current.value?.reasoningStyle === 'vllm' ? (['off', 'medium'] as const) : AGENT_REASONING,
)
const reasoningLabel = (value: string) =>
  current.value?.reasoningStyle === 'vllm' && value !== 'off'
    ? t('agent.admin.model.reasoningOn')
    : t(`agent.chat.reasoning.${value}`)
const defaultReasoningLabel = computed(() => {
  const value = current.value?.reasoningDefault ?? 'provider'
  return t('agent.chat.composer.reasoningDefault', {
    value: value === 'provider' ? t('agent.admin.model.reasoningProvider') : reasoningLabel(value),
  })
})
const reasoning = computed({
  get: () =>
    current.value?.reasoningStyle === 'vllm' &&
    settings.value.reasoning &&
    settings.value.reasoning !== 'off'
      ? ('medium' as const)
      : settings.value.reasoning,
  set: (value) => set({ reasoning: value || null }),
})
const modes = computed(() => options?.approvalModes ?? [])
/** 读屏软件播报的模式切换（Shift+Tab 时焦点留在输入框，看不到选择器变化） */
const modeAnnounce = ref('')
/** 切到另一个模式并播报；与选择器改动走同一条保存路径。 */
function switchMode(mode: AgentApprovalMode) {
  if (mode === settings.value.approvalMode) return
  set({ approvalMode: mode })
  modeAnnounce.value = t('agent.chat.composer.modeNow', { mode: t(`agent.chat.mode.${mode}`) })
}

// ---- 附件 ----
const showFiles = ref(false)
const files = ref<FsObjectVo[]>([])

// ---- 补全：`$技能`、`/命令`、`@提及`、`/prompts` 的提示词模板与 Ctrl+R 的历史消息 ----
type Suggestion = {
  kind: 'skill' | 'command' | 'prompt' | 'mention' | 'history'
  value: string
  label: string
  hint: string
}
const MENTION_MAX = 20
const caret = ref(0)
const dismissed = ref(false)
const pickingPrompt = ref(false)
/** Ctrl+R 搜索历史消息中；`draftBefore` 是打开前的草稿，Esc 时放回 */
const pickingHistory = ref(false)
let draftBefore = ''
const highlighted = ref(0)

/** `@` 可提及的全部条目：技能、外部服务器、记录，记号是本语言的可读文字（如 `@技能:名称`） */
const mentions = computed<Suggestion[]>(() => [
  ...(options?.skills ?? []).map((s) => ({
    kind: 'mention' as const,
    value: `@${t('agent.chat.mention.skill')}:${s.name}`,
    label: `@${t('agent.chat.mention.skill')}:${s.name}`,
    hint: s.description,
  })),
  ...(options?.servers ?? []).map((s) => ({
    kind: 'mention' as const,
    value: `@${t('agent.chat.mention.server')}:${s.name}`,
    label: `@${t('agent.chat.mention.server')}:${s.name}`,
    hint: t('agent.chat.mention.serverHint'),
  })),
  ...records.map((r) => ({
    kind: 'mention' as const,
    value: `@${t('agent.chat.mention.record')}:${r.target}#${r.id}`,
    label: `@${t('agent.chat.mention.record')}:${r.target}#${r.id}`,
    hint: t('agent.chat.mention.recordHint'),
  })),
])

const suggestions = computed<Suggestion[]>(() => {
  if (dismissed.value) return []
  if (pickingPrompt.value) {
    const q = text.value.trim().toLowerCase()
    return (options?.prompts ?? [])
      .filter((p) => p.name.toLowerCase().includes(q))
      .map((p) => ({ kind: 'prompt', value: p.body, label: p.name, hint: p.body }))
  }
  if (pickingHistory.value) {
    const q = text.value.trim().toLowerCase()
    return loadHistory(auth.me?.user.id ?? 0, auth.tenant?.id ?? 1)
      .reverse()
      .filter((h) => h.toLowerCase().includes(q))
      .map((h) => ({ kind: 'history', value: h, label: h, hint: '' }))
  }
  const commands = slashMatches(text.value)
  if (commands)
    return commands.map((c) => ({
      kind: 'command',
      value: c,
      label: `/${c}`,
      hint: t(`agent.chat.slash.${c}`),
    }))
  const before = text.value.slice(0, caret.value)
  const at = mentionPrefix(before)
  if (at != null) {
    const q = at.toLowerCase()
    return mentions.value.filter((m) => m.value.toLowerCase().includes(q)).slice(0, MENTION_MAX)
  }
  const prefix = skillPrefix(before)
  if (prefix == null) return []
  const p = prefix.toLowerCase()
  return (options?.skills ?? [])
    .filter((s) => s.name.toLowerCase().startsWith(p))
    .map((s) => ({ kind: 'skill', value: s.name, label: `$${s.name}`, hint: s.description }))
})
const listId = `agent-suggest-${Math.random().toString(36).slice(2, 8)}`
const suggestionList = ref<HTMLUListElement>()

// 只移动候选容器，不用 scrollIntoView，避免页面滚动或输入框丢失焦点。
watch([suggestions, highlighted], async ([list], [previous]) => {
  if (list !== previous) highlighted.value = 0
  await nextTick()
  const container = suggestionList.value
  const selected = container?.querySelector<HTMLElement>('[aria-selected="true"]')
  if (!container || !selected) return
  const top = selected.offsetTop
  const bottom = top + selected.offsetHeight
  if (top < container.scrollTop) container.scrollTop = top
  else if (bottom > container.scrollTop + container.clientHeight)
    container.scrollTop = bottom - container.clientHeight
})

function syncCaret() {
  caret.value = box.value?.textarea?.selectionStart ?? text.value.length
}
function onInput() {
  dismissed.value = false
  highlighted.value = 0
  histPos = -1
  void nextTick(syncCaret)
}

/** 把文字放进输入框并把光标移到末尾。 */
async function setText(value: string) {
  text.value = value
  dismissed.value = false
  highlighted.value = 0
  await nextTick()
  const el = box.value?.textarea
  el?.focus()
  el?.setSelectionRange(value.length, value.length)
  caret.value = value.length
}

/** 输入框自己处理的命令：模型、会话模式（`/approvals` 打开选择器，`/plan` 切换计划）、技能与提示词；其余交给页面。 */
function runCommand(cmd: SlashCommand) {
  if (cmd === 'model') return openSelect(modelSelect.value)
  if (cmd === 'approvals') return openSelect(modeSelect.value)
  if (cmd === 'plan') return switchMode(togglePlanMode(settings.value.approvalMode, modes.value))
  if (cmd === 'skills') return void setText('$')
  if (cmd === 'prompts') {
    pickingPrompt.value = true
    return void setText('')
  }
  emit('command', cmd)
}

/**
 * 选中一条补全：命令立即执行，模板与历史消息换掉输入框文字，技能把 `$前缀` 换成完整的 `$名称 `，
 * 提及把 `@前缀` 换成完整的记号。
 */
async function pick(s: Suggestion) {
  if (s.kind === 'command') {
    text.value = ''
    return runCommand(s.value as SlashCommand)
  }
  if (s.kind === 'prompt' || s.kind === 'history') {
    pickingPrompt.value = false
    pickingHistory.value = false
    return setText(s.value)
  }
  const before = text.value.slice(0, caret.value)
  const after = text.value.slice(caret.value)
  const head =
    s.kind === 'mention'
      ? before.replace(/@[^\s@]*$/u, () => `${s.value} `)
      : before.replace(/\$[\p{L}\p{N}-]*$/u, () => `$${s.value} `)
  text.value = head + after
  await nextTick()
  const el = box.value?.textarea
  el?.focus()
  el?.setSelectionRange(head.length, head.length)
  caret.value = head.length
}

// ---- 输入历史：↑ 在输入框为空（或正在翻看）时取上一条，↓ 取下一条 ----
let history: string[] = []
let histPos = -1
function browse(step: -1 | 1): boolean {
  if (histPos < 0) {
    if (step > 0 || text.value) return false
    history = loadHistory(auth.me?.user.id ?? 0, auth.tenant?.id ?? 1)
    if (!history.length) return false
    histPos = history.length
  }
  const next = histPos + step
  if (next < 0) return true
  histPos = next
  void setText(next >= history.length ? '' : history[next]!)
  if (next >= history.length) histPos = -1
  return true
}

/** Ctrl+R：在本人发过的消息里搜索（像终端的反向搜索），先收起当前草稿，Esc 时放回。 */
function startHistory() {
  if (pickingHistory.value) return
  draftBefore = text.value
  pickingPrompt.value = false
  pickingHistory.value = true
  void setText('')
}

function onKeydown(e: KeyboardEvent) {
  if (e.isComposing || e.keyCode === 229) return
  if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'r') {
    e.preventDefault()
    return startHistory()
  }
  const list = suggestions.value
  if (list.length) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = list.length
      highlighted.value = (highlighted.value + (e.key === 'ArrowDown' ? 1 : n - 1)) % n
      return
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      void pick(list[highlighted.value] ?? list[0]!)
      return
    }
  }
  // Shift+Tab 在可用模式间循环（候选列表打开时上面已处理）；只有一个模式时保留浏览器的焦点后退
  if (
    e.key === 'Tab' &&
    e.shiftKey &&
    !e.ctrlKey &&
    !e.altKey &&
    !e.metaKey &&
    modes.value.length > 1
  ) {
    e.preventDefault()
    switchMode(nextMode(settings.value.approvalMode, modes.value))
    return
  }
  if (e.key === 'Escape' && pickingHistory.value) {
    e.preventDefault()
    pickingHistory.value = false
    void setText(draftBefore)
    return
  }
  if (e.key === 'Escape' && (list.length || pickingPrompt.value)) {
    e.preventDefault()
    dismissed.value = true
    pickingPrompt.value = false
    return
  }
  // 停止本轮只在输入框为空时：正在打字时按到不会误停
  if (running && !text.value && comboOf(e) === stopKey) {
    e.preventDefault()
    emit('stop')
    return
  }
  if (e.key === 'Escape') return
  if (
    (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
    !e.shiftKey &&
    browse(e.key === 'ArrowUp' ? -1 : 1)
  ) {
    e.preventDefault()
    return
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void send()
  }
}

// ---- 发送 ----
const sendMode = ref<'steer' | 'queue'>('steer')
const sending = ref(false)
let sendEpoch = 0
let draftRevision = 0
watch(
  () =>
    JSON.stringify({
      text: text.value,
      files: files.value.map((file) => file.id),
      settings: settings.value,
      mode: sendMode.value,
    }),
  () => draftRevision++,
  { flush: 'sync' },
)
watch(
  () => `${auth.me?.user.id ?? 0}:${auth.tenant?.id ?? 1}`,
  (_next, previous) => {
    if (previous) {
      sendEpoch++
      sending.value = false
      clearHistory()
      text.value = ''
      files.value = []
      history = []
      histPos = -1
    } else clearHistory(0)
  },
  { immediate: true, flush: 'sync' },
)
const canSend = computed(() => !disabled && !sending.value && !!text.value.trim())
function matchesDraft(msg?: ComposerMessage): boolean {
  return (
    !!msg &&
    (msg.draftRevision === undefined || msg.draftRevision === draftRevision) &&
    text.value.trim() === msg.text.trim() &&
    JSON.stringify(files.value.map((file) => file.id)) === JSON.stringify(msg.fileIds ?? [])
  )
}

/** 迟到的接收回执只清发送时未再编辑的草稿，不能清掉随后准备的新正文、模型或队列模式。 */
function acknowledge(msg?: ComposerMessage) {
  if (!msg) return
  pushHistory(auth.me?.user.id ?? 0, msg.text, { temporary, tenantId: auth.tenant?.id ?? 1 })
  histPos = -1
  if (!matchesDraft(msg)) return
  text.value = ''
  files.value = []
  showFiles.value = false
  caret.value = 0
}
/** 发送：`$名称` 若是可用技能则一并带上；图片附件只给能看图的模型；请求成功后才清空。 */
async function send() {
  if (!canSend.value) return
  if (files.value.some((f) => isImage(f.mime)) && !current.value?.vision) {
    ElMessage.warning(t('agent.chat.composer.noVision'))
    return
  }
  const value = text.value.trim()
  const epoch = sendEpoch
  sending.value = true
  try {
    const msg: ComposerMessage = { text: value, draftRevision }
    const names = options?.skills.map((s) => s.name) ?? []
    const skill =
      skillOf(value, names) ?? mentionedSkill(value, t('agent.chat.mention.skill'), names)
    if (skill) msg.skill = skill
    if (files.value.length) msg.fileIds = files.value.map((f) => f.id)
    if (running) msg.mode = sendMode.value
    if (!(await submit(msg)) || epoch !== sendEpoch) return
    acknowledge(msg)
  } finally {
    if (epoch === sendEpoch) sending.value = false
  }
}

const contextPercent = computed(() =>
  context && context.window > 0
    ? Math.min(100, Math.round((context.used / context.window) * 100))
    : null,
)

function openSelect(r: Openable | undefined) {
  r?.focus?.()
  r?.toggleMenu?.()
}
defineExpose({
  acknowledge,
  matchesDraft,
  resetDraft: () => {
    text.value = ''
    files.value = []
    history = []
    histPos = -1
  },
  focus: () => box.value?.focus(),
  /** 填入文字（开场提示、编辑上一条消息） */
  setText,
  runCommand,
  /** 直接发送一段文字（执行计划） */
  sendText: async (value: string) => {
    await setText(value)
    await send()
  },
  /** 点后续建议：输入框为空时直接发送；已有草稿时接在草稿后面，不覆盖也不发送 */
  suggest: async (value: string) => {
    if (!text.value.trim()) {
      await setText(value)
      return send()
    }
    await setText(`${text.value.trimEnd()}\n${value}`)
  },
})
</script>

<template>
  <div class="agent-composer">
    <div class="agent-composer__box">
      <ul
        v-if="suggestions.length"
        :id="listId"
        ref="suggestionList"
        class="agent-composer__suggest"
        role="listbox"
        :aria-label="t('agent.chat.composer.suggestions')"
      >
        <el-tooltip
          v-for="(s, i) in suggestions"
          :key="`${s.kind}-${s.label}`"
          placement="top-start"
          popper-class="agent-composer__tooltip"
        >
          <li
            :id="`${listId}-${i}`"
            role="option"
            :aria-selected="i === highlighted"
            :class="{ 'is-active': i === highlighted }"
            @mousedown.prevent="pick(s)"
          >
            <span class="agent-composer__label">{{ s.label }}</span>
            <span class="agent-composer__hint">{{ s.hint }}</span>
          </li>
          <template #content>
            <strong>{{ s.label }}</strong>
            <div v-if="s.hint">{{ s.hint }}</div>
          </template>
        </el-tooltip>
      </ul>
      <el-input
        ref="box"
        v-model="text"
        type="textarea"
        :autosize="{ minRows: 2, maxRows: 10 }"
        resize="none"
        :maxlength="AGENT_MESSAGE_MAX"
        :disabled
        :aria-label="t('agent.chat.composer.label')"
        :placeholder="
          t(
            pickingPrompt
              ? 'agent.chat.composer.promptPlaceholder'
              : pickingHistory
                ? 'agent.chat.composer.historyPlaceholder'
                : running
                  ? 'agent.chat.composer.queuePlaceholder'
                  : 'agent.chat.composer.placeholder',
          )
        "
        :aria-controls="suggestions.length ? listId : undefined"
        :aria-activedescendant="suggestions.length ? `${listId}-${highlighted}` : undefined"
        @input="onInput"
        @keydown="onKeydown"
        @click="syncCaret"
        @keyup="syncCaret"
      />
    </div>
    <p v-if="awaitingApproval && text.trim()" class="agent-composer__reject-hint" role="status">
      {{ t('agent.chat.composer.rejectHint') }}
    </p>
    <FileUpload
      v-if="showFiles"
      v-model="files"
      biz-tag="attachment"
      :limit="10"
      class="agent-composer__files"
    />
    <p v-if="current && !current.pricing" class="agent-composer__pricing" role="status">
      {{ t('agent.admin.model.pricingMissing') }}
    </p>
    <div class="agent-composer__bar">
      <IconButton
        icon="lucide:paperclip"
        :label="t('agent.chat.composer.attach')"
        :aria-pressed="showFiles"
        :disabled
        @click="showFiles = !showFiles"
      />
      <el-dropdown
        v-if="options?.prompts.length"
        trigger="click"
        @command="(body: string) => setText(body)"
      >
        <IconButton icon="lucide:notebook-text" :label="t('agent.chat.composer.prompts')" />
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item v-for="p in options.prompts" :key="p.id" :command="p.body">{{
              p.name
            }}</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <el-select
        ref="modelSelect"
        v-model="modelKey"
        class="agent-composer__model"
        :aria-label="t('agent.chat.composer.model')"
        :placeholder="t('agent.chat.composer.model')"
        :disabled="!options?.providers.length"
      >
        <el-option-group v-for="p in options?.providers ?? []" :key="p.id" :label="p.name">
          <el-option
            v-for="m in p.models"
            :key="m.id"
            :value="`${p.id}|${m.id}`"
            :label="m.label || m.id"
          />
        </el-option-group>
      </el-select>
      <el-button
        v-if="fastModel"
        class="agent-composer__toggle"
        :type="current?.fast ? 'primary' : undefined"
        :aria-pressed="!!current?.fast"
        @click="toggleFast"
      >
        {{ t('agent.chat.composer.fast') }}
      </el-button>
      <el-select
        v-if="current?.reasoning"
        v-model="reasoning"
        class="agent-composer__reasoning"
        clearable
        :aria-label="t('agent.chat.composer.reasoning')"
        :placeholder="defaultReasoningLabel"
        :title="defaultReasoningLabel"
      >
        <el-option v-for="r in reasoningChoices" :key="r" :value="r" :label="reasoningLabel(r)" />
      </el-select>
      <el-select
        ref="modeSelect"
        :model-value="settings.approvalMode"
        class="agent-composer__mode"
        :aria-label="t('agent.chat.composer.approvalMode')"
        :title="t(`agent.chat.modeHint.${settings.approvalMode}`)"
        @update:model-value="(m: AgentApprovalMode) => switchMode(m)"
      >
        <el-option
          v-for="m in modes"
          :key="m"
          :value="m"
          :label="t(`agent.chat.mode.${m}`)"
          :title="t(`agent.chat.modeHint.${m}`)"
        />
      </el-select>
      <span class="agent-composer__announce" aria-live="polite">{{ modeAnnounce }}</span>
      <span class="agent-composer__spacer" />
      <label
        v-if="contextPercent != null"
        class="agent-composer__context"
        :title="t('agent.chat.composer.contextEstimate', { percent: contextPercent })"
      >
        <span class="agent-composer__context-text">{{
          t('agent.chat.composer.contextEstimate', { percent: contextPercent })
        }}</span>
        <meter
          min="0"
          :max="context!.window"
          :value="context!.used"
          :high="context!.window * 0.85"
        />
      </label>
      <el-radio-group
        v-if="running"
        v-model="sendMode"
        :aria-label="t('agent.chat.composer.sendMode')"
      >
        <el-radio-button value="steer">{{ t('agent.chat.composer.steer') }}</el-radio-button>
        <el-radio-button value="queue">{{ t('agent.chat.composer.queue') }}</el-radio-button>
      </el-radio-group>
      <el-button v-if="running" :loading="stopping" :disabled="stopping" @click="emit('stop')">
        {{ t('agent.chat.composer.stop') }}
      </el-button>
      <el-button type="primary" :loading="sending" :disabled="!canSend" @click="send">
        {{ t('agent.chat.composer.send') }}
      </el-button>
    </div>
    <p class="agent-composer__keys">{{ t('agent.chat.composer.keys') }}</p>
  </div>
</template>
