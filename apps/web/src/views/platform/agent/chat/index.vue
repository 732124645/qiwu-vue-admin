<script setup lang="ts">
import {
  computed,
  h,
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
import {
  useDebounceFn,
  useEventListener,
  useElementSize,
  useMediaQuery,
  useWindowSize,
} from '@vueuse/core'
import { ElMessage, ElMessageBox } from 'element-plus'
import dayjs from 'dayjs'
import {
  agentPerms,
  Err,
  RT,
  type AgentContext,
  type AgentThreadCreate,
  type AgentItemVo,
  type AgentOptionsVo,
  type AgentPlanDecide,
  type AgentProfileVo,
  type AgentRewindPreviewVo,
  type AgentStatusVo,
  type AgentThreadVo,
  type AgentTurnVo,
} from '@qiwu/shared'
import { agentApi } from '@/api/platform/agent'
import IconButton from '@/core/components/IconButton.vue'
import { toastRest } from '@/core/composables/use-crud'
import { Icon } from '@/core/icons'
import { usePerm } from '@/core/permission'
import { onRealtime, realtimeStatus } from '@/core/realtime/socket'
import { ApiError, saveBlob } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import ChatItem from './ChatItem.vue'
import ContextPanel from './ContextPanel.vue'
import SubtaskDetail from './SubtaskDetail.vue'
import Composer, {
  type ComposerMessage,
  type ComposerSettings,
  type RestoredMessage,
} from './Composer.vue'
import NotifySettings from './NotifySettings.vue'
import ProfileMemoryBar, { type ProfileDraft } from './ProfileMemoryBar.vue'
import ShortcutSettings from './ShortcutSettings.vue'
import { comboLabel, comboOf, loadShortcuts, saveShortcuts } from './shortcuts'
import { LIST_WIDTH, loadLayout, PANEL_WIDTH, panelMax, saveLayout, usePaneResize } from './layout'
import ThreadList from './ThreadList.vue'
import {
  applyItemEvent,
  catchUpSeq,
  chatRows,
  mergeItems,
  mergeTurn,
  mergeThread,
  loadDelivery,
  saveDelivery,
  clearHistory,
  togglePlanMode,
  type PendingDeliveryIds,
  type SlashCommand,
} from './thread-state'
import { pendingContext, pendingRoute } from './use-agent-context'
import { toolTitle } from '../tool-presentation'

/**
 * “智能助手”对话页（整页的对话应用）：左侧会话列表 | 对话区 | 右侧面板，两条分隔线可拖动或用方向键调宽，
 * 会话列表可收起成窄条，右侧面板（工作面板、子任务详情、报告）可在主区域打开；专注模式隐藏系统菜单与标签页。
 * 宽度、收起与专注状态按本人本浏览器保存（layout.ts）。
 * 打开会话时从接口读全部条目，之后靠 `agent:event` 实时更新（新增 / 替换条目、增量文本、轮次状态）；
 * 断线重连、页面重新显示或漏了事件时用 `afterSeq` 从接口补齐。所有接口只作用于本人的会话；
 * 地址里的 `?shared=<token>` 显示同租户的只读分享快照。其他会话的推送更新列表（未读数、轮次状态，
 * 未列出的会话会重读列表）。快捷键（新会话、聚焦输入框、停止、切换计划模式）可在头部自定义，本人本浏览器
 * 保存；默认 Alt+N 新会话（不与全局菜单搜索的 Ctrl/⌘+K 冲突，也不占用浏览器的查找）。会话可在新窗口打开。
 * 运行中 Enter 插话、“排到下一轮”留到下一轮、停止键停止并保留草稿（撤下的排队消息放回输入框）。
 * 原地回退：任一条本人消息上“从这里重新编辑”、最后一条回答上“重新生成”、菜单“撤回最后一轮”都先读服务器
 * 列出的、不会撤销的写入并确认，再删掉这条消息及其后的内容；分叉是另一个单独的操作。
 */
// keep-alive 名称 = 菜单种子的 component_name
defineOptions({ name: 'AgentChat' })
const props = withDefaults(
  defineProps<{
    embedded?: boolean
    active?: boolean
    entryContext?: AgentContext | null
    entryRoute?: string | null
  }>(),
  { embedded: false, active: true, entryContext: null, entryRoute: null },
)
const host = ref<HTMLElement>()
const { width: hostWidth } = useElementSize(host)
const { width: viewportWidth } = useWindowSize()
const smallPanelViewport = useMediaQuery('(max-width: 1279px)')
/** 只有嵌入的助手窗口在宽度不够时把右侧面板放进抽屉；整页按 PC 宽度设计，面板总在行内、可拖宽。 */
const panelNarrow = computed(
  () => props.embedded && (hostWidth.value > 0 ? hostWidth.value < 900 : smallPanelViewport.value),
)
const childId = ref<number | null>(null)

// ---- 布局：宽度、列表收起与专注模式（本人本浏览器；嵌入窗口不读也不改） ----
const layoutUser = useAuthStore().me?.user.id ?? 0
const layout = ref(loadLayout(layoutUser))
const historyOpen = ref(props.embedded ? false : !layout.value.listCollapsed)
watch(historyOpen, (open) => {
  if (!props.embedded) layout.value.listCollapsed = !open
})
/** 分隔线本身的宽度，以及会话列表收起后窄条（含右侧间距）的宽度 */
const SPLITTER = 12
const RAIL = 56
const list = usePaneResize(
  computed({ get: () => layout.value.list, set: (v) => (layout.value.list = v) }),
  { min: LIST_WIDTH.min, max: () => LIST_WIDTH.max, fallback: LIST_WIDTH.fallback, direction: 1 },
)
const panel = usePaneResize(
  computed({ get: () => layout.value.panel, set: (v) => (layout.value.panel = v) }),
  {
    min: PANEL_WIDTH.min,
    max: () =>
      panelMax(
        viewportWidth.value,
        hostWidth.value,
        (props.embedded
          ? historyOpen.value
            ? 248
            : 0
          : historyOpen.value
            ? list.value.value + SPLITTER
            : RAIL) + SPLITTER,
      ),
    fallback: PANEL_WIDTH.fallback,
    direction: -1,
  },
)
const listSplitter = list.attrs
const panelSplitter = panel.attrs
const listDragging = list.dragging
const panelDragging = panel.dragging
// 拖动中每次指针移动都会改宽度：只在拖动结束后写一次 localStorage，不在拖动途中反复同步写盘
watch(
  [layout, () => listDragging.value || panelDragging.value],
  ([l, dragging]) => {
    if (!dragging) saveLayout(layoutUser, l)
  },
  { deep: true },
)
const listWidth = list.value
const panelWidth = panel.value

/** 专注模式：对话工作台盖住系统侧栏与标签页（布局没有现成的“内容区最大化”，浏览器全屏另在系统头部）。 */
const focusMode = computed({
  get: () => !props.embedded && layout.value.focus,
  set: (on: boolean) => {
    if (!props.embedded) layout.value.focus = on
  },
})
/** 头部“会话设置”弹层是否打开、当前页签；只读快照只有“快捷键”一页 */
const settingsOpen = ref(false)
const settingsTab = ref<'session' | 'notify' | 'shortcuts'>('session')

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
let optionsRequest = 0
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
  }
}
/** 只接收最新草稿来源的选项；慢响应不能覆盖用户已选的模型、审批模式或方案。 */
async function loadOptions(route?: string) {
  const mine = ++optionsRequest
  const selection = settings.value
  try {
    const next = await agentApi.options(route)
    if (mine !== optionsRequest) return
    options.value = next
    if (!thread.value && settings.value === selection) settings.value = defaultSettings()
  } catch (e) {
    if (mine === optionsRequest) toastRest(e)
  }
}

