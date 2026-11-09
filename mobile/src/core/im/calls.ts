import { shallowRef, watch } from 'vue'
import {
  imCallVo,
  type ImCall,
  type ImCallHint,
  type ImCallMode,
  type ImOptions,
} from '@qiwu/shared'
import type { ImCallView } from '@qiwu/shared/im-client'
// #ifndef MP-WEIXIN
import { createImCallController } from '@qiwu/shared/im-client'
// #endif
import type { ImMediaFailure } from '@qiwu/shared/im-media'
import {
  IM_CALL_ACTION_EVENT,
  IM_CALL_SCREEN_EVENT,
  readImCallAction,
  type ImCallScreen,
  type ImCallScreenAction,
} from './call-screen'
import { canWriteImCall, imCallApi } from './call-api'
import { imApi } from './api'
import { IM_PLATFORM, imLeader, imOptions, imStart, imState, onImChange } from './client'
import { ensureImMedia, imBrowserMedia, imMedia, imMediaReserved, initializeImMedia } from './media'
import { cancelImVoice, reconcileImVoice } from './voice'
import { currentSessionVersion, hasSession, sessionVersion } from '../request'
import { useAuthStore } from '../stores/auth'

const emptyMedia = () => ({
  connectionId: '',
  state: 'idle' as const,
  localIdentity: '',
  microphone: false,
  camera: false,
  speakerPreferred: false,
  participants: [],
})
export const imCalls = shallowRef<ImCallView>({
  calls: [],
  current: null,
  media: emptyMedia(),
  busy: false,
  error: null,
})
export const imCallScreen = shallowRef<ImCallScreen | null>(null)
export const imCallCleanupBusy = shallowRef(false)
let controller: ReturnType<typeof createImCallController> | null = null
let screen: { id: string; callId: number; session: number } | null = null
let initialized = false
let foreground = false
let controlBusy = false
let navigating = false
let optionsSession = -1
let version = 0
let optionsFlight: { session: number; promise: Promise<ImOptions | null> } | null = null
let poll: ReturnType<typeof setInterval> | null = null
const presented = new Set<number>()
const newId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
const terminal = (call: ImCall | null) => !call || call.state === 'ended' || call.state === 'ending'

function currentController() {
  // #ifndef MP-WEIXIN
  if (!controller && IM_PLATFORM)
    controller = createImCallController({
      api: imCallApi,
      media: imMedia,
      beforeConnect: cancelImVoice,
      leaveOnMediaDisconnect: process.env.UNI_PLATFORM !== 'h5',
      onChange(view) {
        imCalls.value = view
        imMediaReserved.value = view.busy || view.media.state !== 'idle'
        if (!screen && view.current && !terminal(view.current) && foreground)
          openImCallPage(view.current.id)
        publish()
        presentIncoming()
      },
    })
  // #endif
  return controller
}

/** 唯一 App-service 控制器向 nvue 发布不含凭据的 DTO。 */
function publish(closed = false, target = screen) {
  if (!target) {
    imCallScreen.value = null
    return
  }
  const view = imCalls.value
  const raw =
    view.current?.id === target.callId
      ? view.current
      : (view.calls.find((item) => item.id === target.callId) ?? null)
  const parsed = raw ? imCallVo.safeParse(raw) : null
  const call = parsed?.success ? parsed.data : null
  const sameCall = view.current?.id === target.callId
  const source = sameCall || view.media.state === 'disconnecting' ? view.media : emptyMedia()
  const media = {
    connectionId: source.connectionId,
    state: source.state,
    localIdentity: source.localIdentity,
    microphone: source.microphone,
    camera: source.camera,
    speakerPreferred: source.speakerPreferred,
    participants: source.participants.map((person) => ({
      identity: person.identity,
      name: person.name,
      local: person.local,
      microphone: person.microphone,
      camera: person.camera,
    })),
  }
  let audioBlocked = false
  if (process.env.UNI_PLATFORM === 'h5' && view.media.state !== 'idle') {
    try {
      audioBlocked = imBrowserMedia().audioBlocked
    } catch {
      /* 当前错误由控制器显示。 */
    }
  }
  const error = view.error ? { code: view.error.code, operation: view.error.operation } : null
  const dto: ImCallScreen = {
    screenId: target.id,
    callId: target.callId,
    call: closed ? null : call,
    selfId: useAuthStore().me?.user.id ?? 0,
    media: closed ? emptyMedia() : media,
    busy: view.busy,
    controlBusy,
    error: closed ? null : error,
    native: process.env.UNI_PLATFORM === 'app',
    writer: canWriteImCall(),
    audioBlocked,
    otherCallActive: !!view.current && !sameCall && view.media.state !== 'idle',
    closed,
  }
  if (target === screen) imCallScreen.value = dto
  uni.$emit(IM_CALL_SCREEN_EVENT, dto)
}

