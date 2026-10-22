<script setup lang="ts">
import {
  computed,
  nextTick,
  onActivated,
  onDeactivated,
  onMounted,
  ref,
  shallowRef,
  watch,
} from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useDebounceFn, useEventListener, useMediaQuery } from '@vueuse/core'
import { ElMessage, ElMessageBox } from 'element-plus'
import dayjs from 'dayjs'
import {
  agentPerms,
  RT,
  type AgentContext,
  type AgentItemVo,
  type AgentOptionsVo,
  type AgentProfileVo,
  type AgentStatusVo,
  type AgentThreadVo,
  type AgentTurnVo,
} from '@qiwu/shared'
import { agentApi } from '@/api/platform/agent'
import IconButton from '@/core/components/IconButton.vue'
import { toastRest } from '@/core/composables/use-crud'
import { usePerm } from '@/core/permission'
import { onRealtime, realtimeStatus } from '@/core/realtime/socket'
import { saveBlob } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import ChatItem from './ChatItem.vue'
import Composer, { type ComposerMessage, type ComposerSettings } from './Composer.vue'
import NotifySettings from './NotifySettings.vue'
import ProfileMemoryBar, { type ProfileDraft } from './ProfileMemoryBar.vue'
import ShortcutSettings from './ShortcutSettings.vue'
import { comboOf, loadShortcuts, saveShortcuts } from './shortcuts'
import ThreadList from './ThreadList.vue'
import { applyItemEvent, catchUpSeq, chatRows, mergeItems, type SlashCommand } from './thread-state'
import { pendingContext, pendingRoute } from './use-agent-context'

/**
 * “智能助手”对话页（整页的对话应用）：左侧会话列表，中间对话流，底部输入框。
 * 打开会话时从接口读全部条目，之后靠 `agent:event` 实时更新（新增 / 替换条目、增量文本、轮次状态）；
 * 断线重连、页面重新显示或漏了事件时用 `afterSeq` 从接口补齐。所有接口只作用于本人的会话；
 * 地址里的 `?shared=<token>` 显示同租户的只读分享快照。其他会话的推送更新列表（未读数、轮次状态，
 * 未列出的会话会重读列表）。快捷键（新会话、聚焦输入框、停止、切换计划模式）可在头部自定义，本人本浏览器
 * 保存；默认 Alt+N 新会话（不与全局菜单搜索的 Ctrl/⌘+K 冲突，也不占用浏览器的查找）。会话可在新窗口打开。
 */
// keep-alive 名称 = 菜单种子的 component_name
defineOptions({ name: 'AgentChat' })

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const perm = usePerm()
const SETTING_ROUTE = 'agent-setting'
const SKILL_ROUTE = 'agent-skill'

const listRef = ref<InstanceType<typeof ThreadList>>()
const composerRef = ref<InstanceType<typeof Composer>>()

// ---- 选项 ----
const options = shallowRef<AgentOptionsVo | null>(null)
/** 未配置模型或已暂停时输入框不可用（接口也会拒绝） */
const unavailable = computed(
  () => !options.value || options.value.paused || !options.value.defaults,
)
function defaultSettings(): ComposerSettings {
  const modes = options.value?.approvalModes ?? []
  return {
    providerId: options.value?.defaults?.providerId ?? null,
    model: options.value?.defaults?.model ?? null,
    reasoning: null,
    approvalMode: modes.includes('ask') ? 'ask' : (modes[0] ?? 'ask'),
    planMode: false,
  }
}
/** 读输入框选项（`route`：入口按钮所在页面，开场提示随它）；新会话草稿随之换成默认模型与审批模式。 */
async function loadOptions(route?: string) {
  try {
    options.value = await agentApi.options(route)
    if (!thread.value) settings.value = defaultSettings()
  } catch (e) {
    toastRest(e)
  }
}

// ---- 当前会话 ----
const thread = shallowRef<AgentThreadVo | null>(null)
const items = shallowRef<AgentItemVo[]>([])
const turn = shallowRef<AgentTurnVo | null>(null)
const status = shallowRef<AgentStatusVo | null>(null)
/** 从别的页面带来的上下文，只用于新建会话 */
const context = shallowRef<AgentContext | null>(null)
const settings = ref<ComposerSettings>(defaultSettings())
/** 新会话草稿是否是临时会话（不进列表，离开即删） */
const temporary = ref(false)
/** 窄屏（≤ 640px）：方案、记忆、通知、快捷键与新窗口收进“更多”展开的一行，避免头部横向溢出 */
const narrow = useMediaQuery('(max-width: 640px)')
const moreOpen = ref(false)
/** 新会话草稿的配置方案（undefined：默认方案）与是否使用记忆 */
const draft = ref<ProfileDraft>({ profileId: undefined, memoryEnabled: true })
/** 正在编辑最后一条用户消息：发送时从它之前分叉出新会话再发 */
const editing = ref<{ seq: number } | null>(null)
/** 只读分享快照的 token */
const sharedToken = ref<string | null>(null)
const loadingThread = ref(false)
const showStatus = ref(false)
const stopping = ref(false)
const rows = computed(() => chatRows(items.value, turn.value))
const running = computed(() => turn.value?.status === 'running' || turn.value?.status === 'waiting')
const lastUserSeq = computed(() => items.value.filter((i) => i.kind === 'user').at(-1)?.seq ?? null)
/** 可 `@` 提及的记录：草稿带来的上下文，或会话第一条消息带着的上下文 */
const records = computed(() => {
  let ctx = context.value
  for (const i of items.value) if (!ctx && i.kind === 'user') ctx = i.payload.context ?? null
  const target = ctx?.target
  return target ? (ctx!.ids ?? []).map((id) => ({ target, id })) : []
})
/** 计划模式下最后一条回答已完成：可“执行此计划” */
const canRunPlan = computed(() => {
  const last = items.value.at(-1)
  return (
    !!thread.value &&
    thread.value.planMode &&
    !running.value &&
    last?.kind === 'assistant' &&
    last.status === 'done'
  )
})
const contextUse = computed(() =>
  status.value && thread.value && status.value.threadId === thread.value.id
    ? { used: status.value.contextUsed, window: status.value.contextWindow }
    : null,
)
let openSeq = 0