/** 子任务只从当前已授权卡片选取，打开详情不切换主会话。 */
function inspectChild(id: number) {
  if (
    loadingThread.value ||
    readOnly.value ||
    !thread.value ||
    !items.value.some(
      (item) => item.kind === 'subagent' && item.payload.tasks.some((task) => task.threadId === id),
    )
  )
    return
  childId.value = id
  inspectedId.value = null
  panelOpen.value = true
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
const panelOpen = ref(false)
/** 右侧面板改在主区域（对话区的位置）显示；关闭面板后回到侧栏 */
const panelInMain = ref(false)
const panelScope = ref(0)
const inspectedId = ref<number | null>(null)
const panelItems = computed(() => (loadingThread.value ? [] : items.value))
/** 换会话时卸载旧预览；等待新应答期间不显示上一会话的来源或产物。 */
function resetPanel() {
  childId.value = null
  inspectedId.value = null
  panelScope.value++
}
/** 仅打开当前已加载并获准查看的正文，忽略旧组件或无效ID传来的事件。 */
function inspectItem(id: number) {
  if (
    loadingThread.value ||
    !items.value.some(
      (item) => item.id === id && (item.kind === 'assistant' || item.kind === 'report'),
    )
  )
    return
  childId.value = null
  inspectedId.value = id
  panelScope.value++
  panelOpen.value = true
}

/** 新会话草稿的配置方案（undefined：默认方案）与是否使用记忆 */
const draft = ref<ProfileDraft>({ profileId: undefined, memoryEnabled: true })
/** 只读分享快照的 token */
const sharedToken = ref<string | null>(null)
const readOnly = computed(() => !!sharedToken.value || thread.value?.parentThreadId != null)
const loadingThread = ref(false)
const showStatus = ref(false)
const stopping = ref(false)
const rows = computed(() => chatRows(items.value, turn.value))
const running = computed(() => turn.value?.status === 'running' || turn.value?.status === 'waiting')
type UserItem = Extract<AgentItemVo, { kind: 'user' }>
/**
 * 最后一轮的第一条已送达用户消息（没有状态；排队中或已作废的不算，服务器也只从已送达的消息回退）。
 * 一轮中途插的话、待确认时附的理由也是同一轮里已送达的消息；从它们回退只会截短这一轮，
 * 所以重新生成与“撤回最后一轮”从这一轮的开头回退，删掉整轮，与确认文案和服务器的撤回一致。
 */
const lastTurnStart = computed(() => {
  const delivered = items.value.filter((i): i is UserItem => i.kind === 'user' && i.status === null)
  const last = delivered.at(-1)
  if (!last || last.turnId == null) return last ?? null
  return delivered.find((i) => i.turnId === last.turnId) ?? last
})
/** 最后一轮开头之后的最后一条完整回答：“重新生成”按钮在它上面 */
const lastAnswerId = computed(() => {
  const from = lastTurnStart.value
  if (!from || from.payload.fromPlan) return null
  const answer = items.value.filter((i) => i.kind === 'assistant').at(-1)
  return answer && answer.seq > from.seq && answer.status !== 'running' ? answer.id : null
})
/** 可 `@` 提及的记录：草稿带来的上下文，或会话第一条消息带着的上下文 */
const records = computed(() => {
  let ctx = context.value
  for (const i of items.value) if (!ctx && i.kind === 'user') ctx = i.payload.context ?? null
  const target = ctx?.target
  return target ? (ctx!.ids ?? []).map((id) => ({ target, id })) : []
})
/** 本轮停在待确认的操作上：输入框提示发送即拒绝它们并把这句话告诉助手 */
const awaitingApproval = computed(
  () =>
    turn.value?.status === 'waiting' &&
    items.value.some((i) => i.kind === 'approval' && i.status === 'pending'),
)
/** 本会话已放行（不再询问）的工具，按工具标题显示 */
const allowedTools = computed(() => thread.value?.allowedTools ?? [])
const revokingTool = ref<string | null>(null)
/** 撤销一个工具的本会话放行，之后它的每次写入重新询问；完成后以服务端的会话为准。 */
async function revokeTool(tool: string) {
  const th = thread.value
  if (!th || revokingTool.value) return
  revokingTool.value = tool
  try {
    const next = await agentApi.revokeAllowedTool(th.id, tool)
    onThreadUpdated(next)
  } catch (e) {
    toastRest(e)
  } finally {
    revokingTool.value = null
  }
}
/** 本会话的 `/status` 结果；换会话后旧会话的不算 */
const ownStatus = computed(() =>
  status.value && thread.value && status.value.threadId === thread.value.id ? status.value : null,
)
/** 输入框的上下文估算条；有上一步实际用量时状态行已显示实际值，不再并排显示另一个估算百分比 */
const contextUse = computed(() =>
  ownStatus.value && ownStatus.value.contextReported == null
    ? { used: ownStatus.value.contextUsed, window: ownStatus.value.contextWindow }
    : null,
)
/**
 * 输入框下方常显的状态行：模式 · 上下文（有上一步实际用量时用实际值，否则标“约”的估算）· 本轮积分（随轮次事件
 * 实时变化，有每轮上限时带上限）· 本人今日积分 · 本会话已放行数。还不知道的部分不显示，不用 0 充数。
 */
const statusLine = computed(() => {
  if (readOnly.value) return null
  const s = ownStatus.value
  const parts = [t(`agent.chat.mode.${settings.value.approvalMode}`)]
  if (s && s.contextWindow > 0) {
    const used = s.contextReported ?? s.contextUsed
    const percent = Math.min(100, Math.round((used / s.contextWindow) * 100))
    parts.push(
      t(`agent.chat.statusLine.${s.contextReported != null ? 'context' : 'contextApprox'}`, {
        percent,
      }),
    )
  }
  const now = thread.value && turn.value?.threadId === thread.value.id ? turn.value : null
  if (now)
    parts.push(
      s?.turnLimit
        ? t('agent.chat.statusLine.turnOf', { credits: now.credits, limit: s.turnLimit })
        : t('agent.chat.statusLine.turn', { credits: now.credits }),
    )
  if (s) parts.push(t('agent.chat.statusLine.today', { credits: s.today.userCredits }))
  return { parts, allowed: s?.allowedTools.length ?? 0 }
})
/** 状态行的“已放行 N 个工具”：打开会话设置里的已放行列表，可逐个撤销 */
function openAllowed() {
  settingsTab.value = 'session'
  settingsOpen.value = true
}
let openSeq = 0
let catchUpRequest = 0
let statusRequest = 0
const auth = useAuthStore()
const actor = computed(() => (auth.me ? `${auth.me.user.id}:${auth.tenant?.id ?? 1}` : ''))
type Delivery = PendingDeliveryIds & {
  request?: ComposerMessage
  create?: Partial<AgentThreadCreate>
}
const pendingDelivery = shallowRef<Delivery | null>(null)
const checkingDelivery = ref(false)
const deliveryStored = ref(true)
const acknowledgingRecovery = ref(false)
let deliveryEpoch = 0
let clientDraftId: string = crypto.randomUUID()

/** 仅保存回执标识；原始待确认消息只在组件内存，刷新后不能自动重放。 */
function rememberDelivery(next: Delivery | null) {
  pendingDelivery.value = next
  if (actor.value) deliveryStored.value = saveDelivery(actor.value, next)
}

function sameDelivery(previous: ComposerMessage, next: ComposerMessage) {
  if (
    previous.draftRevision !== undefined &&
    next.draftRevision !== undefined &&
    previous.draftRevision !== next.draftRevision
  )
    return false
  const normalized = (value: ComposerMessage, fallback: ComposerMessage) =>
    JSON.stringify({
      text: value.text.trim(),
      skill: value.skill ?? fallback.skill ?? null,
      fileIds: value.fileIds ?? [],
      mode: value.mode ?? fallback.mode ?? 'steer',
    })
  return normalized(previous, previous) === normalized(next, previous)
}

/** 连接恢复只核对接收事实；任何 POST 重试仍须由用户再次点击发送。 */
async function reconcileDelivery(
  notify = false,
): Promise<'accepted' | 'removed' | 'missing' | 'unknown'> {
  const pending = pendingDelivery.value
  if (
    !pending ||
    checkingDelivery.value ||
    readOnly.value ||
    (!props.embedded && typeof route.query.shared === 'string')
  )
    return 'unknown'
  const owner = actor.value,
    epoch = deliveryEpoch,
    scope = openSeq
  const current = () =>
    owner === actor.value &&
    epoch === deliveryEpoch &&
    pendingDelivery.value?.clientMessageId === pending.clientMessageId
  checkingDelivery.value = true
  try {
    if (!pending.threadId) {
      const draftReceipt = await agentApi.draftReceipt(pending.clientDraftId)
      if (!current()) return 'unknown'
      if (draftReceipt.clientDraftId !== pending.clientDraftId) return 'unknown'
      if (draftReceipt.status === 'removed') {
        rememberDelivery(null)
        if (!thread.value) clientDraftId = crypto.randomUUID()
        composerRef.value?.acknowledge(pending.request)
        ElMessage.info(t('agent.chat.delivery.removed'))
        return 'removed'
      }
      pending.threadId = draftReceipt.threadId
      rememberDelivery({ ...pending })
    }
    const receipt = await agentApi.messageReceipt(pending.threadId!, pending.clientMessageId)
    if (!current()) return 'unknown'
    if (
      receipt.clientMessageId !== pending.clientMessageId ||
      receipt.threadId !== pending.threadId
    )
      return 'unknown'
    // 恢复新建会话时先取得当前轮次，不能把旧接受轮次当成排队消息现在所处的新轮次。
    const restored =
      receipt.status === 'accepted' &&
      !thread.value &&
      pending.request &&
      openSeq === scope &&
      composerRef.value?.matchesDraft(pending.request)
        ? await agentApi.items(receipt.threadId).catch(() => null)
        : null
    if (!current()) return 'unknown'
    rememberDelivery(null)
    if (receipt.status === 'removed') {
      if (!thread.value || thread.value.id === receipt.threadId)
        composerRef.value?.acknowledge(pending.request)
      if (thread.value?.id === receipt.threadId) {
        thread.value = null
        items.value = []
        turn.value = null
        status.value = null
        setQuery({})
      }
      if (!thread.value) clientDraftId = crypto.randomUUID()
      ElMessage.info(t('agent.chat.delivery.removed'))
      return 'removed'
    }
    const sameFrame = !thread.value || thread.value.id === receipt.threadId
    const untouched = sameFrame && (composerRef.value?.matchesDraft(pending.request) ?? false)
    if (sameFrame) composerRef.value?.acknowledge(pending.request)
    if (untouched && openSeq === scope) {
      if (!thread.value && restored?.thread.id === receipt.threadId) {
        thread.value = restored.thread
        items.value = restored.items
        settings.value = settingsOf(restored.thread)
        turn.value = restored.turn
        context.value = null
        setQuery({ thread: receipt.threadId })
        listRef.value?.upsert(restored.thread)
      }
      if (thread.value?.id === receipt.threadId) await catchUp()
    }
    if (!thread.value) clientDraftId = crypto.randomUUID()
    if (notify && owner === actor.value && epoch === deliveryEpoch)
      ElMessage.success(t('agent.chat.delivery.accepted'))
    return 'accepted'
  } catch (error) {
    if (!current()) return 'unknown'
    if (error instanceof ApiError && error.status === 404) {
      if (notify)
        ElMessage.warning(
          t(pending.request ? 'agent.chat.delivery.missing' : 'agent.chat.delivery.memoryLost'),
        )
      return 'missing'
    }
    if (notify) toastRest(error)
    return 'unknown'
  } finally {
    if (owner === actor.value && epoch === deliveryEpoch) checkingDelivery.value = false
  }
}

/** 放弃本地待确认标识不等于停止服务器任务，必须明确提示后才允许另发新消息。 */
async function discardDelivery(): Promise<boolean> {
  if (!pendingDelivery.value) return true
  const owner = actor.value,
    epoch = deliveryEpoch,
    id = pendingDelivery.value.clientMessageId
  try {
    await ElMessageBox.confirm(t('agent.chat.delivery.clearConfirm'), t('agent.chat.title'), {
      type: 'warning',
    })
  } catch {
    return false
  }
  if (
    owner !== actor.value ||
    epoch !== deliveryEpoch ||
    pendingDelivery.value?.clientMessageId !== id
  )
    return false
  deliveryEpoch++
  checkingDelivery.value = false
  rememberDelivery(null)
  if (!thread.value) clientDraftId = crypto.randomUUID()
  return true
}

/** 核对业务后仅解除当前风险代次；不续跑旧轮次、排队消息或自动化。 */
async function acknowledgeRecovery() {
  const target = thread.value
  if (!target?.recoveryRequired || acknowledgingRecovery.value) return
  const owner = actor.value,
    epoch = deliveryEpoch
  try {
    await ElMessageBox.confirm(t('agent.chat.recovery.confirm'), t('agent.chat.title'), {
      type: 'warning',
    })
  } catch {
    return
  }
  if (
    owner !== actor.value ||
    epoch !== deliveryEpoch ||
    thread.value?.id !== target.id ||
    (thread.value.recoveryRevision ?? 0) !== (target.recoveryRevision ?? 0)
  )
    return
  acknowledgingRecovery.value = true
  try {
    const next = await agentApi.acknowledgeRecovery(target.id, target.recoveryRevision ?? 0)
    if (
      owner !== actor.value ||
      epoch !== deliveryEpoch ||
      thread.value?.id !== target.id ||
      (thread.value.recoveryRevision ?? 0) !== (target.recoveryRevision ?? 0)
    )
      return
    catchUpRequest++
    thread.value = next
    listRef.value?.upsert(next)
  } catch (error) {
    if (owner === actor.value && epoch === deliveryEpoch) toastRest(error)
  } finally {
    if (owner === actor.value && epoch === deliveryEpoch) acknowledgingRecovery.value = false
  }
}

watch(
  actor,
  (next, previous) => {
    deliveryEpoch++
    if (previous && previous !== next) {
      saveDelivery(previous, null)
      clearHistory()
      optionsRequest++
      openSeq++
      thread.value = null
      items.value = []
      turn.value = null
      options.value = null
      context.value = null
      resetPanel()
      composerRef.value?.resetDraft()
      if (next && props.active)
        void loadOptions(props.embedded ? (props.entryRoute ?? undefined) : undefined)
    }
    const saved = next ? loadDelivery(next) : null
    pendingDelivery.value = saved
    deliveryStored.value = true
    clientDraftId = saved?.clientDraftId ?? crypto.randomUUID()
    checkingDelivery.value = false
    acknowledgingRecovery.value = false
  },
  { immediate: true, flush: 'sync' },
)

const settingsOf = (th: AgentThreadVo): ComposerSettings => ({
  providerId: th.providerId,
  model: th.model,
  reasoning: th.reasoning,
  approvalMode: th.approvalMode,
})
function setQuery(p: { thread?: number; shared?: string }) {
  if (props.embedded) return
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
  resetPanel()
  leaveTemporary(id)
  const mine = ++openSeq
  const beforeItems = new Set(thread.value?.id === id ? items.value : [])
  const beforeTurn = thread.value?.id === id ? turn.value : null
  loadingThread.value = true
  try {
    const d = await agentApi.items(id)
    if (mine !== openSeq) return
    const sameThread = thread.value?.id === d.thread.id
    const incomingIds = new Set(d.items.map((item) => item.id))
    // 全量快照中的删除仍生效，只保留请求期间的新事件，以及快照里条目的较新本地版本。
    const shown = sameThread
      ? items.value.filter((item) => incomingIds.has(item.id) || !beforeItems.has(item))
      : []
    thread.value = mergeThread(thread.value, d.thread)
    items.value = mergeItems(shown, d.items)
    if (
      !sameThread ||
      turn.value === beforeTurn ||
      (d.turn && (!turn.value || d.turn.id > turn.value.id))
    )
      turn.value = mergeTurn(sameThread ? turn.value : null, d.turn)
    context.value = null
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
  resetPanel()
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
async function newDraft(
  ctx: AgentContext | null = props.embedded ? props.entryContext : null,
  from: string | null = props.embedded ? props.entryRoute : null,
) {
  if (!(await discardDelivery())) return
  clientDraftId = crypto.randomUUID()
  if (props.embedded) historyOpen.value = false
  resetPanel()
  leaveTemporary(null)
  openSeq++
  loadingThread.value = false
  thread.value = null
  items.value = []
  turn.value = null
  status.value = null
  context.value = ctx
  sharedToken.value = null
  settings.value = defaultSettings()
  void loadOptions(from ?? undefined)
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
  if (!th || !pageActive) return
  const request = ++catchUpRequest,
    scope = openSeq,
    previousTurn = turn.value
  try {
    const d = await agentApi.items(th.id, catchUpSeq(items.value, turn.value))
    if (thread.value?.id !== th.id || openSeq !== scope || request !== catchUpRequest) return
    items.value = mergeItems(items.value, d.items)
    if (turn.value === previousTurn || (d.turn && (!turn.value || d.turn.id > turn.value.id)))
      turn.value = mergeTurn(turn.value, d.turn)
    thread.value = mergeThread(thread.value, d.thread)
    markRead()
  } catch (e) {
    toastRest(e)
  }
}

/**
 * 上下文用量、本轮与今日用量和限额（输入框旁的用量条与 `/status`）。只采用最后一次请求的回复：先发的
 * 回复（如运行中节流的刷新）晚到时不覆盖已显示的较新状态。
 */
async function loadStatus() {
  const th = thread.value
  if (!th) return
  statusAt = Date.now()
  const request = ++statusRequest
  try {
    const s = await agentApi.status(th.id)
    if (thread.value?.id === th.id && request === statusRequest) status.value = s
  } catch {
    // 用量只是提示，读不到不打扰用户
  }
}

/** 运行中至多每 10 秒刷新一次状态（今日积分、上下文），不随每一步都请求 */
const RUNNING_STATUS_MS = 10_000
let statusAt = 0
function refreshRunningStatus() {
  if (Date.now() - statusAt >= RUNNING_STATUS_MS) void loadStatus()
}
// 同一会话的模式、配置方案或已放行工具变了：重读状态（需确认与不可用的工具、放行数随之变化）
watch(
  () =>
    [
      thread.value?.id,
      thread.value?.approvalMode,
      thread.value?.profileId,
      thread.value?.allowedTools.join('\n'),
    ] as const,
  (now, before) => {
    if (now[0] != null && now[0] === before[0]) void loadStatus()
  },
)

// ---- 已读：页面显示着会话时，把看到的最后一条标为已读 ----
let readSeq = 0
let pageActive = props.active
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
  if (!pageActive) return
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
    turn.value = mergeTurn(turn.value, ev.turn)
    if (ev.turn.status !== 'running') void loadStatus()
    else refreshRunningStatus()
    if (ev.turn.status !== 'running' && ev.turn.status !== 'waiting') void catchUp()
    return
  }
  // 别的标签页（或本页）原地回退：去掉被删的条目，再从接口补齐会话状态
  if (ev.type === 'rewound') return void dropFrom(ev.fromSeq)
  const next = applyItemEvent(items.value, ev)
  if (!next) return void catchUp()
  items.value = next
  if (ev.type === 'item') markRead()
})
// 断线期间的事件不会重发：重新连上后补齐当前会话并重读列表
watch(realtimeStatus, (now, before) => {
  if (!pageActive || now !== 'up' || before === 'up') return
  void catchUp()
  void reconcileDelivery()
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
async function createThread(delivery: Delivery) {
  // 点击发送即锁定当时的选择，尚未返回的草稿选项不能再替换它。
  optionsRequest++
  const s = settings.value
  const d = draft.value
  const input = delivery.create ?? {
    clientDraftId: delivery.clientDraftId,
    approvalMode: s.approvalMode,
    // undefined：服务端取本人的默认方案；null：明确不用方案
    ...(d.profileId !== undefined ? { profileId: d.profileId } : {}),
    // 记忆默认开，只在关掉时才带上（临时会话不读不写记忆）
    ...(temporary.value ? { temporary: true } : d.memoryEnabled ? {} : { memoryEnabled: false }),
    ...(s.providerId != null && s.model ? { providerId: s.providerId, model: s.model } : {}),
    ...(s.reasoning ? { reasoning: s.reasoning } : {}),
    ...(context.value ? { context: context.value } : {}),
  }
  if (!delivery.create)
    delivery.create = JSON.parse(JSON.stringify(input)) as Partial<AgentThreadCreate>
  const th = await agentApi.createThread(delivery.create)
  return th
}

/** 草稿选了配置方案：输入框换成方案的模型、推理强度与审批模式（平台此刻提供的）；不用方案回到默认。 */
function applyProfile(p: AgentProfileVo | null) {
  const base = defaultSettings()
  const modes = options.value?.approvalModes ?? []
  settings.value = {
    ...base,
    ...(p?.providerId != null && p.model ? { providerId: p.providerId, model: p.model } : {}),
    reasoning: p?.reasoning ?? null,
    ...(p && modes.includes(p.approvalMode) ? { approvalMode: p.approvalMode } : {}),
  }
}

/** 会话的记忆开关已保存：换上服务端返回的会话。 */
function onThreadUpdated(next: AgentThreadVo) {
  if (thread.value?.id !== next.id) return
  thread.value = mergeThread(thread.value, next)
  listRef.value?.upsert(next)
}

/**
 * 发送一条消息：没有会话时先创建。运行中按输入框给的方式送达：插话（本轮当前工具步骤之后）或排到下一轮。
 */
async function submit(msg: ComposerMessage): Promise<boolean> {
  const owner = actor.value,
    epoch = deliveryEpoch
  let delivery = pendingDelivery.value
  if (delivery) {
    const outcome = await reconcileDelivery()
    if (owner !== actor.value || epoch !== deliveryEpoch) return false
    if (outcome === 'accepted' || outcome === 'removed') {
      // 本次点击只确认原意图；用户后写的新草稿必须再次明确点击才能成为另一条消息。
      return (
        (!thread.value || thread.value.id === delivery.threadId) &&
        !!delivery.request &&
        sameDelivery(delivery.request, msg)
      )
    } else if (outcome !== 'missing') return false
    else if (
      !delivery.request ||
      !sameDelivery(delivery.request, msg) ||
      (thread.value && delivery.threadId && thread.value.id !== delivery.threadId)
    ) {
      ElMessage.warning(t('agent.chat.delivery.different'))
      return false
    }
  }
  const fresh = !delivery
  if (!delivery) {
    delivery = {
      clientDraftId,
      clientMessageId: crypto.randomUUID(),
      threadId: thread.value?.id ?? null,
      request: structuredClone(msg),
    }
    rememberDelivery(delivery)
  }
  const selected = delivery
  const current = () =>
    owner === actor.value &&
    epoch === deliveryEpoch &&
    pendingDelivery.value?.clientMessageId === selected.clientMessageId
  const scope = openSeq
  try {
    let th = thread.value
    if (!th || (selected.threadId && th.id !== selected.threadId)) {
      if (selected.threadId) {
        const receipt = await agentApi.draftReceipt(selected.clientDraftId)
        if (receipt.status === 'removed' || !receipt.thread)
          throw new Error(t('agent.chat.delivery.removed'))
        th = receipt.thread
      } else th = await createThread(selected)
    }
    if (!current()) return false
    selected.threadId = th.id
    rememberDelivery({ ...selected })
    if (th.id !== thread.value?.id && openSeq === scope) {
      context.value = null
      temporary.value = false
      openSeq++
      thread.value = th
      items.value = []
      turn.value = null
      readSeq = 0
      listRef.value?.upsert(th)
      setQuery({ thread: th.id })
    }
    const payload = { ...selected.request! }
    delete payload.draftRevision
    const result = await agentApi.send(th.id, {
      ...payload,
      clientMessageId: selected.clientMessageId,
    })
    if (!current()) return false
    rememberDelivery(null)
    if (thread.value?.id === th.id) {
      turn.value = mergeTurn(turn.value, result)
      follow.value = true
      await catchUp()
      void loadStatus()
    }
    return thread.value?.id === th.id
  } catch (e) {
    if (!current()) return false
    const outcome = await reconcileDelivery()
    if (owner !== actor.value || epoch !== deliveryEpoch) return false
    if (outcome === 'accepted' || outcome === 'removed')
      return !thread.value || thread.value.id === selected.threadId
    // 首次请求明确被业务拒绝时保留输入供修正；旧的未知尝试与短防重 429 仍必须继续核对。
    if (fresh && e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429) {
      rememberDelivery(null)
      if (!thread.value) clientDraftId = crypto.randomUUID()
    }
    toastRest(e)
    return false
  }
}

/**
 * 停止本轮（等待中的卡片随之作废），输入框里的草稿不动；服务器撤下的排队消息不会再开始，原文、附件和技能
 * 接回输入框，由本人决定是否再发。
 */
async function stop() {
  const th = thread.value
  if (!th || stopping.value) return
  const owner = actor.value
  stopping.value = true
  try {
    const res = await agentApi.cancel(th.id)
    // 撤下的排队消息已在服务器删除，不会再推送：本地也去掉
    if (thread.value?.id === th.id)
      items.value = items.value.filter(
        (i) => !(i.kind === 'user' && i.turnId === null && i.status === 'pending'),
      )
    const queued = res?.queued ?? []
    // 切到别的会话也放回：输入框在会话之间共用，丢掉就找不回了；换了登录身份则不放
    if (queued.length && owner === actor.value) {
      await composerRef.value?.restore(queued)
      ElMessage.info(t('agent.chat.composer.restoredQueued', { n: queued.length }))
    }
    await catchUp()
  } catch (e) {
    toastRest(e)
  } finally {
    stopping.value = false
  }
}

/**
 * 会话模式以服务器为准：批准方案、别的标签页或嵌入式助手改了模式后，补齐带回的新模式同步到输入框。
 * 输入框此前与服务器一致（没有尚未保存的本地改动）才跟随，避免之后换模型时把过期的模式存回去；
 * 不依赖某一次补齐，因为较早的补齐可能被较新的一次取代而丢弃。
 */
watch(
  () => [thread.value?.id, thread.value?.approvalMode] as const,
  ([id, mode], [oldId, oldMode]) => {
    if (id == null || id !== oldId || !mode || mode === oldMode) return
    if (settings.value.approvalMode === oldMode)
      settings.value = { ...settings.value, approvalMode: mode }
  },
)

// 已有会话时，换模型、推理强度或会话模式立即保存到会话上
watch(settings, async (s) => {
  const th = thread.value
  if (!th || readOnly.value) return
  const now = settingsOf(th)
  if (JSON.stringify(now) === JSON.stringify(s)) return
  try {
    const next = await agentApi.updateThread(th.id, {
      ...(s.providerId != null && s.model ? { providerId: s.providerId, model: s.model } : {}),
      reasoning: s.reasoning,
      approvalMode: s.approvalMode,
    })
    if (thread.value?.id !== th.id) return
    thread.value = mergeThread(thread.value, next)
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
  const owner = actor.value,
    epoch = deliveryEpoch,
    scope = openSeq
  try {
    const next = await agentApi.fork(th.id, seq, crypto.randomUUID())
    if (owner !== actor.value || epoch !== deliveryEpoch || scope !== openSeq) return
    listRef.value?.upsert(next)
    await openThread(next.id)
  } catch (e) {
    toastRest(e)
  }
}

// ---- 原地回退：从这里重新编辑、重新生成、撤回最后一轮 ----
/** 回退的用途：重新编辑把消息放回输入框，重新生成原样再发一次，撤回只删除 */
type RewindPurpose = 'edit' | 'regenerate' | 'revert'
const rewinding = ref(false)
/**
 * 此刻能否原地回退：本人可写的普通会话，没有正在运行的轮次、待核对的结果不明写入或未确认送达的消息；
 * 等人确认的轮次可以回退（服务器截短并取消它；外部表单的调用还在执行时服务器回 409，照常提示）。
 * 自动化、子任务和批量会话的轮次另有记录依赖它们，服务器也会拒绝。
 */
const canRewind = computed(() => {
  const th = thread.value
  return (
    !!th &&
    !readOnly.value &&
    turn.value?.status !== 'running' &&
    !th.recoveryRequired &&
    th.automationRunId == null &&
    th.parentThreadId == null &&
    th.batchId == null &&
    !pendingDelivery.value
  )
})

/** 去掉 `seq` 及其后的条目，再从接口补齐会话、最近一轮（可能是更早的一轮或没有）与用量。 */
async function dropFrom(seq: number) {
  items.value = items.value.filter((i) => i.seq < seq)
  // 被删的轮次可能正是当前轮：清掉后由补齐换成服务器的最近一轮，不让较早的一轮被当成迟到的旧状态
  turn.value = null
  await catchUp()
  void loadStatus()
}

/** 确认框正文：会删掉什么、这些轮次里不会撤销的写入（已执行或结果不明，按工具标题），以及其他不撤销的事。 */
function rewindMessage(purpose: RewindPurpose, writes: AgentRewindPreviewVo['writes']) {
  return h('div', { class: 'agent-chat__rewind' }, [
    h('p', t(`agent.chat.rewind.confirm.${purpose}`)),
    ...(writes.length
      ? [
          h('p', t('agent.chat.rewind.writes')),
          h(
            'ul',
            writes.map((w) =>
              h(
                'li',
                { key: w.seq },
                `${toolTitle(w.tool, w.title)} · ${t(`agent.chat.rewind.outcome.${w.outcome}`)}`,
              ),
            ),
          ),
        ]
      : []),
    h('p', t('agent.chat.rewind.notUndone')),
  ])
}

/**
 * 原地回退到本人的一条用户消息：先向服务器要这条之后不会撤销的写入并确认（重新生成在没有写入时不问），
 * 再带上本页见过的最大序号删除（别的窗口刚加了本页没看到的内容时服务器拒绝，页面重新载入并提示）。
 * 之后按用途把消息放回输入框（不发送）或用新的消息标识原样重发。
 */
async function rewindTo(target: UserItem, purpose: RewindPurpose) {
  const th = thread.value
  if (!th || !canRewind.value || rewinding.value) return
  const owner = actor.value,
    epoch = deliveryEpoch,
    scope = openSeq
  const same = () =>
    owner === actor.value &&
    epoch === deliveryEpoch &&
    scope === openSeq &&
    thread.value?.id === th.id
  const restorable = (u: UserItem): RestoredMessage => ({
    text: u.payload.text,
    ...(u.payload.skill && { skill: u.payload.skill }),
    attachments: u.payload.attachments ?? [],
  })
  const message = restorable(target)
  rewinding.value = true
  try {
    const { writes } = await agentApi.rewindPreview(th.id, target.seq)
    if (!same()) return
    if (purpose !== 'regenerate' || writes.length) {
      const verb = { edit: 'action.edit', regenerate: 'action.regenerate', revert: 'revert.title' }
      try {
        await ElMessageBox.confirm(
          rewindMessage(purpose, writes),
          t(`agent.chat.${verb[purpose]}`),
          {
            type: 'warning',
            confirmButtonText: t(`agent.chat.rewind.continue.${purpose}`),
            cancelButtonText: t('common.action.cancel'),
          },
        )
      } catch {
        return
      }
      if (!same()) return
    }
    const lastSeq = items.value.reduce((max, i) => Math.max(max, i.seq), 0)
    // 锚点之后排队的消息（等人确认时排到下一轮的）随回退一起删掉：像停止一样把原文接回输入框，
    // 不让打好的文字无声丢失；带上本页见过的最大序号，服务器删的不会多于这些
    const queued = items.value
      .filter(
        (i): i is UserItem =>
          i.kind === 'user' && i.turnId === null && i.status === 'pending' && i.seq > target.seq,
      )
      .map(restorable)
    const putBack = async (own: RestoredMessage[]) => {
      if (owner !== actor.value) return
      await composerRef.value?.restore([...own, ...queued])
      if (queued.length)
        ElMessage.info(t('agent.chat.composer.restoredQueued', { n: queued.length }))
    }
    await agentApi.rewind(th.id, target.seq, lastSeq)
    if (!same()) {
      // 等回应时切走了会话：服务器已删掉原文，输入框在会话之间共用，放回去免得找不回（重新生成也不在别处重发）
      await putBack(purpose !== 'revert' ? [message] : [])
      return
    }
    await dropFrom(target.seq)
    await putBack(purpose === 'edit' ? [message] : [])
    if (purpose !== 'regenerate' || !same()) return
    // 原样重发是一条新消息（新的消息标识）；没能送出时放回输入框，不让被删的原文就此丢失
    const sent = await submit({
      text: message.text,
      ...(message.skill && { skill: message.skill }),
      ...(message.attachments?.length && { fileIds: message.attachments.map((a) => a.fileId) }),
    })
    if (!sent && owner === actor.value) await composerRef.value?.restore([message])
  } catch (e) {
    if (!same()) return
    if (e instanceof ApiError && e.code === Err.AGENT_THREAD_STALE.code) {
      ElMessage.warning(t('agent.chat.rewind.stale'))
      await openThread(th.id)
    } else {
      toastRest(e)
      // 这条消息或会话已不在（别的窗口删了）：重新载入
      if (e instanceof ApiError && e.status === 404) await openThread(th.id)
    }
  } finally {
    rewinding.value = false
  }
}

/** “从这里重新编辑”：回退到这条消息，把原文、附件和技能放回输入框。 */
function editFrom(seq: number) {
  const target = items.value.find((i): i is UserItem => i.kind === 'user' && i.seq === seq)
  if (target) void rewindTo(target, 'edit')
}
/** “重新生成”：回退到最后一轮的开头，再把这一轮的第一条消息原样发一次。 */
function regenerate() {
  if (lastTurnStart.value) void rewindTo(lastTurnStart.value, 'regenerate')
}

// ---- 会话菜单：撤回、导出、分享 ----
/** 撤回最后一轮：与原地回退同一流程，从最后一轮的第一条已送达消息删起，不放回输入框。 */
async function revert() {
  if (lastTurnStart.value) await rewindTo(lastTurnStart.value, 'revert')
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

type ThreadCommand = 'window' | 'revert' | 'export' | 'share' | 'unshare' | 'skill'
function onThreadCommand(cmd: ThreadCommand) {
  if (cmd === 'window') return openInWindow()
  const run = { revert, export: exportMarkdown, share, unshare, skill: saveAsSkill }[cmd]
  void run()
}

/**
 * 方案卡决定之后补齐条目与会话：批准时服务器已切换会话模式并开始执行，输入框的模式由上面跟随服务器的
 * 监听同步（与会话一致，不会再触发保存）；继续完善时模式不变。
 */
async function onPlanDecided(decision: AgentPlanDecide['decision']) {
  const th = thread.value
  await catchUp()
  if (decision === 'refine' || !thread.value || thread.value.id !== th?.id) return
  listRef.value?.upsert(thread.value)
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
    case 'status': {
      showStatus.value = true
      await loadStatus()
      await nextTick()
      // 状态卡与消息共用滚动区，先展示本轮积分，不把输入框顶出工作区。
      const stream = streamRef.value
      const card = stream?.querySelector<HTMLElement>('.agent-chat__status')
      if (stream && card)
        stream.scrollTop += card.getBoundingClientRect().top - stream.getBoundingClientRect().top
      return
    }
  }
}

// ---- 快捷键：本人在本浏览器自定义（默认 Alt+N 新会话）；只在本页显示时；按物理键判断，mac 的 ⌥ 会改变 e.key ----
const shortcuts = ref(loadShortcuts(layoutUser))
watch(shortcuts, (m) => saveShortcuts(layoutUser, m))
/** 输入框里的停止键：嵌入窗口的 Esc 用来收起窗口，此时只能点按钮或用带修饰键的快捷键 */
const stopKey = computed(() =>
  props.embedded && shortcuts.value.stop === 'Escape' ? '' : shortcuts.value.stop,
)
/** 运行中提示里的停止方式：停止键，或没有停止键时的“停止”按钮（带引号的按钮名，免得读成“停止 停止本轮”） */
const stopLabel = computed(() =>
  stopKey.value ? comboLabel(stopKey.value) : t('agent.chat.composer.stopButton'),
)
useEventListener(window, 'keydown', (e: KeyboardEvent) => {
  if (!pageActive || e.defaultPrevented) return
  // 专注模式下 Esc 退出；焦点在弹层、对话框等页面外的浮层里时由它们自己处理 Esc
  if (e.key === 'Escape' && focusMode.value && !settingsOpen.value) {
    const target = e.target as Node | null
    if (!target || target === document.body || host.value?.contains(target)) {
      focusMode.value = false
      e.preventDefault()
      return
    }
  }
  const combo = comboOf(e)
  const map = shortcuts.value
  if (!combo) return
  if (combo === map.newChat) newDraft()
  else if (combo === map.focusComposer) composerRef.value?.focus()
  else if (combo === map.togglePlan && !readOnly.value)
    settings.value = {
      ...settings.value,
      approvalMode: togglePlanMode(settings.value.approvalMode, options.value?.approvalModes ?? []),
    }
  else return
  e.preventDefault()
})

/** 在新窗口打开当前会话（地址带 `?thread=<id>`，新窗口打开时直接载入它）。 */
function openInWindow() {
  const th = thread.value
  if (!th) return
  window.open(
    router.resolve({ name: 'agent-chat', query: { thread: th.id } }).href,
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
  const from = pendingRoute.value
  pendingRoute.value = null
  newDraft(ctx, from)
  return true
}
/** 地址中的会话编号只接受单个安全正整数；不把数组或截断后的字符串当成目标。 */
function queryThreadId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

// 同一路由的通知入口不会重建页面；沿用打开会话流程，保留未发送文字和待核对的原投递标识。
watch(
  () => [route.name, route.query.thread, route.query.shared],
  () => {
    if (props.embedded || route.name !== 'agent-chat') return
    const shared = route.query.shared
    if (typeof shared === 'string' && shared) {
      if (shared !== sharedToken.value) void openShared(shared)
      return
    }
    const id = queryThreadId(route.query.thread)
    // 页面自己的 setQuery 已先应用会话，不能再发起一次同目标读取。
    if (id !== null && id !== thread.value?.id) void openThread(id)
  },
)
onMounted(() => {
  if (props.embedded) return
  if (takeContext()) return
  void loadOptions()
  const shared = route.query.shared
  const id = queryThreadId(route.query.thread)
  if (typeof shared === 'string' && shared) void openShared(shared)
  else if (id !== null) void openThread(id)
})
onActivated(() => {
  pageActive = props.active
  if (props.embedded) return
  if (!takeContext()) void catchUp()
})
onDeactivated(() => {
  pageActive = false
  panelOpen.value = false
  resetPanel()
})

watch(
  () => props.active,
  (active) => {
    pageActive = active
    if (!active) {
      panelOpen.value = false
      resetPanel()
      return
    }
    if (props.embedded) {
      if (!options.value) {
        context.value = props.entryContext
        void loadOptions(props.entryRoute ?? undefined)
      }
      void catchUp()
      listRef.value?.refresh()
    }
    void reconcileDelivery()
  },
  { immediate: true },
)

watch(panelOpen, (open) => {
  if (open) return
  childId.value = null
  panelInMain.value = false
})
/** 主区域里显示的面板在面包屑上的名字 */
const panelTitle = computed(() =>
  t(childId.value ? 'agent.chat.subtask.details' : 'agent.chat.panel.open'),
)
const conversationTitle = computed(() =>
  sharedToken.value ? sharedTitle.value : thread.value?.title || t('agent.chat.thread.new'),
)
const settingsPane = computed({
  get: () => (readOnly.value ? 'shortcuts' : settingsTab.value),
  set: (v: 'session' | 'notify' | 'shortcuts') => (settingsTab.value = v),
})

const time = (iso: string | null) => (iso ? dayjs(iso).format('YYYY-MM-DD HH:mm:ss') : '')
</script>

<template>
  <div
    ref="host"
    class="agent-chat qw-workspace"
    :class="{
      'agent-chat--embedded': props.embedded,
      'agent-chat--focus': focusMode,
      'agent-chat--dragging': listDragging || panelDragging,
    }"
  >
    <ThreadList
      v-show="historyOpen"
      id="agent-thread-list"
      ref="listRef"
      :style="props.embedded ? undefined : { width: `${listWidth}px` }"
      :active="props.active"
      :active-id="thread?.id ?? null"
      @open="
        (th) => {
          openThread(th.id)
          if (props.embedded) historyOpen = false
        }
      "
      @create="newDraft()"
      @gone="(id) => thread?.id === id && newDraft()"
    />
    <div
      v-if="!props.embedded && historyOpen"
      v-bind="listSplitter"
      class="agent-chat__splitter"
      :class="{ 'is-dragging': listDragging }"
      :aria-label="t('agent.chat.layout.resizeList')"
      aria-controls="agent-thread-list"
      :title="t('agent.chat.layout.resizeHint')"
    />
    <nav
      v-if="!props.embedded && !historyOpen"
      class="agent-chat__rail"
      :aria-label="t('agent.chat.thread.list')"
    >
      <IconButton
        icon="lucide:panel-left-open"
        :label="t('agent.chat.layout.expandList')"
        :aria-expanded="false"
        aria-controls="agent-thread-list"
        @click="historyOpen = true"
      />
      <IconButton icon="lucide:plus" :label="t('agent.chat.thread.new')" @click="newDraft()" />
    </nav>

    <section v-show="!panelInMain" class="agent-chat__main" :aria-label="t('agent.chat.title')">
      <header class="agent-chat__head">
        <IconButton
          v-if="props.embedded"
          icon="lucide:history"
          :label="t('agent.chat.thread.list')"
          :aria-expanded="historyOpen"
          @click="historyOpen = !historyOpen"
        />
        <IconButton
          v-else-if="historyOpen"
          icon="lucide:panel-left-close"
          :label="t('agent.chat.layout.collapseList')"
          :aria-expanded="true"
          aria-controls="agent-thread-list"
          @click="historyOpen = false"
        />
        <IconButton
          v-if="props.embedded"
          icon="lucide:plus"
          :label="t('agent.chat.thread.new')"
          @click="newDraft(props.entryContext)"
        />
        <el-button
          v-if="thread?.parentThreadId"
          size="small"
          @click="openThread(thread.parentThreadId)"
          >{{ t('agent.chat.subtask.back') }}</el-button
        >
        <h2 class="agent-chat__title">{{ conversationTitle }}</h2>
        <el-tag v-if="sharedToken" size="small" type="info">{{
          t('agent.chat.share.readonly')
        }}</el-tag>
        <el-tag v-else-if="!thread && temporary" size="small" type="warning">{{
          t('agent.chat.temporary')
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
        <el-button
          size="small"
          class="agent-chat__panel-toggle"
          :title="t('agent.chat.panel.open')"
          :type="panelOpen ? 'primary' : undefined"
          plain
          :aria-expanded="panelOpen"
          aria-controls="agent-work-panel"
          @click="panelOpen = !panelOpen"
        >
          <Icon icon="lucide:panel-right" class="agent-chat__btn-icon" />
          <span class="agent-chat__btn-text">{{ t('agent.chat.panel.open') }}</span></el-button
        >
        <el-button
          v-if="!props.embedded"
          size="small"
          class="agent-chat__focus-toggle"
          :aria-pressed="focusMode"
          :title="t('agent.chat.focus.hint')"
          @click="focusMode = !focusMode"
        >
          <Icon
            :icon="focusMode ? 'lucide:minimize-2' : 'lucide:maximize-2'"
            class="agent-chat__btn-icon"
          />
          <span class="agent-chat__btn-text">{{
            t(focusMode ? 'agent.chat.focus.exit' : 'agent.chat.focus.enter')
          }}</span></el-button
        >
        <el-popover
          v-model:visible="settingsOpen"
          trigger="click"
          placement="bottom-end"
          :width="380"
          :teleported="false"
          role="dialog"
          :aria-label="t('agent.chat.settings.open')"
          popper-class="agent-settings"
        >
          <template #reference>
            <el-button
              size="small"
              class="agent-chat__settings-toggle"
              :title="t('agent.chat.settings.open')"
            >
              <Icon icon="lucide:settings-2" class="agent-chat__btn-icon" />
              <span class="agent-chat__btn-text">{{
                t('agent.chat.settings.open')
              }}</span></el-button
            >
          </template>
          <div>
            <el-tabs v-model="settingsPane" class="agent-settings__tabs">
              <el-tab-pane
                v-if="!readOnly"
                name="session"
                :label="t('agent.chat.settings.session')"
              >
                <div v-if="!thread" class="agent-settings__row">
                  <span class="agent-settings__name">{{ t('agent.chat.temporary') }}</span>
                  <el-switch v-model="temporary" :aria-label="t('agent.chat.temporary')" />
                </div>
                <p v-if="!thread" class="agent-settings__hint">
                  {{ t('agent.chat.settings.temporaryHint') }}
                </p>
                <ProfileMemoryBar
                  v-model:draft="draft"
                  :thread="thread"
                  :options="options"
                  :temporary="temporary"
                  @apply="applyProfile"
                  @updated="onThreadUpdated"
                />
                <template v-if="thread">
                  <span class="agent-settings__name agent-settings__section">{{
                    t('agent.chat.settings.allowed')
                  }}</span>
                  <p v-if="!allowedTools.length" class="agent-settings__hint">
                    {{ t('agent.chat.settings.allowedEmpty') }}
                  </p>
                  <ul v-else class="agent-settings__allowed">
                    <li v-for="tool in allowedTools" :key="tool" class="agent-settings__row">
                      <span class="agent-settings__name" :title="tool">{{ toolTitle(tool) }}</span>
                      <el-button
                        size="small"
                        link
                        type="danger"
                        :loading="revokingTool === tool"
                        :disabled="revokingTool != null"
                        :aria-label="t('agent.chat.settings.revoke', { tool: toolTitle(tool) })"
                        @click="revokeTool(tool)"
                        >{{ t('agent.chat.settings.revokeShort') }}</el-button
                      >
                    </li>
                  </ul>
                </template>
              </el-tab-pane>
              <el-tab-pane v-if="!readOnly" name="notify" :label="t('agent.chat.notify.title')">
                <NotifySettings v-if="settingsOpen && settingsPane === 'notify'" />
              </el-tab-pane>
              <el-tab-pane name="shortcuts" :label="t('agent.chat.shortcut.title')">
                <ShortcutSettings
                  v-if="settingsOpen && settingsPane === 'shortcuts'"
                  v-model="shortcuts"
                  :escape-closes="props.embedded"
                />
              </el-tab-pane>
            </el-tabs>
          </div>
        </el-popover>
        <el-dropdown v-if="thread && !readOnly" trigger="click" @command="onThreadCommand">
          <IconButton icon="lucide:ellipsis-vertical" :label="t('agent.chat.thread.menu')" />
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item v-if="!thread.temporary" command="window">
                {{ t('agent.chat.newWindow') }}
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
              <el-dropdown-item
                command="revert"
                divided
                :disabled="!lastTurnStart || !canRewind || rewinding"
              >
                {{ t('agent.chat.revert.title') }}
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
        <el-alert
          v-if="!readOnly && realtimeStatus !== 'up'"
          type="warning"
          :closable="false"
          show-icon
          :title="
            t(
              realtimeStatus === 'reconnecting'
                ? 'agent.chat.connection.reconnecting'
                : 'agent.chat.connection.down',
            )
          "
        />
        <el-alert
          v-if="!readOnly && pendingDelivery"
          class="agent-chat__delivery"
          type="warning"
          :closable="false"
          show-icon
        >
          <template #title>{{ t('agent.chat.delivery.uncertain') }}</template>
          <p v-if="!pendingDelivery.request">{{ t('agent.chat.delivery.memoryLost') }}</p>
          <p v-if="!deliveryStored">{{ t('agent.chat.delivery.storageUnavailable') }}</p>
          <el-button
            size="small"
            :loading="checkingDelivery"
            :disabled="checkingDelivery"
            @click="reconcileDelivery(true)"
            >{{ t('agent.chat.delivery.check') }}</el-button
          >
          <el-button size="small" :disabled="checkingDelivery" @click="discardDelivery">{{
            t('agent.chat.delivery.clear')
          }}</el-button>
        </el-alert>
        <el-alert
          v-if="!readOnly && thread?.recoveryRequired"
          class="agent-chat__recovery"
          type="warning"
          :closable="false"
          show-icon
        >
          <template #title>{{ t('agent.chat.recovery.required') }}</template>
          <el-button
            size="small"
            :loading="acknowledgingRecovery"
            :disabled="acknowledgingRecovery"
            @click="acknowledgeRecovery"
            >{{ t('agent.chat.recovery.acknowledge') }}</el-button
          >
        </el-alert>
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
          :can-fork="!!thread && !readOnly && !running && !thread.recoveryRequired"
          :can-edit="
            canRewind && r.kind === 'item' && r.item.kind === 'user' && r.item.status === null
          "
          :can-regenerate="canRewind && r.kind === 'item' && r.item.id === lastAnswerId"
          :last="i === rows.length - 1 && !running"
          :readonly="readOnly"
          :auto-review="options?.approvalModes.includes('auto_review') ?? false"
          @fork="fork"
          @edit="editFrom"
          @regenerate="regenerate"
          @suggest="(s) => composerRef?.suggest(s)"
          @changed="catchUp"
          @plan-decided="onPlanDecided"
          @inspect="inspectItem"
          @inspect-child="inspectChild"
        />
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
            <dt>{{ t('agent.chat.status.mode') }}</dt>
            <dd>{{ t(`agent.chat.mode.${status.mode}`) }}</dd>
            <template v-if="status.model">
              <dt>{{ t('agent.chat.status.model') }}</dt>
              <dd>{{ status.model }}</dd>
            </template>
            <template v-if="status.profile">
              <dt>{{ t('agent.chat.status.profile') }}</dt>
              <dd>{{ status.profile.name }}</dd>
            </template>
            <template v-if="status.turn">
              <dt>{{ t('agent.chat.status.state') }}</dt>
              <dd>{{ t(`agent.chat.turn.${status.turn.status}`) }}</dd>
              <dt>{{ t('agent.chat.status.steps') }}</dt>
              <dd>{{ status.turn.steps }}</dd>
              <dt>{{ t('agent.chat.status.credits') }}</dt>
              <dd>
                {{ status.turn.credits }}
                <p v-if="status.turn.unpricedCalls">
                  {{ t('agent.chat.status.unpricedHint', { n: status.turn.unpricedCalls }) }}
                </p>
                <p v-if="status.turn.unreportedCalls">
                  {{ t('agent.chat.status.unreportedHint', { n: status.turn.unreportedCalls }) }}
                </p>
                <p v-if="status.turn.legacyUsage">{{ t('agent.chat.status.legacyHint') }}</p>
              </dd>
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
            <dt>{{ t('agent.chat.status.contextEstimated') }}</dt>
            <dd>
              {{
                t('agent.chat.status.of', { used: status.contextUsed, limit: status.contextWindow })
              }}
            </dd>
            <template v-if="status.contextReported != null && status.contextWindow > 0">
              <dt>
                {{ t('agent.chat.status.contextReported') }}
              </dt>
              <dd>
                {{
                  t('agent.chat.status.of', {
                    used: status.contextReported,
                    limit: status.contextWindow,
                  })
                }}
              </dd>
            </template>
            <template v-if="status.turnLimit">
              <dt>{{ t('agent.chat.status.turnLimit') }}</dt>
              <dd>{{ status.turnLimit }}</dd>
            </template>
            <dt>{{ t('agent.chat.status.allowed') }}</dt>
            <dd>
              {{
                status.allowedTools.length
                  ? t('agent.chat.status.allowedValue', {
                      n: status.allowedTools.length,
                      names: status.allowedTools.map((n) => toolTitle(n)).join(', '),
                    })
                  : t('agent.chat.status.allowedNone')
              }}
            </dd>
            <dt>{{ t('agent.chat.status.userCreditsToday') }}</dt>
            <dd>
              {{
                t('agent.chat.status.of', {
                  used: status.today.userCredits,
                  limit:
                    Number(status.today.userLimit) === 0
                      ? t('agent.chat.status.unlimited')
                      : status.today.userLimit,
                })
              }}
              <p v-if="status.today.userUnpricedCalls">
                {{ t('agent.chat.status.unpricedHint', { n: status.today.userUnpricedCalls }) }}
              </p>
              <p v-if="status.today.userLegacyCalls">
                {{ t('agent.admin.usage.legacyCalls') }}: {{ status.today.userLegacyCalls }}
              </p>
            </dd>
            <dt>{{ t('agent.chat.status.tenantCreditsToday') }}</dt>
            <dd>
              {{
                t('agent.chat.status.of', {
                  used: status.today.tenantCredits,
                  limit:
                    Number(status.today.tenantLimit) === 0
                      ? t('agent.chat.status.unlimited')
                      : status.today.tenantLimit,
                })
              }}
              <p v-if="status.today.tenantUnpricedCalls">
                {{ t('agent.chat.status.unpricedHint', { n: status.today.tenantUnpricedCalls }) }}
              </p>
              <p v-if="status.today.tenantLegacyCalls">
                {{ t('agent.admin.usage.legacyCalls') }}: {{ status.today.tenantLegacyCalls }}
              </p>
            </dd>
          </dl>
          <p v-else class="agent-card__meta">{{ t('agent.chat.status.none') }}</p>
          <template v-if="status">
            <details
              v-if="status.tools.asks.length"
              class="agent-chat__status-tools"
              :open="status.tools.asks.length <= 3"
            >
              <summary>{{ t('agent.chat.status.asks', { n: status.tools.asks.length }) }}</summary>
              <ul>
                <li v-for="tool in status.tools.asks" :key="tool.name">
                  <strong :title="tool.name">{{ toolTitle(tool.name, tool.title) }}</strong>
                  <span>{{ t(`agent.chat.approval.why.${tool.why}`) }}</span>
                </li>
              </ul>
            </details>
            <details
              v-if="status.tools.unavailable.length"
              class="agent-chat__status-tools"
              :open="status.tools.unavailable.length <= 3"
            >
              <summary>
                {{ t('agent.chat.status.unavailable', { n: status.tools.unavailable.length }) }}
              </summary>
              <ul>
                <li v-for="tool in status.tools.unavailable" :key="tool.name">
                  <strong :title="tool.name">{{ toolTitle(tool.name, tool.title) }}</strong>
                  <span>{{ t(`agent.chat.status.unavailableWhy.${tool.reason}`) }}</span>
                </li>
              </ul>
            </details>
          </template>
        </div>
      </div>

      <p v-if="readOnly && thread?.parentThreadId" class="agent-card__meta">
        {{ t('agent.chat.subtask.readonly') }}
      </p>
      <template v-if="!readOnly">
        <div v-if="context" class="agent-chat__context">
          <el-tag v-if="context" closable type="info" @close="context = null">
            {{ t('agent.chat.context.from', { title: context.title || context.route }) }}
            <template v-if="context.ids?.length"
              >· {{ t('agent.chat.context.selected', { n: context.ids.length }) }}</template
            >
          </el-tag>
        </div>
        <p v-if="running" class="agent-card__meta">
          {{
            t(
              awaitingApproval
                ? 'agent.chat.composer.waitingHint'
                : 'agent.chat.composer.queueHint',
              { stop: stopLabel },
            )
          }}
        </p>
        <Composer
          ref="composerRef"
          v-model:settings="settings"
          :options
          :submit
          :running
          :awaiting-approval
          :stopping
          :context="contextUse"
          :records
          :temporary="thread ? thread.temporary : temporary"
          :disabled="unavailable"
          :stop-key="stopKey"
          :queue-key="shortcuts.queue"
          @stop="stop"
          @command="onCommand"
        >
          <template #status>
            <div
              v-if="statusLine"
              class="agent-chat__statusline"
              role="group"
              :aria-label="t('agent.chat.statusLine.label')"
            >
              <span
                v-for="(part, i) in statusLine.parts"
                :key="i"
                class="agent-chat__statusline-part"
                >{{ part }}</span
              >
              <el-button
                v-if="statusLine.allowed"
                link
                size="small"
                class="agent-chat__statusline-allowed"
                :title="t('agent.chat.statusLine.allowedHint')"
                @click="openAllowed"
                >{{ t('agent.chat.statusLine.allowed', { n: statusLine.allowed }) }}</el-button
              >
            </div>
          </template>
        </Composer>
      </template>
    </section>
    <div
      v-if="panelOpen && !panelNarrow && !panelInMain"
      v-bind="panelSplitter"
      class="agent-chat__splitter"
      :class="{ 'is-dragging': panelDragging }"
      :aria-label="t('agent.chat.layout.resizePanel')"
      aria-controls="agent-side-panel"
      :title="t('agent.chat.layout.resizeHint')"
    />
    <div
      v-if="panelOpen && (!panelNarrow || panelInMain)"
      id="agent-side-panel"
      class="agent-chat__panel"
      :class="{ 'agent-chat__panel--main': panelInMain }"
      :style="panelInMain ? undefined : { width: `${panelWidth}px` }"
    >
      <nav
        v-if="panelInMain"
        class="agent-chat__crumbs"
        :aria-label="t('agent.chat.layout.crumbs')"
      >
        <el-button size="small" @click="panelOpen = false">
          <Icon icon="lucide:arrow-left" class="agent-chat__btn-icon" />
          {{ t('agent.chat.layout.backToChat') }}</el-button
        >
        <ol class="agent-chat__crumb-list">
          <li>{{ conversationTitle }}</li>
          <li aria-current="page">{{ panelTitle }}</li>
        </ol>
      </nav>
      <SubtaskDetail
        v-if="childId && thread && !readOnly"
        :key="childId"
        :parent-id="thread.id"
        :thread-id="childId"
        :in-main="panelInMain"
        @toggle-main="panelInMain = !panelInMain"
        @close="panelOpen = false"
      />
      <ContextPanel
        v-else
        :key="panelScope"
        :items="panelItems"
        :turn
        :selected-id="inspectedId"
        :readonly="readOnly"
        :in-main="panelInMain"
        @toggle-main="panelInMain = !panelInMain"
        @select="inspectedId = $event"
        @inspect-child="inspectChild"
        @close="panelOpen = false"
      />
    </div>
    <el-drawer
      v-if="panelNarrow"
      :model-value="panelOpen && !panelInMain"
      :title="t('agent.chat.panel.open')"
      :with-header="false"
      size="min(100vw, 480px)"
      destroy-on-close
      class="agent-context-drawer"
      @update:model-value="(open: boolean) => !panelInMain && (panelOpen = open)"
    >
      <SubtaskDetail
        v-if="childId && thread && !readOnly"
        :key="childId"
        :parent-id="thread.id"
        :thread-id="childId"
        @toggle-main="panelInMain = true"
        @close="panelOpen = false"
      />
      <ContextPanel
        v-else
        :key="panelScope"
        :items="panelItems"
        :turn
        :selected-id="inspectedId"
        :readonly="readOnly"
        @toggle-main="panelInMain = true"
        @select="inspectedId = $event"
        @inspect-child="inspectChild"
        @close="panelOpen = false"
      />
    </el-drawer>
  </div>
</template>

<style scoped>
.agent-chat {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
}
/* focus mode: the workbench covers the side menu and the tags, below Element Plus overlays (2000+) */
.agent-chat--focus {
  position: fixed;
  inset: 0;
  z-index: 1000;
  padding: 16px;
  background: var(--qw-canvas);
}
/* the banner of an acting tenant stays visible above the workbench */
:global(.app-layout--acting) .agent-chat--focus {
  top: 36px;
}
.agent-chat--dragging {
  cursor: col-resize;
  user-select: none;
}
.agent-chat--embedded :deep(.agent-threads) {
  width: 240px;
  margin-right: 8px;
}
.agent-chat :deep(.agent-threads),
.agent-chat__main,
.agent-chat__rail {
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
.agent-chat :deep(.agent-threads) {
  flex: none;
}
.agent-chat__rail {
  flex: none;
  align-items: center;
  width: 44px;
  padding: 8px 4px;
  margin-right: 12px;
}
.agent-chat__splitter {
  position: relative;
  flex: none;
  width: 12px;
  cursor: col-resize;
  touch-action: none;
  border-radius: var(--qw-radius-sm);
}
/* a faint line with a grip in the middle; darker on hover and while dragging */
.agent-chat__splitter::before,
.agent-chat__splitter::after {
  position: absolute;
  content: '';
  transition: background-color 0.15s;
}
.agent-chat__splitter::before {
  top: 8px;
  bottom: 8px;
  left: 5px;
  width: 2px;
  background: var(--qw-border);
  border-radius: 1px;
}
.agent-chat__splitter::after {
  top: 50%;
  left: 4px;
  width: 4px;
  height: 32px;
  background: var(--qw-text-3);
  border-radius: 2px;
  opacity: 0.45;
  transform: translateY(-50%);
}
.agent-chat__splitter:hover::before,
.agent-chat__splitter.is-dragging::before,
.agent-chat__splitter:hover::after,
.agent-chat__splitter.is-dragging::after {
  background: var(--qw-brand);
  opacity: 1;
}
.agent-chat__splitter:focus-visible {
  outline: none;
}
.agent-chat__splitter:focus-visible::before {
  background: var(--qw-brand-text);
  box-shadow: 0 0 0 2px var(--qw-brand-weak);
}
.agent-chat__panel {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  min-height: 0;
}
.agent-chat__panel--main {
  flex: 1;
}
.agent-chat__crumbs {
  display: flex;
  flex: none;
  gap: 12px;
  align-items: center;
}
.agent-chat__crumb-list {
  display: flex;
  min-width: 0;
  padding: 0;
  margin: 0;
  overflow: hidden;
  font-size: 13px;
  color: var(--qw-text-2);
  list-style: none;
}
.agent-chat__crumb-list li {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-chat__crumb-list li + li::before {
  padding: 0 6px;
  color: var(--qw-text-3);
  content: '/';
}
.agent-chat__crumb-list li[aria-current='page'] {
  flex: none;
  font-weight: 600;
  color: var(--qw-text);
}
.agent-chat__main {
  flex: 1;
  min-width: 0;
  container: agent-main / inline-size;
}
/* a narrow conversation column (wide panes): the header buttons keep their icon, the text stays for
   assistive technology and in the tooltip */
@container agent-main (max-width: 680px) {
  .agent-chat__btn-text {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .agent-chat__btn-icon {
    margin-right: 0;
  }
}
.agent-chat__head {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.agent-chat__head > .el-button {
  margin: 0;
}
.agent-chat__btn-icon {
  width: 14px;
  height: 14px;
  margin-right: 4px;
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
/* the reading column: centred, at most 860px wide, narrower when the panes take the room */
.agent-chat__stream {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  padding: 8px max(4px, calc((100% - 860px) / 2));
  overflow: auto;
}
.agent-chat__main > :is(.agent-composer, .agent-chat__context, .agent-card__meta) {
  box-sizing: border-box;
  width: 100%;
  max-width: 860px;
  margin-inline: auto;
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
.agent-chat__status p {
  margin: 4px 0;
}
.agent-chat__context {
  display: flex;
}
</style>

<!-- 子组件共用的卡片、消息与 Markdown 样式（类名都带 agent- / qw-md 前缀） -->
<style>
.agent-context-drawer .el-drawer__body {
  display: flex;
  min-height: 0;
  padding: 12px;
}
.agent-chat__statusline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  font-size: 12px;
  color: var(--qw-text-3);
}
.agent-chat__statusline > * + *::before {
  margin-right: 8px;
  content: '·';
}
.agent-chat__status-tools summary {
  cursor: pointer;
  font-size: 13px;
}
.agent-chat__status-tools ul {
  margin: 4px 0 0;
  padding-left: 18px;
}
.agent-chat__status-tools li {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 13px;
}
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
  max-width: 75%;
}
.agent-msg--assistant {
  width: 100%;
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
/* one row of actions per message, shown while the pointer or the focus is on that message */
.agent-msg .agent-msg__actions {
  opacity: 0;
  transition: opacity 0.15s;
}
.agent-msg:hover .agent-msg__actions,
.agent-msg:focus-within .agent-msg__actions {
  opacity: 1;
}
.agent-msg__actions {
  display: flex;
  gap: 2px;
}
.agent-msg__answer {
  display: flex;
  flex: 1;
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
.agent-composer__pricing {
  margin: 0;
  font-size: 12px;
  color: var(--qw-warning);
}
.agent-composer__reject-hint {
  margin: 0;
  font-size: 12px;
  color: var(--qw-warning);
}
.agent-composer__announce {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
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
  flex: none;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
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
  display: -webkit-box;
  flex: 0 1 auto;
  align-self: flex-start;
  min-width: 0;
  max-width: 45%;
  overflow: hidden;
  overflow-wrap: anywhere;
  font-weight: 500;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.agent-composer__hint {
  display: -webkit-box;
  flex: 1;
  align-self: flex-start;
  min-width: 0;
  overflow: hidden;
  color: var(--qw-text-3);
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.agent-composer__tooltip {
  box-sizing: border-box;
  max-width: min(420px, calc(100vw - 32px));
  font-family: var(--qw-font);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.agent-composer__suggest {
  font: inherit;
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
  width: 240px;
}
.agent-composer__reasoning {
  width: 200px;
}
.agent-composer__mode {
  width: 170px;
}
.agent-composer__keys {
  margin: 0;
  overflow: hidden;
  font-size: 12px;
  color: var(--qw-text-3);
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* a narrow conversation column: the toolbar stays on one row, the selects shrink, the context use keeps
   only its meter (its text stays the meter's accessible name) */
@container agent-main (max-width: 680px) {
  .agent-composer__bar {
    flex-wrap: nowrap;
    min-width: 0;
    gap: 6px;
  }
  .agent-composer__bar > * {
    flex-shrink: 0;
  }
  /* the selects and the meter give way first, so the send button stays inside the message box width */
  .agent-composer__bar > .agent-composer__model,
  .agent-composer__bar > .agent-composer__reasoning,
  .agent-composer__bar > .agent-composer__mode {
    flex: 0 1 auto;
    min-width: 64px;
  }
  .agent-composer__bar > .agent-composer__context {
    flex: 0 1 64px;
    min-width: 24px;
  }
  .agent-composer__context meter {
    width: 100%;
    min-width: 0;
  }
  .agent-composer__spacer {
    flex: 1 1 0;
    min-width: 0;
  }
  .agent-composer__context-text {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
}
.agent-settings__tabs .el-tab-pane {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.agent-settings__row {
  display: flex;
  gap: 8px;
  align-items: center;
  min-height: 32px;
}
.agent-settings__name {
  flex: 1;
  color: var(--qw-text-2);
}
.agent-settings__row .el-button {
  margin: 0;
}
.agent-settings__section {
  flex: none;
  margin-top: 8px;
  font-weight: 600;
}
.agent-settings__allowed {
  margin: 0;
  padding: 0;
  list-style: none;
}
.agent-settings__hint {
  margin: 0 0 4px;
  font-size: 12px;
  line-height: 18px;
  color: var(--qw-text-3);
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
  width: auto;
  max-width: 100%;
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
</style>