/** 页面地址只有通话编号与非凭据的页面代号，票据始终留在控制器调用栈。 */
export function openImCallPage(callId: number): void {
  if (!IM_PLATFORM || !foreground || !hasSession() || !Number.isSafeInteger(callId) || callId <= 0)
    return
  if (screen?.callId === callId && screen.session === currentSessionVersion()) {
    publish()
    return
  }
  const previous = screen
  const next = { id: newId(), callId, session: currentSessionVersion() }
  screen = next
  presented.add(callId)
  if (previous) publish(true, previous)
  const pages = getCurrentPages()
  const inside = pages.at(-1)?.route === 'pages-im/call/index'
  const navigation = inside ? uni.redirectTo : uni.navigateTo
  navigating = true
  navigation({
    url: `/pages-im/call/index?callId=${callId}&screenId=${encodeURIComponent(next.id)}`,
    fail: () => {
      if (screen === next) {
        screen = null
        imCallScreen.value = null
        presented.delete(callId)
      }
    },
    complete: () => {
      navigating = false
    },
  })
  publish()
}

/** 前台空闲时展示来电页，进入页面本身不会接受或开启设备。 */
function presentIncoming() {
  if (
    !foreground ||
    screen ||
    navigating ||
    controlBusy ||
    !hasSession() ||
    !canWriteImCall() ||
    useAuthStore().passwordChangeDue
  )
    return
  if (imCalls.value.media.state !== 'idle') return
  const userId = useAuthStore().me?.user.id
  const call = imCalls.value.calls.find(
    (item) =>
      item.canAccept &&
      item.members.some((member) => member.userId === userId && member.state === 'invited') &&
      !presented.has(item.id) &&
      !terminal(item),
  )
  if (call) openImCallPage(call.id)
}

async function options(reload = false): Promise<ImOptions | null> {
  if (!IM_PLATFORM || !foreground || !hasSession()) return null
  const session = currentSessionVersion()
  if (!reload && optionsSession === session && imOptions.value) return imOptions.value
  if (optionsFlight?.session === session) return optionsFlight.promise
  const auth = useAuthStore()
  const at = version
  const run = (async () => {
    try {
      if (!auth.me) await auth.fetchMe()
      if (
        at !== version ||
        session !== currentSessionVersion() ||
        !foreground ||
        !hasSession() ||
        auth.passwordChangeDue ||
        (auth.me?.features && !auth.me.features.includes('im'))
      )
        return null
      const loaded = await imApi.options()
      if (at !== version || session !== currentSessionVersion() || !foreground || !hasSession())
        return null
      const changedEpoch = !!imOptions.value?.epoch && imOptions.value.epoch !== loaded.epoch
      if (changedEpoch) retire(false)
      imOptions.value = loaded
      optionsSession = session
      if (changedEpoch) {
        const adopted = version
        // 新配置只为自己的有效前台代次恢复一次；旧发起/提示仍会被原版本检查丢弃。
        void Promise.resolve()
          .then(() => {
            if (canWriteImCall()) return resumeForeground(loaded, session, adopted)
          })
          .catch(() => {})
      }
      return loaded
    } catch {
      if (at === version && session === currentSessionVersion()) currentController()?.reset()
      return null
    }
  })()
  const flight = { session, promise: run }
  optionsFlight = flight
  void run.finally(() => {
    if (optionsFlight === flight) optionsFlight = null
  })
  return run
}

/** 前台恢复邀请与未确认的本地清理，不自动重开设备。 */
export async function imCallForeground(): Promise<void> {
  foreground = true
  if (!IM_PLATFORM || !hasSession()) return
  const session = currentSessionVersion(),
    at = version
  const loaded = await options(true)
  if (
    !loaded ||
    !foreground ||
    !hasSession() ||
    at !== version ||
    session !== currentSessionVersion()
  )
    return
  await resumeForeground(loaded, session, at)
}

