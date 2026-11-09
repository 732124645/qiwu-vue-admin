import { computed, shallowRef, watch } from 'vue'
import { defineStore } from 'pinia'
import { useEventListener, useIntervalFn } from '@vueuse/core'
import { RT } from '@qiwu/shared'
import {
  createImCallController,
  emptyImMediaSnapshot,
  type ImCallView,
} from '@qiwu/shared/im-client'
import { createBrowserMediaPort, ImMediaError } from '@qiwu/shared/im-media'
import { imCallApi } from '@/api/platform/im'
import { onRealtime } from '@/core/realtime/socket'
import { useAuthStore } from '@/core/stores/auth'
import { useImStore } from './im-store'
import { stopImVoice } from './voice'

/** 前台通话入口与会话隔离；票据只经控制器局部进入 SDK，不进入 Pinia。 */
export const useImCallsStore = defineStore('im-calls', () => {
  const auth = useAuthStore(),
    im = useImStore()
  const media = createBrowserMediaPort()
  const view = shallowRef<ImCallView>({
    calls: [],
    current: null,
    media: emptyImMediaSnapshot(),
    busy: false,
    error: null,
  })
  const controlBusy = shallowRef(false)
  let controlGeneration = 0
  const lockAvailable = !!navigator.locks
  const enabled = computed(
    () =>
      im.enabled &&
      !auth.locked &&
      !auth.mustChangePassword &&
      im.options?.callEnabled === true &&
      im.options?.callConfigured === true &&
      lockAvailable &&
      im.leader,
  )
  const unavailable = computed(() =>
    !lockAvailable ? 'im.calls.locksUnavailable' : !im.leader ? 'im.calls.otherTab' : '',
  )
  /** 复用聊天主标签页锁；每次写操作均复查，避免界面旁路或交接期间去结束后继标签页的通话。 */
  function owned<T>(fn: () => Promise<T>): Promise<T> {
    if (!enabled.value) return Promise.reject(new ImMediaError('BUSY', 'tabOwnership'))
    return fn()
  }
  const controller = createImCallController({
    api: {
      ...imCallApi,
      create: (roomId, body) => owned(() => imCallApi.create(roomId, body)),
      accept: (id) => owned(() => imCallApi.accept(id)),
      decline: (id) => owned(() => imCallApi.decline(id)),
      join: (id) => owned(() => imCallApi.join(id)),
      heartbeat: (id) => owned(() => imCallApi.heartbeat(id)),
      leave: (id) => owned(() => imCallApi.leave(id)),
      end: (id) => owned(() => imCallApi.end(id)),
    },
    media,
    beforeConnect: stopImVoice,
    leaveOnMediaDisconnect: false,
    onChange: (next) => {
      if (next.media.connectionId !== view.value.media.connectionId) {
        controlGeneration++
        controlBusy.value = false
      }
      view.value = next
    },
  })
  watch(
    () =>
      `${auth.me?.user.id ?? ''}:${auth.tenant?.id ?? ''}:${im.options?.epoch ?? ''}:${auth.locked}:${['locked', 'disabled', 'idle'].includes(im.state)}`,
    () => {
      controller.reset()
      stopImVoice()
      if (enabled.value) void controller.refresh()
    },
    { flush: 'sync' },
  )
  watch(
    enabled,
    (on) => {
      if (on) void controller.refresh()
      else {
        controller.reset()
        stopImVoice()
      }
    },
    { immediate: true, flush: 'sync' },
  )
  onRealtime(RT.imCall, (hint) => {
    if (enabled.value) void controller.onHint(hint)
  })
  onRealtime(RT.sessionKicked, () => {
    controller.reset()
    stopImVoice()
  })
  useIntervalFn(() => {
    if (enabled.value && document.visibilityState === 'visible') void controller.refresh()
  }, 30_000)
  useEventListener(window, 'pagehide', () => {
    stopImVoice()
    void controller.leave()
  })
  useEventListener(document, 'visibilitychange', () => {
    if (document.visibilityState === 'visible' && enabled.value) {
      void controller.retryDisconnect()
      void controller.refresh()
    } else stopImVoice()
  })
  /** 媒体开关同样有单飞，权限与设备错误只呈现受控代码。 */
  async function control(action: 'microphone' | 'camera' | 'switch', enabled?: boolean) {
    if (controlBusy.value || view.value.media.state !== 'connected') return
    controlBusy.value = true
    const id = view.value.media.connectionId,
      at = controlGeneration
    try {
      if (action === 'microphone') await media.setMicrophoneEnabled(id, !!enabled)
      else if (action === 'camera') await media.setCameraEnabled(id, !!enabled)
      else await media.switchCamera(id)
    } catch {
      /* 端口已推受控错误事件。 */
    } finally {
      if (controlGeneration === at) controlBusy.value = false
    }
  }
  return { view, media, controller, control, controlBusy, enabled, unavailable }
})