const settingsOf = (th: AgentThreadVo): ComposerSettings => ({
  providerId: th.providerId,
  model: th.model,
  reasoning: th.reasoning,
  approvalMode: th.approvalMode,
  planMode: th.planMode,
})
function setQuery(p: { thread?: number; shared?: string }) {
  const query = { ...route.query }
  delete query.thread
  delete query.shared
  if (p.thread != null) query.thread = String(p.thread)
  if (p.shared) query.shared = p.shared
  void router.replace({ query })
}

/** 离开临时会话时删掉它（服务端也不列出它）；失败不打扰用户。 */
function leaveTemporary(next: number | null) {
  const th = thread.value
  if (th?.temporary && th.id !== next) agentApi.removeThread(th.id).catch(() => undefined)
}

/** 打开一个会话：读全部条目、最近一轮与上下文用量，滚到最新，标记已读。 */
async function openThread(id: number) {
  leaveTemporary(id)
  const mine = ++openSeq
  loadingThread.value = true
  try {
    const d = await agentApi.items(id)
    if (mine !== openSeq) return
    thread.value = d.thread
    items.value = d.items
    turn.value = d.turn
    context.value = null
    editing.value = null
    sharedToken.value = null
    settings.value = settingsOf(d.thread)
    showStatus.value = false
    follow.value = true
    readSeq = d.thread.unread ? 0 : (d.items.at(-1)?.seq ?? 0)
    setQuery({ thread: id })
    void toBottom()
    void loadStatus()
    markRead()
  } catch (e) {
    if (mine === openSeq) toastRest(e)
  } finally {
    if (mine === openSeq) loadingThread.value = false
  }
}

/** 只读查看别人分享的会话快照（同租户；工具结果按查看者自己的权限显示）。 */
async function openShared(token: string) {
  leaveTemporary(null)
  const mine = ++openSeq
  loadingThread.value = true
  try {
    const d = await agentApi.shared(token)
    if (mine !== openSeq) return
    thread.value = null
    items.value = d.items
    turn.value = null
    status.value = null
    sharedToken.value = token
    sharedTitle.value = d.thread.title
  } catch (e) {
    if (mine === openSeq) toastRest(e)
  } finally {
    if (mine === openSeq) loadingThread.value = false
  }
}
const sharedTitle = ref('')

/** 新会话草稿（`/new`、`/clear`、新建按钮、Ctrl/⌘+K、入口按钮）：第一次发送时才在服务端创建。 */
function newDraft(ctx: AgentContext | null = null) {
  leaveTemporary(null)
  openSeq++
  loadingThread.value = false
  thread.value = null
  items.value = []
  turn.value = null
  status.value = null
  context.value = ctx
  editing.value = null
  sharedToken.value = null
  settings.value = defaultSettings()
  draft.value = { profileId: undefined, memoryEnabled: true }
  showStatus.value = false
  setQuery({})
  void nextTick(() => composerRef.value?.focus())
}

/**
 * 从接口补齐：取 `catchUpSeq` 之后的条目（含仍在进行中、可能被改写的条目）与最近一轮，按 id 合并。
 * 用于断线重连、页面重新显示、发送或决定之后，以及收到指向未知条目的增量文本时。
 */
async function catchUp() {
  const th = thread.value
  if (!th) return
  try {
    const d = await agentApi.items(th.id, catchUpSeq(items.value, turn.value))
    if (thread.value?.id !== th.id) return
    items.value = mergeItems(items.value, d.items)
    turn.value = d.turn
    thread.value = d.thread
    markRead()
  } catch (e) {
    toastRest(e)
  }
}

/** 上下文用量、本轮与今日用量和限额（输入框旁的用量条与 `/status`）。 */
async function loadStatus() {
  const th = thread.value
  if (!th) return
  try {
    const s = await agentApi.status(th.id)
    if (thread.value?.id === th.id) status.value = s
  } catch {
    // 用量只是提示，读不到不打扰用户
  }
}

// ---- 已读：页面显示着会话时，把看到的最后一条标为已读 ----
let readSeq = 0
let pageActive = true
const markRead = useDebounceFn(async () => {
  const th = thread.value
  const seq = items.value.at(-1)?.seq ?? 0
  if (!th || !pageActive || seq <= readSeq) return
  readSeq = seq
  try {
    await agentApi.read(th.id, seq)
    listRef.value?.patch(th.id, { unread: 0 })
  } catch {
    readSeq = 0
  }
}, 300)

