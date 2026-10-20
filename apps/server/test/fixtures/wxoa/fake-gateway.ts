// A stand-in for WxoaGateway in e2e specs: `Test.createTestingModule({ imports: [AppModule] })
// .overrideProvider(WxoaGateway).useValue(fake.gateway)`. Answers are registered by path (the QR code
// image by `qrImage`) and taken in order, the last one repeating; every call is recorded. A path without
// an answer throws, so a spec notices a call it did not expect.
import type {
  WxoaBinary,
  WxoaCall,
  WxoaCaller,
  WxoaGateway,
  WxoaJson,
  WxoaUploadFile,
} from '../../../src/modules/platform/wxoa/core/wxoa-gateway.js'

export interface FakeWxoaCall {
  method: 'json' | 'upload' | 'download' | 'qrImage'
  /** the API path, `qrImage` for a QR code image */
  path: string
  /** the calling account's id; null for `qrImage` */
  accountId: number | null
  query?: Record<string, string | number>
  body?: unknown
  maxBytes?: number
  file?: WxoaUploadFile
  fields?: Record<string, string>
  /** `qrImage`'s ticket */
  ticket?: string
}

/** A JSON or binary answer, an error to throw (e.g. a BizError), or a function of the call giving one. */
export type FakeWxoaAnswer =
  | WxoaJson
  | WxoaBinary
  | Error
  | ((call: FakeWxoaCall) => WxoaJson | WxoaBinary | Error | Promise<WxoaJson | WxoaBinary>)

export function fakeWxoaGateway() {
  const calls: FakeWxoaCall[] = []
  const answers = new Map<string, FakeWxoaAnswer[]>()

  async function answer(call: FakeWxoaCall): Promise<unknown> {
    calls.push(call)
    const queue = answers.get(call.path)
    if (!queue?.length) throw new Error(`fake wxoa gateway: no answer for ${call.path}`)
    const next = queue.length > 1 ? queue.shift()! : queue[0]!
    const value = typeof next === 'function' ? await next(call) : next
    if (value instanceof Error) throw value
    return value
  }

  const gateway = {
    json: <T extends WxoaJson = WxoaJson>(account: WxoaCaller, path: string, call: WxoaCall = {}) =>
      answer({ method: 'json', path, accountId: account.id, ...call }) as Promise<T>,
    upload: (
      account: WxoaCaller,
      path: string,
      file: WxoaUploadFile,
      call: Pick<WxoaCall, 'query'> & { fields?: Record<string, string> } = {},
    ) =>
      answer({ method: 'upload', path, accountId: account.id, file, ...call }) as Promise<WxoaJson>,
    download: (account: WxoaCaller, path: string, call: WxoaCall = {}) =>
      answer({ method: 'download', path, accountId: account.id, ...call }) as Promise<WxoaBinary>,
    qrImage: (ticket: string) =>
      answer({
        method: 'qrImage',
        path: 'qrImage',
        accountId: null,
        ticket,
      }) as Promise<WxoaBinary>,
  } satisfies Pick<WxoaGateway, 'json' | 'upload' | 'download' | 'qrImage'>

  return {
    gateway,
    calls,
    /** Answers the calls to `path` with `list` in order; the last one repeats. Replaces earlier answers. */
    on(path: string, ...list: FakeWxoaAnswer[]) {
      answers.set(path, list)
    },
    /** The recorded calls to `path`. */
    callsTo: (path: string) => calls.filter((c) => c.path === path),
    /** Forgets every answer and call. */
    reset() {
      calls.length = 0
      answers.clear()
    },
  }
}

export type FakeWxoaGateway = ReturnType<typeof fakeWxoaGateway>
