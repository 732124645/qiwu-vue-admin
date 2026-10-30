// Agent provider concurrency slots (see docs/agent.md#配置模型): a counting semaphore over a Redis sorted
// set shared by every process, leases that expire unless renewed, waiting with an abort signal or a
// maximum wait (also for calls carrying a signal); the chat model wrapper releases its slot exactly
// once on every path.
import { setTimeout as sleep } from 'node:timers/promises'
import { Test, type TestingModule } from '@nestjs/testing'
import { Err } from '@qiwu/shared'
import type { ChatEvent, ChatModel } from '../../src/core/agent/provider/chat-model.js'
import { FakeChatModel } from '../../src/core/agent/provider/fake-chat-model.js'
import {
  ProviderSlots,
  type SlotRelease,
  withProviderSlot,
} from '../../src/core/agent/provider/provider-slots.js'
import { CoreConfigModule } from '../../src/core/config/config.module.js'
import { BizError } from '../../src/core/http/biz-error.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { CoreRedisModule, REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { cleanRedis } from '../setup/redis.js'

let moduleRef: TestingModule
let redis: Redis
let seq = 9_000_000
const provider = () => ++seq
const held = (id: number) => redis.zCard(redisKey('lock', 'agent-provider', id))
/** a second instance on the same Redis, as another process would have */
const instance = () => new ProviderSlots(redis)
const caught = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e,
  )

beforeAll(async () => {
  moduleRef = await Test.createTestingModule({
    imports: [CoreConfigModule.forRoot(), CoreRedisModule],
  }).compile()
  redis = moduleRef.get(REDIS)
  await cleanRedis(redis)
})

afterAll(async () => {
  if (redis) await cleanRedis(redis)
  await moduleRef?.close()
})

describe('ProviderSlots', () => {
  it('limit 2: the third waits and gets the slot after a release; two instances share the count', async () => {
    const id = provider()
    const a = instance()
    const b = instance()
    const r1 = await a.acquire(id, 2)
    const r2 = await b.acquire(id, 2)
    expect(await held(id)).toBe(2)
    let got = false
    const third = a.acquire(id, 2).then((r) => ((got = true), r))
    await sleep(300)
    expect(got).toBe(false)
    await r2()
    const r3 = await third
    expect(await held(id)).toBe(2)
    await Promise.all([r1(), r3(), r3()])
    expect(await held(id)).toBe(0)
  })

  it('an expired lease frees its slot while another holder keeps renewing; renewal keeps a long holder', async () => {
    const id = provider()
    const keeper = instance()
    keeper.ttlMs = 400
    keeper.renewMs = 100
    const kept = await keeper.acquire(id, 2)
    const crashed = instance()
    crashed.ttlMs = 300
    crashed.renewMs = 60_000
    await crashed.acquire(id, 2)
    expect(await held(id)).toBe(2)
    // 另一个持有者一直续期，整个键不会过期：只能靠清掉到期的租约空出名额
    const next = instance()
    next.maxWaitMs = 2000
    const r = await next.acquire(id, 2)
    expect(await held(id)).toBe(2)
    await r()

    await sleep(900)
    const waiter = instance()
    waiter.maxWaitMs = 200
    const e = await caught(waiter.acquire(id, 1))
    expect((e as BizError).err.code).toBe(Err.AGENT_PROVIDER_FAILED.code)
    await kept()
    expect(await held(id)).toBe(0)
  })

  it('without a slot within the maximum wait: provider_busy, distinct from the endpoint 429', async () => {
    const id = provider()
    const slots = instance()
    const r = await slots.acquire(id, 1)
    slots.maxWaitMs = 250
    const started = Date.now()
    const e = await caught(slots.acquire(id, 1))
    expect(Date.now() - started).toBeGreaterThanOrEqual(240)
    expect(e).toBeInstanceOf(BizError)
    expect((e as BizError).err).toMatchObject({
      code: Err.AGENT_PROVIDER_FAILED.code,
      key: 'error.agent.provider_busy',
    })
    expect((e as BizError).params).toEqual({ reason: 'provider_busy' })
    expect(await held(id)).toBe(1)
    await r()
  })

  it('a call with a signal that never aborts still gives up at the maximum wait', async () => {
    const id = provider()
    const slots = instance()
    const r = await slots.acquire(id, 1)
    slots.maxWaitMs = 250
    const e = await caught(slots.acquire(id, 1, new AbortController().signal))
    expect((e as BizError).params).toEqual({ reason: 'provider_busy' })
    await r()
  })

  it('abort while waiting rejects promptly with the signal reason and leaves no lease', async () => {
    const id = provider()
    const slots = instance()
    const r = await slots.acquire(id, 1)
    const ctrl = new AbortController()
    const why = new Error('stopped by the user')
    const waiting = caught(slots.acquire(id, 1, ctrl.signal))
    await sleep(150)
    const at = Date.now()
    ctrl.abort(why)
    expect(await waiting).toBe(why)
    expect(Date.now() - at).toBeLessThan(200)
    expect(await held(id)).toBe(1)
    await r()
    expect(await held(id)).toBe(0)
  })
})