// ---- 实时事件 ----
/** 已为它加过未读数的条目：同一条目后续的改写（流式结束、审批决定）不再重复计数 */
const counted = new Set<number>()
onRealtime(RT.agentEvent, (ev) => {
  const list = listRef.value
  if (ev.type === 'turn')
    list?.patch(ev.threadId, {
      turnStatus: ev.turn.status,
      lastActiveAt: ev.turn.startedAt,
    })
  // 列表里还没有的会话（别的标签页新建的、批次开的）或轮次状态变化：重读列表（防抖）
  // 打开着的会话不在列表里（临时会话从不列出）时不必为它的每条增量重读
  const unknown = ev.threadId !== thread.value?.id && !list?.has(ev.threadId)
  if (list && (ev.type === 'turn' || unknown)) list.refresh()
  if (ev.threadId !== thread.value?.id) {
    // 其他会话的新条目：未读数实时加 1（服务端也不计本人发的消息）
    if (ev.type === 'item' && ev.item.kind !== 'user' && !counted.has(ev.item.id)) {
      counted.add(ev.item.id)
      list?.bumpUnread(ev.threadId)
    }
    return
  }
  if (ev.type === 'turn') {
    // 较早一轮迟到的状态不覆盖当前轮
    if (!turn.value || ev.turn.id >= turn.value.id) turn.value = ev.turn
    if (ev.turn.status !== 'running') void loadStatus()
    return
  }
  const next = applyItemEvent(items.value, ev)
  if (!next) return void catchUp()
  items.value = next
  if (ev.type === 'item') markRead()
})
// 断线期间的事件不会重发：重新连上后补齐当前会话并重读列表
watch(realtimeStatus, (now, before) => {
  if (now !== 'up' || before === 'up') return
  void catchUp()
  listRef.value?.refresh()
})

// ---- 自动滚动：用户往上翻时停止跟随，回到底部后恢复 ----
const streamRef = ref<HTMLElement>()
const follow = ref(true)
const atBottom = () => {
  const el = streamRef.value
  return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 40
}
async function toBottom() {
  await nextTick()
  const el = streamRef.value
  if (el) el.scrollTop = el.scrollHeight
}
watch(items, () => follow.value && void toBottom())

// ---- 发送、停止、设置 ----
/**
 * 新建会话（草稿设置、配置方案与记忆开关、带来的上下文、是否临时）；不带标题，服务端在第一轮后自动起名。
 */
async function createThread() {
  const s = settings.value
  const d = draft.value
  const th = await agentApi.createThread({
    approvalMode: s.approvalMode,
    planMode: s.planMode,
    // undefined：服务端取本人的默认方案；null：明确不用方案
    ...(d.profileId !== undefined ? { profileId: d.profileId } : {}),
    // 记忆默认开，只在关掉时才带上（临时会话不读不写记忆）
    ...(temporary.value ? { temporary: true } : d.memoryEnabled ? {} : { memoryEnabled: false }),
    ...(s.providerId != null && s.model ? { providerId: s.providerId, model: s.model } : {}),
    ...(s.reasoning ? { reasoning: s.reasoning } : {}),
    ...(context.value ? { context: context.value } : {}),
  })
  context.value = null
  temporary.value = false
  return th
}

/** 草稿选了配置方案：输入框换成方案的模型、推理强度与审批模式（平台此刻提供的）；不用方案回到默认。 */
function applyProfile(p: AgentProfileVo | null) {
  const base = defaultSettings()
  const modes = options.value?.approvalModes ?? []
  settings.value = {
    ...base,
    planMode: settings.value.planMode,
    ...(p?.providerId != null && p.model ? { providerId: p.providerId, model: p.model } : {}),
    reasoning: p?.reasoning ?? null,
    ...(p && modes.includes(p.approvalMode) ? { approvalMode: p.approvalMode } : {}),
  }
}

/** 会话的记忆开关已保存：换上服务端返回的会话。 */
function onThreadUpdated(next: AgentThreadVo) {
  if (thread.value?.id !== next.id) return
  thread.value = next
  listRef.value?.upsert(next)
}

/**
 * 发送一条消息：没有会话时先创建；编辑最后一条用户消息时先从它之前分叉出新会话再发（原会话不变）。
 * 运行中按输入框选的方式追加或排队。
 */
async function submit(msg: ComposerMessage): Promise<boolean> {
  try {
    let th = thread.value
    const fork = editing.value
    if (th && fork) th = await agentApi.fork(th.id, fork.seq - 1)
    else if (!th) th = await createThread()
    if (th.id !== thread.value?.id) {
      openSeq++
      thread.value = th
      items.value = []
      turn.value = null
      editing.value = null
      readSeq = 0
      listRef.value?.upsert(th)
      setQuery({ thread: th.id })
      if (fork) await openThread(th.id)
    }
    turn.value = await agentApi.send(th.id, msg)
    follow.value = true
    await catchUp()
    void loadStatus()
    return true
  } catch (e) {
    toastRest(e)
    return false
  }
}

async function stop() {
  const th = thread.value
  if (!th || stopping.value) return
  stopping.value = true
  try {
    await agentApi.cancel(th.id)
    await catchUp()
  } catch (e) {
    toastRest(e)
  } finally {
    stopping.value = false
  }
}

