import type { ImCall, ImCallCreate, ImCallGrant, ImCallHint } from '../im-media.schema.js'
import type { ImMediaFailure, ImMediaPort, ImMediaSnapshot } from '../media/types.js'

export interface ImCallApi {
  active(): Promise<ImCall[]>
  get(id: number): Promise<ImCall>
  create(roomId: number, body: ImCallCreate): Promise<ImCall>
  accept(id: number): Promise<ImCall>
  decline(id: number): Promise<ImCall>
  join(id: number): Promise<ImCallGrant>
  leave(id: number): Promise<ImCall>
  end(id: number): Promise<ImCall>
  heartbeat(id: number): Promise<ImCall>
}
export interface ImCallView {
  calls: ImCall[]
  current: ImCall | null
  media: ImMediaSnapshot
  busy: boolean
  error: ImMediaFailure | null
}
export const emptyImMediaSnapshot = (): ImMediaSnapshot => ({
  connectionId: '',
  state: 'idle',
  localIdentity: '',
  microphone: false,
  camera: false,
  speakerPreferred: false,
  participants: [],
})

/** 共用通话控制：业务状态与 SDK 状态分开，所有响应按当前账号代次和操作代次应用。 */
export function createImCallController(options: {
  api: ImCallApi
  media: ImMediaPort
  onChange(view: ImCallView): void
  beforeConnect?(): void | Promise<void>
  leaveOnMediaDisconnect?: boolean
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
}) {
  const { api, media } = options
  const setTimer = options.setTimer ?? setTimeout,
    clearTimer = options.clearTimer ?? clearTimeout
  let view: ImCallView = {
    calls: [],
    current: null,
    media: emptyImMediaSnapshot(),
    busy: false,
    error: null,
  }
  let cleanupId = media.getSnapshot().state === 'idle' ? '' : media.getSnapshot().connectionId
  if (cleanupId)
    view.media = { ...emptyImMediaSnapshot(), connectionId: cleanupId, state: 'disconnecting' }
  let generation = 0,
    fetchOrder = 0,
    mediaIntent = 0,
    binding: { gen: number; callId: number; id: string } | null = null
  let heartbeat: ReturnType<typeof setTimeout> | null = null
  let established = false,
    lastHeartbeatAt = 0
  let disposed = false,
    pendingCreate: { signature: string; key: string } | null = null
  const emit = () => {
    if (!disposed) options.onChange({ ...view, calls: [...view.calls] })
  }
  const ownedConnectionId = () =>
    binding ? binding.id || media.getSnapshot().connectionId : cleanupId
  const same = (at: number) => !disposed && generation === at
  const failure = (e: unknown, operation: string): ImMediaFailure => {
    const code = (e as { code?: unknown })?.code
    return {
      code: typeof code === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(code) ? code : 'SDK_ERROR',
      operation,
    }
  }
  function cancelHeartbeat() {
    if (heartbeat !== null) clearTimer(heartbeat)
    heartbeat = null
  }
  function apply(call: ImCall) {
    const old = view.calls.find((c) => c.id === call.id)
    if (old && old.rev > call.rev) return
    view.calls =
      call.state === 'ended'
        ? view.calls.filter((c) => c.id !== call.id)
        : [...view.calls.filter((c) => c.id !== call.id), call]
    if (view.current?.id === call.id && view.current.rev <= call.rev) view.current = call
    emit()
  }
  async function stopMedia(id: string) {
    if (!id) return
    const ownsCleanup = !binding || !binding.id || binding.id === id
    if (ownsCleanup) cleanupId = id
    if (ownsCleanup && !binding) {
      view.media = { ...emptyImMediaSnapshot(), connectionId: id, state: 'disconnecting' }
      emit()
    }
    try {
      await media.disconnect(id)
      if (cleanupId === id) {
        cleanupId = ''
        if (!binding) {
          view.media = emptyImMediaSnapshot()
          emit()
        }
      }
    } catch {
      if (cleanupId === id && !binding) {
        view.error = { code: 'SDK_ERROR', operation: 'disconnect' }
        emit()
      }
    }
  }
  /** 只重试仍占用的旧编号；释放通知迟到时也不能误关新建立的连接。 */
  async function retryDisconnect() {
    const id = cleanupId
    if (!id) return
    const actual = media.getSnapshot()
    if (actual.connectionId !== id || actual.state === 'idle') {
      cleanupId = ''
      if (!binding) view.media = emptyImMediaSnapshot()
      emit()
      return
    }
    await stopMedia(id)
  }
  /** 退役后只关闭当次编号；身份变更不再用新账号令牌发送旧会话的离开请求。 */
  function reset() {
    const id = ownedConnectionId()
    generation++
    mediaIntent++
    fetchOrder++
    binding = null
    established = false
    cancelHeartbeat()
    pendingCreate = null
    view = {
      calls: [],
      current: null,
      media: id
        ? { ...emptyImMediaSnapshot(), connectionId: id, state: 'disconnecting' }
        : emptyImMediaSnapshot(),
      busy: false,
      error: null,
    }
    emit()
    void stopMedia(id)
  }
  async function refresh() {
    const at = generation,
      order = ++fetchOrder,
      intent = mediaIntent,
      // 发起/接受/加入尚未完成时，列表请求不能证明随后采纳的通话缺席。
      currentAtRead = view.busy ? null : view.current
    const known = new Map(view.calls.map((call) => [call.id, call.rev]))
    try {
      const calls = await api.active()
      if (!same(at) || order !== fetchOrder) return
      // 列表缺席只证明读取时已知的那一版不在；不能抹掉请求中途新建或更新的通话。
      const received = new Map(calls.map((call) => [call.id, call]))
      const ownsCurrent =
        intent === mediaIntent &&
        currentAtRead?.id === view.current?.id &&
        (!currentAtRead || !view.current || currentAtRead.rev >= view.current.rev)
      const merged = new Map(
        view.calls
          .filter(
            (call) =>
              received.has(call.id) ||
              !known.has(call.id) ||
              call.rev > known.get(call.id)! ||
              (call.id === view.current?.id && !ownsCurrent),
          )
          .map((call) => [call.id, call]),
      )
      for (const call of calls) {
        const old = merged.get(call.id)
        if (old && old.rev > call.rev) continue
        if (call.state === 'ended') merged.delete(call.id)
        else merged.set(call.id, call)
      }
      view.calls = [...merged.values()]
      const current = view.current
      if (current) {
        const next = calls.find((c) => c.id === current.id)
        if (next && next.rev >= current.rev) {
          view.current = next
          if (intent === mediaIntent && (next.state === 'ending' || next.state === 'ended')) {
            const id = ownedConnectionId()
            binding = null
            established = false
            cancelHeartbeat()
            void stopMedia(id)
          }
        } else if (!next && ownsCurrent) {
          const id = ownedConnectionId()
          binding = null
          cancelHeartbeat()
          view.current = null
          view.media = emptyImMediaSnapshot()
          void stopMedia(id)
        }
      }
      emit()
    } catch {
      /* 离线保留当前业务快照，SDK 和心跳仍各自处理，不假装通话结束。 */
    }
  }
  async function onHint(hint: ImCallHint) {
    const at = generation,
      intent = mediaIntent
    if (view.current?.id !== hint.callId) return refresh()
    try {
      const call = await api.get(hint.callId)
      if (!same(at)) return
      apply(call)
      if (
        intent === mediaIntent &&
        view.current?.id === hint.callId &&
        view.current.rev <= call.rev &&
        (call.state === 'ended' || call.state === 'ending')
      ) {
        const id = ownedConnectionId()
        binding = null
        cancelHeartbeat()
        view.media = emptyImMediaSnapshot()
        void stopMedia(id)
        emit()
      }
    } catch (e) {
      if (!same(at)) return
      if (
        intent === mediaIntent &&
        view.current?.id === hint.callId &&
        [401, 403, 404].includes((e as { status?: number }).status ?? 0)
      ) {
        const id = ownedConnectionId()
        binding = null
        cancelHeartbeat()
        view.current = null
        view.media = emptyImMediaSnapshot()
        void stopMedia(id)
        emit()
      }
    }
  }
  function scheduleHeartbeat(at: number, id: number) {
    cancelHeartbeat()
    const owner = binding
    heartbeat = setTimer(() => {
      heartbeat = null
      void (async () => {
        if (!same(at) || !owner || binding !== owner || binding.callId !== id) return
        try {
          const call = await api.heartbeat(id)
          if (!same(at) || binding !== owner || binding.callId !== id) return
          lastHeartbeatAt = Date.now()
          apply(call)
          if (call.state === 'ending' || call.state === 'ended') {
            const connectionId = binding.id
            binding = null
            view.media = emptyImMediaSnapshot()
            void stopMedia(connectionId)
            emit()
            return
          }
        } catch (e) {
          if (!same(at) || binding !== owner) return
          if (
            [401, 403, 404, 409].includes((e as { status?: number }).status ?? 0) ||
            Date.now() - lastHeartbeatAt >= 30_000
          ) {
            await leave()
            return
          }
        }
        if (same(at) && binding?.callId === id) scheduleHeartbeat(at, id)
      })()
    }, 5000)
  }
  async function connect(call: ImCall, at: number) {
    const grant = await api.join(call.id)
    if (!same(at) || view.current?.id !== call.id) return
    const known =
      view.current?.id === call.id ? view.current : view.calls.find((c) => c.id === call.id)
    if (known && (known.state === 'ending' || known.state === 'ended' || !known.canJoin)) return
    await options.beforeConnect?.()
    if (
      !same(at) ||
      view.current?.id !== call.id ||
      ['ending', 'ended'].includes(view.current.state) ||
      !view.current.canJoin
    )
      return
    const latest = view.current.rev > grant.call.rev ? view.current : grant.call
    view.current = latest
    apply(latest)
    const target = { gen: at, callId: call.id, id: '' }
    binding = target
    const result = await media.connect({
      url: grant.url,
      token: grant.token,
      microphone: true,
      camera: call.mode === 'video',
    })
    if (!same(at) || binding !== target) {
      await stopMedia(result.connectionId)
      return
    }
    target.id = result.connectionId
    established = true
    lastHeartbeatAt = Date.now()
    view.media = result
    emit()
    scheduleHeartbeat(at, call.id)
  }
  async function run(operation: string, fn: (at: number) => Promise<void>, cleanupOnError = false) {
    if (view.busy) return
    const at = generation
    if (cleanupOnError) mediaIntent++
    view.busy = true
    view.error = null
    emit()
    try {
      await fn(at)
    } catch (e) {
      if (same(at)) {
        view.error = failure(e, operation)
        const call = cleanupOnError ? view.current : null,
          id = cleanupOnError ? ownedConnectionId() : ''
        if (cleanupOnError) {
          binding = null
          cancelHeartbeat()
          view.media = emptyImMediaSnapshot()
          await stopMedia(id)
        }
        if (same(at) && call?.canLeave) {
          try {
            const next = await api.leave(call.id)
            if (same(at)) apply(next)
          } catch {
            /* 心跳清理继续兜底。 */
          }
        }
      }
    } finally {
      if (same(at)) {
        view.busy = false
        emit()
      }
    }
  }
  async function start(roomId: number, mode: ImCallCreate['mode'], userIds?: number[]) {
    if (media.getSnapshot().state !== 'idle' || binding || cleanupId) {
      view.error = { code: 'BUSY', operation: 'create' }
      emit()
      return
    }
    return run(
      'create',
      async (at) => {
        const signature = JSON.stringify([roomId, mode, userIds ?? []])
        if (pendingCreate?.signature !== signature)
          pendingCreate = {
            signature,
            key:
              globalThis.crypto?.randomUUID?.() ??
              `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`,
          }
        const call = await api.create(roomId, {
          clientCallId: pendingCreate.key,
          mode,
          ...(userIds ? { userIds } : {}),
        })
        if (!same(at)) return
        pendingCreate = null
        view.current = call
        apply(call)
        await connect(call, at)
      },
      true,
    )
  }
  async function accept(call: ImCall) {
    if (media.getSnapshot().state !== 'idle' || binding || cleanupId) {
      view.error = { code: 'BUSY', operation: 'accept' }
      emit()
      return
    }
    return run(
      'accept',
      async (at) => {
        const next = await api.accept(call.id)
        if (!same(at)) return
        view.current = next
        apply(next)
        await connect(next, at)
      },
      true,
    )
  }
  async function join(call: ImCall) {
    if (media.getSnapshot().state !== 'idle' || binding || cleanupId) return
    return run(
      'join',
      async (at) => {
        view.current = call
        apply(call)
        await connect(call, at)
      },
      true,
    )
  }
  async function decline(call: ImCall) {
    return run('decline', async (at) => {
      const next = await api.decline(call.id)
      if (same(at)) apply(next)
    })
  }
  async function leave(end = false) {
    const call = view.current,
      id = ownedConnectionId()
    const at = ++generation
    mediaIntent++
    binding = null
    established = false
    cancelHeartbeat()
    view.current = null
    view.busy = false
    view.media = emptyImMediaSnapshot()
    emit()
    await stopMedia(id)
    if (!same(at) || !call) return
    try {
      const next =
        end && call.canEnd
          ? await api.end(call.id)
          : call.canLeave
            ? await api.leave(call.id)
            : call
      if (same(at)) {
        apply(next)
        emit()
      }
    } catch (e) {
      if (same(at) && !view.current) {
        view.error = failure(e, 'leave')
        emit()
      }
    }
  }
  /** 恢复的发起者仍可结束已知通话；结束其它通话不能退役本端正在使用的媒体。 */
  async function end(call = view.current) {
    if (!call?.canEnd) return
    if (call.id === view.current?.id) return leave(true)
    return run('end', async (at) => {
      const next = await api.end(call.id)
      if (same(at)) apply(next)
    })
  }
  const off = media.subscribe((event) => {
    if (!binding && cleanupId && event.snapshot.connectionId === cleanupId) {
      if (event.snapshot.state === 'idle') {
        cleanupId = ''
        view.media = emptyImMediaSnapshot()
      } else
        view.media = { ...emptyImMediaSnapshot(), connectionId: cleanupId, state: 'disconnecting' }
      if (event.error) view.error = event.error
      emit()
      return
    }
    const current = binding
    if (!current || !same(current.gen) || view.current?.id !== current.callId) return
    if (!current.id && event.snapshot.state === 'connecting')
      current.id = event.snapshot.connectionId
    if (event.snapshot.connectionId !== current.id) return
    if (event.snapshot.state === 'connected') established = true
    view.media = event.snapshot
    if (
      event.snapshot.state === 'idle' &&
      (established || options.leaveOnMediaDisconnect === false)
    ) {
      if (options.leaveOnMediaDisconnect !== false) void leave()
      else {
        // Web 同 sid 的后继标签页可能已经接管；被动断开只退役本地，不结束后继的业务租约。
        const id = current.id
        mediaIntent++
        binding = null
        established = false
        cancelHeartbeat()
        view.current = null
        view.media = emptyImMediaSnapshot()
        view.error = { code: 'DISCONNECTED', operation: 'connect' }
        void stopMedia(id)
        emit()
      }
      return
    }
    if (event.error) view.error = event.error
    emit()
  })
  function dispose() {
    reset()
    disposed = true
    off()
  }
  return {
    get view() {
      return view
    },
    refresh,
    onHint,
    start,
    accept,
    join,
    decline,
    leave: () => leave(false),
    end,
    reset,
    retryDisconnect,
    dispose,
  }
}