describe('withProviderSlot', () => {
  /** a taker that counts acquisitions and releases (each release counted only once) */
  function taker() {
    const n = { taken: 0, released: 0, calls: 0 }
    const take = async (): Promise<SlotRelease> => {
      n.taken++
      let done = false
      return async () => {
        n.calls++
        if (!done) n.released++
        done = true
      }
    }
    return { n, take }
  }
  const ask = (signal?: AbortSignal) => ({ model: 'm', messages: [], signal })

  it('releases once after a complete() answer and after a failure', async () => {
    const { n, take } = taker()
    const chat = withProviderSlot(
      new FakeChatModel([{ text: 'ok' }, { error: new Error('boom') }]),
      take,
    )
    expect((await chat.complete(ask())).text).toBe('ok')
    expect(n).toMatchObject({ taken: 1, released: 1, calls: 1 })
    expect(await caught(chat.complete(ask()))).toMatchObject({ message: 'boom' })
    expect(n).toMatchObject({ taken: 2, released: 2, calls: 2 })
  })

  it('holds the slot for the whole stream; releases when consumed, stopped early or aborted', async () => {
    const { n, take } = taker()
    const chat = withProviderSlot(
      new FakeChatModel([{ text: 'a b c' }, { text: 'a b c' }, { text: 'a b c' }]),
      take,
    )
    const it1 = chat.stream(ask())[Symbol.asyncIterator]()
    await it1.next()
    expect(n).toMatchObject({ taken: 1, released: 0 })
    for (let e = await it1.next(); !e.done; e = await it1.next());
    expect(n).toMatchObject({ taken: 1, released: 1, calls: 1 })

    for await (const e of chat.stream(ask())) if ((e as ChatEvent).type === 'text') break
    expect(n).toMatchObject({ taken: 2, released: 2, calls: 2 })

    const ctrl = new AbortController()
    const it3 = chat.stream(ask(ctrl.signal))[Symbol.asyncIterator]()
    await it3.next()
    ctrl.abort(new Error('stop'))
    expect(await caught(it3.next())).toMatchObject({ message: 'stop' })
    expect(n).toMatchObject({ taken: 3, released: 3, calls: 3 })
  })

  it('reports waiting before the slot and holding after it; a failed acquisition reports only waiting', async () => {
    const { take } = taker()
    const seen: boolean[] = []
    const onSlot = (held: boolean) => seen.push(held)
    const chat = withProviderSlot(new FakeChatModel([{ text: 'ok' }]), take)
    const pending = chat.complete({ ...ask(), onSlot })
    // 同步回报：等名额期间结束的调用一定已标成没发出
    expect(seen).toEqual([false])
    await pending
    expect(seen).toEqual([false, true])
    seen.length = 0
    const busy = withProviderSlot(new FakeChatModel([]), () => Promise.reject(new Error('busy')))
    await caught(busy.complete({ ...ask(), onSlot }))
    expect(seen).toEqual([false])
  })

  it('a failed acquisition never calls the model', async () => {
    const inner: ChatModel = {
      stream: vi.fn<ChatModel['stream']>(),
      complete: vi.fn<ChatModel['complete']>(),
    }
    const chat = withProviderSlot(inner, () => Promise.reject(new Error('busy')))
    expect(await caught(chat.complete(ask()))).toMatchObject({ message: 'busy' })
    expect(inner.complete).not.toHaveBeenCalled()
  })
})