// 已有会话时，换模型、推理强度、审批模式或计划模式立即保存到会话上
watch(settings, async (s) => {
  const th = thread.value
  if (!th) return
  const now = settingsOf(th)
  if (JSON.stringify(now) === JSON.stringify(s)) return
  try {
    const next = await agentApi.updateThread(th.id, {
      ...(s.providerId != null && s.model ? { providerId: s.providerId, model: s.model } : {}),
      reasoning: s.reasoning,
      approvalMode: s.approvalMode,
      planMode: s.planMode,
    })
    if (thread.value?.id !== th.id) return
    thread.value = next
    listRef.value?.upsert(next)
  } catch (e) {
    toastRest(e)
    if (thread.value?.id === th.id) settings.value = now
  }
})

/** 从某条消息分叉：新会话带着到这条为止的内容，打开它。 */
async function fork(seq: number) {
  const th = thread.value
  if (!th) return
  try {
    const next = await agentApi.fork(th.id, seq)
    listRef.value?.upsert(next)
    await openThread(next.id)
  } catch (e) {
    toastRest(e)
  }
}

/** 编辑最后一条用户消息：文字放回输入框，发送时分叉重发。 */
function startEdit(seq: number, text: string) {
  editing.value = { seq }
  void composerRef.value?.setText(text)
}

// ---- 会话菜单：撤回、导出、分享 ----
/** 撤回最后一轮：确认时说明已执行的写入不会回滚。 */
async function revert() {
  const th = thread.value
  if (!th) return
  try {
    await ElMessageBox.confirm(t('agent.chat.revert.confirm'), t('agent.chat.revert.title'), {
      type: 'warning',
      confirmButtonText: t('agent.chat.revert.action'),
      cancelButtonText: t('common.action.cancel'),
    })
  } catch {
    return
  }
  try {
    await agentApi.revert(th.id)
    await openThread(th.id)
  } catch (e) {
    toastRest(e)
  }
}

/** 导出为 Markdown 文件。 */
async function exportMarkdown() {
  const th = thread.value
  if (!th) return
  try {
    const { name, text } = await agentApi.exportMarkdown(th.id)
    saveBlob(new Blob([text], { type: 'text/markdown;charset=utf-8' }), name)
  } catch (e) {
    toastRest(e)
  }
}

/** 生成（或取回）只读分享链接，复制并显示出来。 */
async function share() {
  const th = thread.value
  if (!th) return
  try {
    const { token } = await agentApi.share(th.id)
    const link = new URL(router.resolve({ query: { shared: token } }).href, location.href).href
    thread.value = { ...th, shared: true }
    try {
      await navigator.clipboard.writeText(link)
    } catch {
      // 剪贴板不可用：链接仍显示在下面的对话框里
    }
    await ElMessageBox.alert(link, t('agent.chat.share.title'), {
      confirmButtonText: t('agent.chat.share.done'),
    }).catch(() => undefined)
  } catch (e) {
    toastRest(e)
  }
}

/** 停止分享：之前发出的链接失效。 */
async function unshare() {
  const th = thread.value
  if (!th) return
  try {
    await agentApi.unshare(th.id)
    thread.value = { ...th, shared: false }
    ElMessage.success(t('agent.chat.share.stopped'))
  } catch (e) {
    toastRest(e)
  }
}

/**
 * 存成技能：由模型根据本会话写一个个人技能草稿（停用，待检查），完成后打开技能页编辑它。
 * 模型写草稿要一会儿，进行中菜单项不可再点。
 */
const savingSkill = ref(false)
async function saveAsSkill() {
  const th = thread.value
  if (!th || savingSkill.value) return
  savingSkill.value = true
  ElMessage.info(t('agent.chat.saveSkill.working'))
  try {
    const skill = await agentApi.skillFromThread(th.id)
    ElMessage.success(t('agent.chat.saveSkill.done', { name: skill.name }))
    if (router.hasRoute(SKILL_ROUTE))
      void router.push({ name: SKILL_ROUTE, query: { edit: String(skill.id) } })
  } catch (e) {
    toastRest(e)
  } finally {
    savingSkill.value = false
  }
}

type ThreadCommand = 'revert' | 'export' | 'share' | 'unshare' | 'skill'
function onThreadCommand(cmd: ThreadCommand) {
  const run = { revert, export: exportMarkdown, share, unshare, skill: saveAsSkill }[cmd]
  void run()
}

/**
 * 执行此计划：先在会话上关掉计划模式（保存成功后才发，免得这一轮仍按只读计划运行），
 * 再发一条“按计划执行”。
 */
const runningPlan = ref(false)
async function runPlan() {
  const th = thread.value
  if (!th || runningPlan.value) return
  runningPlan.value = true
  try {
    const next = await agentApi.updateThread(th.id, { planMode: false })
    if (thread.value?.id !== th.id) return
    thread.value = next
    settings.value = settingsOf(next)
    listRef.value?.upsert(next)
    await submit({ text: t('agent.chat.planRun.text') })
  } catch (e) {
    toastRest(e)
  } finally {
    runningPlan.value = false
  }
}