/** 已采纳的配置直接恢复，不能递归重取 options 或沿用退役前的发起意图。 */
async function resumeForeground(loaded: ImOptions, session: number, at: number): Promise<void> {
  const current = () =>
    foreground && hasSession() && at === version && session === currentSessionVersion()
  if (!current()) return
  if (process.env.UNI_PLATFORM === 'h5') await imStart()
  if (!current() || !canWriteImCall()) return
  const target = currentController()
  if (!target) return
  if (target.view.media.state === 'disconnecting') await target.retryDisconnect()
  if (!current() || !canWriteImCall()) return
  if (loaded.callEnabled === true) {
    await target.refresh()
    if (!current() || !canWriteImCall()) return
    if (!poll)
      poll = setInterval(() => {
        if (current() && canWriteImCall()) void target.refresh()
      }, 30_000)
  }
}

/** App 退入后台先停止本地媒体；服务端离开失败由短心跳和持续清理兜底。 */
export function imCallBackground(): void {
  foreground = false
  version++
  optionsFlight = null
  imCallCleanupBusy.value = false
  if (poll) clearInterval(poll)
  poll = null
  void cancelImVoice().catch(() => {})
  const previous = screen
  screen = null
  imCallScreen.value = null
  controlBusy = false
  if (previous) publish(true, previous)
  void controller?.leave()
}

/** 仅当前登录代次可以执行页面动作，隐藏和退出先摘掉页面代号。 */
function retire(closePage: boolean) {
  imCallCleanupBusy.value = false
  version++
  optionsFlight = null
  optionsSession = -1
  presented.clear()
  controlBusy = false
  if (poll) clearInterval(poll)
  poll = null
  const previous = screen
  screen = null
  imCallScreen.value = null
  controller?.reset()
  void cancelImVoice().catch(() => {})
  if (previous) publish(true, previous)
  if (closePage) foreground = false
}

/** 失败的原生释放不能隐藏成空闲；即使已无业务通话，消息页仍允许重试本地清理。 */
export async function retryImCallDisconnect(): Promise<void> {
  if (!foreground || imCallCleanupBusy.value || imCalls.value.media.state !== 'disconnecting')
    return
  const at = version
  imCallCleanupBusy.value = true
  try {
    await currentController()?.retryDisconnect()
  } finally {
    if (at === version) imCallCleanupBusy.value = false
  }
}

/** 新发起前先确认本端具备真实媒体能力，避免旧安装包向对方发送无法接通的邀请。 */
export async function startImCall(
  roomId: number,
  mode: ImCallMode,
  userIds?: number[],
): Promise<void> {
  if (!IM_PLATFORM || !foreground || controlBusy || !hasSession()) return
  if (!canWriteImCall()) {
    setFailure({ code: 'NOT_LEADER', operation: 'create' })
    return
  }
  const session = currentSessionVersion(),
    at = version
  const loaded = await options()
  if (
    !loaded ||
    at !== version ||
    !foreground ||
    !hasSession() ||
    session !== currentSessionVersion() ||
    !canWriteImCall()
  )
    return
  if (loaded.callEnabled !== true || loaded.callConfigured !== true) {
    setFailure({ code: 'UNCONFIGURED', operation: 'create' })
    return
  }
  try {
    ensureImMedia()
  } catch {
    setFailure({ code: 'SDK_UNAVAILABLE', operation: 'create' })
    return
  }
  await currentController()?.start(roomId, mode, userIds)
}

function setFailure(error: ImMediaFailure) {
  imCalls.value = { ...imCalls.value, error }
  publish()
}
/** 全局提示只是编号，当前身份经 HTTP 恢复后才可显示来电。 */
export function imCallHint(hint: ImCallHint): void {
  if (!IM_PLATFORM || !foreground || !hasSession()) return
  const at = version,
    session = currentSessionVersion()
  void options().then((loaded) => {
    if (
      loaded?.callEnabled &&
      at === version &&
      foreground &&
      hasSession() &&
      session === currentSessionVersion()
    )
      return currentController()?.onHint(hint)
  })
}

