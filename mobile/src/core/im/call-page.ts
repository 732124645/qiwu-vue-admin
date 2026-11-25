import { computed, shallowRef } from 'vue'
import { onHide, onLoad, onShow, onUnload } from '@dcloudio/uni-app'
import {
  IM_CALL_ACTION_EVENT,
  IM_CALL_SCREEN_EVENT,
  type ImCallAction,
  type ImCallScreen,
} from './call-screen'
import { t } from '../i18n'
import theme from '../../theme.json'

/** 两种渲染页面只收安全快照和发送用户动作；不导入登录、请求、控制器或原生 SDK。 */
export function useImCallPage() {
  const view = shallowRef<ImCallScreen | null>(null)
  const dark = shallowRef(false)
  let screenId = '',
    callId = 0,
    shown = false,
    listening = false
  const receive = (next: ImCallScreen) => {
    if (!shown || next.screenId !== screenId || next.callId !== callId) return
    view.value = next
  }
  function emit(action: ImCallAction, enabled?: boolean) {
    if (!shown || !screenId || !callId) return
    uni.$emit(IM_CALL_ACTION_EVENT, {
      screenId,
      callId,
      action,
      ...(enabled === undefined ? {} : { enabled }),
    })
  }
  function clear() {
    emit('hide')
    shown = false
    view.value = null
    if (listening) uni.$off(IM_CALL_SCREEN_EVENT, receive)
    listening = false
  }
  onLoad((query) => {
    screenId =
      typeof query?.screenId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(query.screenId)
        ? query.screenId
        : ''
    callId = Number(query?.callId)
    if (!Number.isSafeInteger(callId) || callId <= 0) callId = 0
    uni.setNavigationBarTitle({ title: t('imMedia.call.title') })
  })
  onShow(() => {
    shown = true
    const pref: unknown = uni.getStorageSync('qw.theme')
    dark.value = pref === 'dark' || (pref !== 'light' && uni.getAppBaseInfo().theme === 'dark')
    if (!listening) {
      uni.$on(IM_CALL_SCREEN_EVENT, receive)
      listening = true
    }
    emit('ready')
  })
  onHide(clear)
  onUnload(clear)
  const busy = computed(
    () =>
      !view.value ||
      view.value.closed ||
      !view.value.writer ||
      view.value.busy ||
      view.value.controlBusy,
  )
  const connected = computed(() => view.value?.media.state === 'connected')
  const tokens = computed(() => theme[dark.value ? 'dark' : 'light'].qw)
  const participants = computed(() => view.value?.media.participants ?? [])
  const failure = computed(() => {
    const error = view.value?.error
    if (!error) return ''
    const key =
      error.code === 'NOT_LEADER'
        ? 'notLeader'
        : error.code === 'UNCONFIGURED'
          ? 'unconfigured'
          : error.code === 'PERMISSION_DENIED'
            ? 'permissionDenied'
            : error.code === 'SDK_UNAVAILABLE' || error.code === 'UNSUPPORTED'
              ? 'unavailable'
              : error.code === 'BUSY'
                ? 'busy'
                : 'failed'
    return t(`imMedia.call.${key}`)
  })
  function close() {
    if (!view.value || view.value.closed) uni.navigateBack()
    else emit('close')
  }
  const change = (action: ImCallAction, event: unknown) =>
    emit(action, (event as { detail?: { value?: unknown } } | null)?.detail?.value === true)
  return { t, view, busy, connected, participants, tokens, failure, act: emit, change, close }
}