// ---- 斜杠命令（输入框自己处理模型、审批、计划、技能与提示词） ----
async function onCommand(cmd: SlashCommand) {
  switch (cmd) {
    case 'new':
    case 'clear':
      return newDraft()
    case 'compact':
      if (!thread.value) return ElMessage.info(t('agent.chat.noThread'))
      try {
        await agentApi.compact(thread.value.id)
        ElMessage.success(t('agent.chat.compacted'))
        await catchUp()
      } catch (e) {
        toastRest(e)
      }
      return
    case 'mcp':
      if (perm.has(agentPerms.setting.browse) && router.hasRoute(SETTING_ROUTE))
        return void router.push({ name: SETTING_ROUTE })
      return ElMessage.warning(t('agent.chat.slash.noSetting'))
    case 'status':
      showStatus.value = true
      return loadStatus()
  }
}

// ---- 快捷键：本人在本浏览器自定义（默认 Alt+N 新会话）；只在本页显示时；按物理键判断，mac 的 ⌥ 会改变 e.key ----
const userId = useAuthStore().me?.user.id ?? 0
const shortcuts = ref(loadShortcuts(userId))
watch(shortcuts, (m) => saveShortcuts(userId, m))
useEventListener(window, 'keydown', (e: KeyboardEvent) => {
  if (!pageActive || e.defaultPrevented) return
  const combo = comboOf(e)
  const map = shortcuts.value
  if (!combo) return
  if (combo === map.newChat) newDraft()
  else if (combo === map.focusComposer) composerRef.value?.focus()
  else if (combo === map.togglePlan && !sharedToken.value)
    settings.value = { ...settings.value, planMode: !settings.value.planMode }
  else return
  e.preventDefault()
})

/** 在新窗口打开当前会话（地址带 `?thread=<id>`，新窗口打开时直接载入它）。 */
function openInWindow() {
  const th = thread.value
  if (!th) return
  window.open(
    router.resolve({ path: route.path, query: { thread: th.id } }).href,
    '_blank',
    'noopener',
  )
}

// ---- 进入页面 ----
/** 入口按钮带来的上下文：开一个新草稿并显示来源，开场提示换成适合来源页面的。 */
function takeContext() {
  const ctx = pendingContext.value
  if (!ctx) return false
  pendingContext.value = null
  newDraft(ctx)
  const from = pendingRoute.value
  pendingRoute.value = null
  if (from) void loadOptions(from)
  return true
}
if (!pendingRoute.value) void loadOptions()
onMounted(() => {
  if (takeContext()) return
  const shared = route.query.shared
  const id = Number(route.query.thread)
  if (typeof shared === 'string' && shared) void openShared(shared)
  else if (Number.isInteger(id) && id > 0) void openThread(id)
})
onActivated(() => {
  pageActive = true
  if (!takeContext()) void catchUp()
})
onDeactivated(() => (pageActive = false))

const time = (iso: string | null) => (iso ? dayjs(iso).format('YYYY-MM-DD HH:mm:ss') : '')
</script>