async function action(input: ImCallScreenAction) {
  if (input.action === 'ready' && !screen && foreground && hasSession()) {
    const last = getCurrentPages().at(-1) as
      { route?: string; options?: Record<string, string> } | undefined
    if (
      last?.route === 'pages-im/call/index' &&
      last.options?.screenId === input.screenId &&
      Number(last.options.callId) === input.callId
    ) {
      const session = currentSessionVersion(),
        at = version
      screen = { id: input.screenId, callId: input.callId, session }
      await options()
      if (session !== currentSessionVersion() || at !== version) return
      await currentController()?.refresh()
      if (session !== currentSessionVersion() || at !== version) return
    }
  }
  const target = screen
  if (
    !target ||
    input.screenId !== target.id ||
    input.callId !== target.callId ||
    target.session !== currentSessionVersion() ||
    !foreground ||
    !hasSession()
  )
    return
  const call =
    imCalls.value.current?.id === target.callId
      ? imCalls.value.current
      : imCalls.value.calls.find((item) => item.id === target.callId)
  const model = currentController()
  if (!model) return
  if (input.action === 'ready') {
    publish()
    return
  }
  if (input.action === 'close' || input.action === 'hide') {
    screen = null
    imCallScreen.value = null
    controlBusy = false
    navigating = true
    if (imCalls.value.current?.id === target.callId) void model.leave()
    publish(true, target)
    if (input.action === 'close') {
      const last = getCurrentPages().at(-1) as
        { route?: string; options?: Record<string, string> } | undefined
      if (last?.route === 'pages-im/call/index' && last.options?.screenId === target.id) {
        uni.navigateBack({
          complete: () => {
            navigating = false
            presentIncoming()
          },
        })
      } else navigating = false
    } else
      setTimeout(() => {
        navigating = false
        presentIncoming()
      }, 200)
    return
  }
  if (
    controlBusy ||
    (imCalls.value.busy && !['leave', 'end', 'retryDisconnect'].includes(input.action))
  )
    return
  if (input.action !== 'retryDisconnect' && !canWriteImCall()) {
    setFailure({ code: 'NOT_LEADER', operation: input.action })
    return
  }
  controlBusy = true
  publish()
  try {
    if (input.action === 'retryDisconnect') await model.retryDisconnect()
    else if (input.action === 'leave' && imCalls.value.current?.id === target.callId)
      await model.leave()
    else if (input.action === 'end' && call?.canEnd) await model.end(call)
    else if (input.action === 'decline' && call?.canDecline) await model.decline(call)
    else if (
      (input.action === 'accept' && call?.canAccept) ||
      (input.action === 'join' && call?.canJoin)
    ) {
      const loaded = await options()
      if (
        screen !== target ||
        target.session !== currentSessionVersion() ||
        !foreground ||
        !hasSession() ||
        !canWriteImCall()
      )
        return
      if (!loaded?.callConfigured || !loaded.callEnabled) {
        setFailure({ code: 'UNCONFIGURED', operation: input.action })
        return
      }
      ensureImMedia()
      if (input.action === 'accept') await model.accept(call!)
      else await model.join(call!)
    } else if (
      imCalls.value.current?.id === target.callId &&
      imCalls.value.media.state === 'connected'
    ) {
      const port = ensureImMedia(),
        id = imCalls.value.media.connectionId
      if (input.action === 'microphone') await port.setMicrophoneEnabled(id, input.enabled === true)
      else if (input.action === 'camera') await port.setCameraEnabled(id, input.enabled === true)
      else if (input.action === 'switchCamera') await port.switchCamera(id)
      else if (input.action === 'speaker' && process.env.UNI_PLATFORM === 'app')
        await port.setSpeakerOutputPreferred(id, input.enabled === true)
      else if (input.action === 'audio' && process.env.UNI_PLATFORM === 'h5')
        await imBrowserMedia().startAudio()
    }
  } catch (error) {
    if (screen === target && target.session === currentSessionVersion()) {
      const code = (error as ImMediaFailure | null)?.code
      setFailure({
        code: typeof code === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(code) ? code : 'SDK_ERROR',
        operation: input.action,
      })
    }
  } finally {
    if (screen === target && target.session === currentSessionVersion()) {
      controlBusy = false
      publish()
    }
  }
}

/** 启动一次跨 vue/nvue 的安全控制通道，业务和票据只由 App-service 持有。 */
export function initializeImCalls(): void {
  if (initialized || !IM_PLATFORM) return
  initialized = true
  initializeImMedia()
  uni.$on(IM_CALL_ACTION_EVENT, (value: unknown) => {
    const input = readImCallAction(value)
    if (input) void action(input)
  })
  watch(
    sessionVersion,
    () => {
      retire(false)
      const at = version
      void Promise.resolve().then(() => {
        if (at === version && foreground && hasSession()) return imCallForeground()
      })
    },
    { flush: 'sync' },
  )
  watch(
    imState,
    (state) => {
      if (state === 'locked' || state === 'disabled') retire(false)
    },
    { flush: 'sync' },
  )
  watch(
    imLeader,
    (leader) => {
      if (process.env.UNI_PLATFORM !== 'h5') return
      if (!leader) retire(false)
      else if (foreground && hasSession()) void imCallForeground()
    },
    { flush: 'sync' },
  )
  onImChange((change) => {
    if (change.type === 'cleared') retire(false)
    else if (change.type === 'entries') void reconcileImVoice()
  })
}