<template>
  <div class="agent-chat">
    <ThreadList
      ref="listRef"
      :active-id="thread?.id ?? null"
      @open="(th) => openThread(th.id)"
      @create="newDraft()"
      @gone="(id) => thread?.id === id && newDraft()"
    />

    <section class="agent-chat__main" :aria-label="t('agent.chat.title')">
      <header class="agent-chat__head">
        <h2 class="agent-chat__title">
          {{ sharedToken ? sharedTitle : thread?.title || t('agent.chat.thread.new') }}
        </h2>
        <el-tag v-if="sharedToken" size="small" type="info">{{
          t('agent.chat.share.readonly')
        }}</el-tag>
        <span role="status" class="agent-chat__turn">
          <el-tag
            v-if="turn"
            size="small"
            :type="
              turn.status === 'failed' ? 'danger' : turn.status === 'waiting' ? 'warning' : 'info'
            "
          >
            {{ t(`agent.chat.turn.${turn.status}`) }}
          </el-tag>
        </span>
        <span class="agent-composer__spacer" />
        <el-switch
          v-if="!thread && !sharedToken"
          v-model="temporary"
          :active-text="t('agent.chat.temporary')"
          :aria-label="t('agent.chat.temporary')"
        />
        <IconButton
          v-if="narrow"
          icon="lucide:ellipsis"
          :label="t('crud.action.more')"
          :aria-expanded="moreOpen"
          aria-controls="agent-chat-tools"
          @click="moreOpen = !moreOpen"
        />
        <div v-show="!narrow || moreOpen" id="agent-chat-tools" class="agent-chat__tools">
          <ProfileMemoryBar
            v-if="!sharedToken"
            v-model:draft="draft"
            :thread="thread"
            :options="options"
            :temporary="temporary"
            @apply="applyProfile"
            @updated="onThreadUpdated"
          />
          <NotifySettings v-if="!sharedToken" />
          <ShortcutSettings v-model="shortcuts" />
          <IconButton
            v-if="thread && !thread.temporary"
            icon="lucide:external-link"
            :label="t('agent.chat.newWindow')"
            @click="openInWindow"
          />
        </div>
        <el-dropdown v-if="thread" trigger="click" @command="onThreadCommand">
          <IconButton icon="lucide:ellipsis-vertical" :label="t('agent.chat.thread.menu')" />
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="revert" :disabled="!turn || running">
                {{ t('agent.chat.revert.title') }}
              </el-dropdown-item>
              <el-dropdown-item command="export">{{ t('agent.chat.export') }}</el-dropdown-item>
              <el-dropdown-item v-if="!thread.temporary" command="share">{{
                t('agent.chat.share.create')
              }}</el-dropdown-item>
              <el-dropdown-item v-if="thread.shared" command="unshare">{{
                t('agent.chat.share.stop')
              }}</el-dropdown-item>
              <el-dropdown-item command="skill" :disabled="savingSkill || running">
                {{ t('agent.chat.saveSkill.action') }}
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </header>

      <el-alert
        v-if="options?.paused"
        type="warning"
        :closable="false"
        show-icon
        :title="t('agent.chat.paused')"
      />
      <el-alert
        v-else-if="options && !options.defaults"
        type="info"
        :closable="false"
        show-icon
        :title="t('agent.chat.notConfigured')"
      />

      <div
        ref="streamRef"
        v-loading="loadingThread"
        class="agent-chat__stream"
        role="log"
        aria-live="polite"
        :aria-busy="running"
        :aria-label="t('agent.chat.messages')"
        @scroll="follow = atBottom()"
      >
        <div v-if="!thread && !sharedToken && !items.length" class="agent-chat__welcome">
          <p class="agent-chat__hello">{{ t('agent.chat.welcome') }}</p>
          <div v-if="options?.starters.length" class="agent-chat__examples">
            <el-button
              v-for="s in options.starters"
              :key="s"
              round
              @click="composerRef?.setText(s)"
            >
              {{ s }}
            </el-button>
          </div>
        </div>
        <ChatItem
          v-for="(r, i) in rows"
          :key="r.key"
          :row="r"
          :can-fork="!!thread"
          :can-edit="
            r.kind === 'item' && r.item.kind === 'user' && r.item.seq === lastUserSeq && !running
          "
          :last="i === rows.length - 1 && !running"
          :readonly="!!sharedToken"
          :trust="options?.trustSession ?? false"
          :can-run-plan="canRunPlan && i === rows.length - 1"
          :running-plan="runningPlan"
          @fork="fork"
          @edit="startEdit"
          @suggest="(s) => composerRef?.suggest(s)"
          @changed="catchUp"
          @run-plan="runPlan"
        />
      </div>

      <div
        v-if="showStatus && !sharedToken"
        class="agent-card agent-chat__status"
        role="region"
        :aria-label="t('agent.chat.status.title')"
      >
        <header class="agent-card__head">
          <span class="agent-card__title">{{ t('agent.chat.status.title') }}</span>
          <IconButton
            icon="lucide:x"
            :label="t('agent.chat.status.close')"
            @click="showStatus = false"
          />
        </header>
        <dl v-if="status" class="agent-card__fields">
          <template v-if="status.turn">
            <dt>{{ t('agent.chat.status.state') }}</dt>
            <dd>{{ t(`agent.chat.turn.${status.turn.status}`) }}</dd>
            <dt>{{ t('agent.chat.status.steps') }}</dt>
            <dd>{{ status.turn.steps }}</dd>
            <dt>{{ t('agent.chat.status.tokens') }}</dt>
            <dd>
              {{
                t('agent.chat.status.tokenValue', {
                  prompt: status.turn.promptTokens,
                  completion: status.turn.completionTokens,
                })
              }}
            </dd>
            <dt>{{ t('agent.chat.status.started') }}</dt>
            <dd>{{ time(status.turn.startedAt) }}</dd>
          </template>
          <dt>{{ t('agent.chat.status.context') }}</dt>
          <dd>
            {{
              t('agent.chat.status.of', { used: status.contextUsed, limit: status.contextWindow })
            }}
          </dd>
          <dt>{{ t('agent.chat.status.userToday') }}</dt>
          <dd>
            {{
              t('agent.chat.status.of', {
                used: status.today.userTokens,
                limit: status.today.userLimit,
              })
            }}
          </dd>
          <dt>{{ t('agent.chat.status.tenantToday') }}</dt>
          <dd>
            {{
              t('agent.chat.status.of', {
                used: status.today.tenantTokens,
                limit: status.today.tenantLimit,
              })
            }}
          </dd>
        </dl>
        <p v-else class="agent-card__meta">{{ t('agent.chat.status.none') }}</p>
      </div>

      <template v-if="!sharedToken">
        <div v-if="context || editing" class="agent-chat__context">
          <el-tag v-if="context" closable type="info" @close="context = null">
            {{ t('agent.chat.context.from', { title: context.title || context.route }) }}
            <template v-if="context.ids?.length"
              >· {{ t('agent.chat.context.selected', { n: context.ids.length }) }}</template
            >
          </el-tag>
          <el-tag v-if="editing" closable type="warning" @close="editing = null">
            {{ t('agent.chat.action.editing') }}
          </el-tag>
        </div>
        <p v-if="running" class="agent-card__meta">{{ t('agent.chat.composer.queueHint') }}</p>
        <Composer
          ref="composerRef"
          v-model:settings="settings"
          :options
          :submit
          :running
          :stopping
          :context="contextUse"
          :records
          :temporary="thread ? thread.temporary : temporary"
          :disabled="unavailable"
          :stop-key="shortcuts.stop"
          @stop="stop"
          @command="onCommand"
        />
      </template>
    </section>
  </div>
</template>

<style scoped>
.agent-chat {
  display: flex;
  gap: 16px;
  height: calc(100vh - 180px);
  min-height: 480px;
}
.agent-chat :deep(.agent-threads),
.agent-chat__main {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  padding: 12px;
  background: var(--qw-surface);
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius);
  box-shadow: var(--qw-shadow-1);
}
.agent-chat__main {
  flex: 1;
  min-width: 0;
}
.agent-chat__head {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.agent-chat__tools {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.agent-chat__title {
  min-width: 0;
  max-width: 100%;
  margin: 0;
  overflow: hidden;
  font-size: 15px;
  font-weight: 600;
  color: var(--qw-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-chat__stream {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  padding: 8px 4px;
  overflow: auto;
}
.agent-chat__welcome {
  display: flex;
  flex-direction: column;
  gap: 16px;
  align-items: center;
  margin: auto;
  text-align: center;
}
.agent-chat__hello {
  margin: 0;
  font-size: 18px;
  color: var(--qw-text);
}
.agent-chat__examples {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
}
.agent-chat__examples .el-button {
  margin: 0;
}
.agent-chat__context {
  display: flex;
}
@media (max-width: 1100px) {
  .agent-chat {
    flex-direction: column;
    height: auto;
  }
  .agent-chat__stream {
    height: 55vh;
  }
}
/* narrow: switches without their text (the aria-label stays), the tools on a row of their own */
@media (max-width: 640px) {
  .agent-chat__head :deep(.el-switch__label) {
    display: none;
  }
  .agent-chat__tools {
    flex-basis: 100%;
    justify-content: flex-end;
  }
}
</style>

<!-- 子组件共用的卡片、消息与 Markdown 样式（类名都带 agent- / qw-md 前缀） -->
<style>
.agent-threads {
  flex: none;
  width: 260px;
}
.agent-threads__new {
  width: 100%;
}
.agent-threads__scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.agent-threads__label {
  margin: 12px 4px 4px;
  font-size: 12px;
  font-weight: 500;
  color: var(--qw-text-3);
}
.agent-threads__list {
  padding: 0;
  margin: 0;
  list-style: none;
}
.agent-threads__row {
  display: flex;
  gap: 2px;
  align-items: center;
  border-radius: var(--qw-radius-sm);
}
.agent-threads__row:hover {
  background: var(--qw-surface-2);
}
.agent-threads__row.is-active {
  background: var(--qw-brand-weak);
}
.agent-threads__open {
  display: flex;
  flex: 1;
  gap: 6px;
  align-items: center;
  min-width: 0;
  padding: 8px;
  font: inherit;
  color: var(--qw-text);
  text-align: left;
  cursor: pointer;
  background: none;
  border: 0;
  border-radius: var(--qw-radius-sm);
}
.agent-threads__row.is-active .agent-threads__open {
  color: var(--qw-brand-text);
}
.agent-threads__open:focus-visible {
  outline: 2px solid var(--qw-brand-text);
}
.agent-threads__title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-threads__status {
  flex: none;
  font-size: 12px;
  color: var(--qw-warning);
}
.agent-msg {
  position: relative;
  display: flex;
  gap: 4px;
  align-items: flex-start;
}
.agent-msg--user {
  flex-direction: row-reverse;
  align-self: flex-end;
  max-width: 80%;
}
.agent-msg--assistant {
  max-width: 100%;
}
.agent-msg__bubble {
  padding: 8px 12px;
  background: var(--qw-brand-weak);
  border-radius: var(--qw-radius);
}
.agent-msg__text {
  margin: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.agent-msg__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 4px;
}
.agent-msg--user .agent-msg__actions {
  opacity: 0;
}
.agent-msg:hover .agent-msg__actions,
.agent-msg__actions:focus-within {
  opacity: 1;
}
.agent-msg__actions {
  display: flex;
  gap: 2px;
}
.agent-msg__answer {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.agent-msg__citations {
  padding-left: 20px;
  margin: 0;
  font-size: 12px;
}
.agent-msg__citations a {
  color: var(--qw-brand-text);
}
.agent-msg__suggest {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.agent-msg__suggest .el-button {
  margin: 0;
}
.agent-msg__queued {
  margin-top: 4px;
}
.agent-reasoning {
  font-size: 13px;
  color: var(--qw-text-2);
}
.agent-reasoning summary {
  cursor: pointer;
}
.agent-divider {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 12px;
  color: var(--qw-text-3);
}
.agent-divider::before,
.agent-divider::after {
  flex: 1;
  content: '';
  border-top: 1px solid var(--qw-border);
}
.agent-threads__views {
  display: flex;
}
.agent-threads__filters {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.agent-msg__run-plan {
  align-self: flex-start;
}
.qw-md h3,
.qw-md h4,
.qw-md h5,
.qw-md h6 {
  margin: 12px 0 6px;
  font-weight: 600;
  color: var(--qw-text);
}
.qw-md h3 {
  font-size: 16px;
}
.qw-md h4 {
  font-size: 15px;
}
.qw-md h5,
.qw-md h6 {
  font-size: 14px;
}
.agent-threads__pin {
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--qw-text-3);
}
.agent-threads__unread {
  flex: none;
  min-width: 18px;
  padding: 0 5px;
  font-size: 12px;
  line-height: 18px;
  color: var(--qw-on-brand);
  text-align: center;
  background: var(--qw-brand);
  border-radius: 9px;
}
.agent-composer__context {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 12px;
  color: var(--qw-text-3);
}
.agent-composer__context meter {
  width: 64px;
}
.agent-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  background: var(--qw-surface-2);
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius);
}
.agent-card:focus-visible {
  outline: 2px solid var(--qw-brand-text);
}
.agent-card__head {
  display: flex;
  gap: 8px;
  align-items: center;
}
.agent-card__title {
  font-weight: 600;
  color: var(--qw-text);
}
.agent-card__meta {
  margin: 0;
  font-size: 12px;
  color: var(--qw-text-3);
}
.agent-card__fields {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  margin: 0;
  font-size: 13px;
}
.agent-card__fields dt {
  color: var(--qw-text-2);
}
.agent-card__fields dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.agent-card__pre {
  max-height: 240px;
  padding: 8px;
  margin: 0;
  overflow: auto;
  font-size: 12px;
  white-space: pre-wrap;
  background: var(--qw-surface);
  border-radius: var(--qw-radius-sm);
}
.agent-card__actions {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: flex-end;
}
.agent-tool__summary {
  display: flex;
  gap: 8px;
  align-items: center;
  cursor: pointer;
}
.agent-tool__icon,
.agent-plan__icon {
  flex: none;
  width: 16px;
  height: 16px;
  color: var(--qw-text-2);
}
.agent-tool__body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 8px;
}
.agent-tool__error {
  margin: 0;
  color: var(--qw-danger);
}
.agent-approval {
  border-color: var(--qw-warning);
}
.agent-approval__changes {
  width: 100%;
  font-size: 13px;
  border-collapse: collapse;
}
.agent-approval__changes th,
.agent-approval__changes td {
  padding: 4px 8px;
  text-align: left;
  border-bottom: 1px solid var(--qw-border);
}
.agent-approval__from {
  color: var(--qw-text-3);
}
.agent-approval__to {
  color: var(--qw-success);
}
.agent-approval__sources ul {
  padding-left: 18px;
  margin: 4px 0 0;
}
.agent-approval__sources a,
.qw-md a {
  color: var(--qw-brand-text);
}
.agent-question {
  border-color: var(--qw-brand-text);
}
.agent-question__q {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0;
  margin: 0;
  border: 0;
}
.agent-question__legend {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 0;
  margin-bottom: 4px;
}
.agent-question__options {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}
.agent-question__desc {
  margin-left: 8px;
  font-size: 12px;
  color: var(--qw-text-3);
}
.agent-plan__steps {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0;
  margin: 0;
  list-style: none;
}
.agent-plan__steps li {
  display: flex;
  gap: 6px;
  align-items: center;
}
.agent-plan__steps li.is-done {
  color: var(--qw-text-3);
  text-decoration: line-through;
}
.agent-plan__steps li.is-done .agent-plan__icon {
  color: var(--qw-success);
}
.agent-plan__steps li.is-doing .agent-plan__icon {
  color: var(--qw-brand-text);
}
.agent-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.agent-composer {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.agent-composer__box {
  position: relative;
}
.agent-composer__suggest {
  position: absolute;
  bottom: 100%;
  left: 0;
  z-index: 5;
  box-sizing: border-box;
  width: 100%;
  max-height: 240px;
  padding: 4px;
  margin: 0 0 4px;
  overflow: auto;
  list-style: none;
  background: var(--qw-surface);
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius-sm);
  box-shadow: var(--qw-shadow-2);
}
.agent-composer__suggest li {
  display: flex;
  gap: 12px;
  padding: 6px 8px;
  cursor: pointer;
  border-radius: var(--qw-radius-sm);
}
.agent-composer__suggest li.is-active {
  background: var(--qw-brand-weak);
}
.agent-composer__label {
  font-weight: 500;
}
.agent-composer__hint {
  overflow: hidden;
  color: var(--qw-text-3);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-composer__bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.agent-composer__bar .el-button {
  margin: 0;
}
.agent-composer__model {
  width: 200px;
}
.agent-composer__reasoning,
.agent-composer__mode {
  width: 130px;
}
.agent-composer__spacer {
  flex: 1;
}
.qw-md {
  overflow-wrap: anywhere;
}
.qw-md > :first-child {
  margin-top: 0;
}
.qw-md > :last-child {
  margin-bottom: 0;
}
.qw-md p,
.qw-md ul,
.qw-md ol,
.qw-md pre,
.qw-md blockquote {
  margin: 0 0 8px;
}
.qw-md code {
  padding: 1px 4px;
  font-size: 12px;
  background: var(--qw-surface-2);
  border-radius: 4px;
}
.qw-md pre {
  padding: 8px;
  overflow: auto;
  background: var(--qw-surface-2);
  border-radius: var(--qw-radius-sm);
}
.qw-md pre code {
  padding: 0;
  background: none;
}
.qw-md blockquote {
  padding-left: 10px;
  color: var(--qw-text-2);
  border-left: 3px solid var(--qw-border);
}
.qw-md__table {
  overflow: auto;
}
.qw-md table {
  margin: 0 0 8px;
  font-size: 13px;
  border-collapse: collapse;
}
.qw-md th,
.qw-md td {
  padding: 4px 8px;
  text-align: left;
  border: 1px solid var(--qw-border);
}
.qw-md th {
  background: var(--qw-surface-2);
}
@media (max-width: 1100px) {
  .agent-threads {
    width: auto;
    max-height: 280px;
  }
}
</style>
