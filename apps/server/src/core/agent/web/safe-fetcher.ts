import dns, { type LookupAddress } from 'node:dns'
import http, { type IncomingMessage } from 'node:http'
import https from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import type { Readable } from 'node:stream'
import zlib from 'node:zlib'
import { Err } from '@qiwu/shared'
import { BizError } from '../../http/biz-error.js'
import { isBlockedAddress } from '../../net/net-guard.js'

/** The whole fetch (DNS, connect, redirects, body) ends after this. */
export const WEB_FETCH_TIMEOUT_MS = 15_000
/** Body bytes read (after decompression); reading stops there and the page is marked truncated. */
export const WEB_FETCH_MAX_BYTES = 2 * 1024 * 1024
export const WEB_FETCH_MAX_REDIRECTS = 5
/** Sent on every request; nothing else identifies the system (no cookies, no credentials). */
export const WEB_FETCH_USER_AGENT = 'QiwuAgent/1.0 (+https://github.com/732124645/qiwu-vue-admin)'
const ACCEPTED_TYPES = new Set([
  'text/html',
  'text/plain',
  'application/json',
  'application/xhtml+xml',
])
const REDIRECTS = new Set([301, 302, 303, 307, 308])

export interface SafeFetchOptions {
  /** may reach private addresses too (external MCP servers a platform admin marked so); default false */
  allowPrivate?: boolean
  /** the caller's stop (a cancelled or paused turn): aborting it ends the fetch at once */
  signal?: AbortSignal
}

export interface SafeFetchResult {
  /** the URL after redirects */
  url: string
  status: number
  /** the media type without parameters (`text/html`) */
  contentType: string
  /** the body decoded by its charset, at most {@link WEB_FETCH_MAX_BYTES} */
  body: string
  truncated: boolean
}

/** Test seams: DNS and the address rule (tests answer names locally), limits. */
export interface SafeFetcherDeps {
  resolve?: (host: string) => Promise<LookupAddress[]>
  isBlocked?: (address: string) => boolean
  timeoutMs?: number
  maxBytes?: number
  /** the deployment lifts the address check (`ALLOW_PRIVATE_ENDPOINTS`, tests and dev only) */
  allowPrivate?: boolean
}

/** A URL the agent may not read (scheme, credentials, an inner address): the model is told so. */
const refused = (reason: string) => new BizError(Err.AGENT_URL_NOT_ALLOWED, { reason })
/** A page that could not be read (timeout, status, type, network); nothing from the remote end in it. */
const failed = (reason: string) => new BizError(Err.AGENT_WEB_FAILED, { reason })

/**
 * 为智能体读取网页的出站请求（防 SSRF，see docs/design-notes.md#security）：只 GET http/https；
 * 自己解析主机名的全部地址，任一不是公网地址就拒绝，并把连接钉在这些已检查的地址上（自定义 lookup，
 * 不再二次解析），所以 DNS 重绑定换不了地址；每次重定向都重新检查；总超时、正文大小与类型都有上限。
 * 不带 Cookie、代理或任何系统凭据，只发固定的 User-Agent。
 */
export class SafeFetcher {
  private readonly resolve: (host: string) => Promise<LookupAddress[]>
  private readonly isBlocked: (address: string) => boolean
  private readonly timeoutMs: number
  private readonly maxBytes: number
  private readonly allowPrivate: boolean

  constructor(deps: SafeFetcherDeps = {}) {
    this.resolve =
      deps.resolve ?? ((host) => dns.promises.lookup(host, { all: true, verbatim: true }))
    this.isBlocked = deps.isBlocked ?? isBlockedAddress
    this.timeoutMs = deps.timeoutMs ?? WEB_FETCH_TIMEOUT_MS
    this.maxBytes = deps.maxBytes ?? WEB_FETCH_MAX_BYTES
    this.allowPrivate = deps.allowPrivate ?? false
  }

  /**
   * 读取 `url`（最多跟随 {@link WEB_FETCH_MAX_REDIRECTS} 次重定向，每跳都重新校验地址）。
   * 地址或协议不允许 → AGENT_URL_NOT_ALLOWED；超时、非 2xx、类型不支持、网络错误 → AGENT_WEB_FAILED。
   * 调用方的 `signal` 与总超时中止同一个请求（原因 `cancelled`）。
   */
  async fetch(url: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
    const allowPrivate = this.allowPrivate || opts.allowPrivate === true
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs)
    const outer = opts.signal
    const stop = () => ctl.abort()
    if (outer?.aborted) ctl.abort()
    else outer?.addEventListener('abort', stop, { once: true })
    try {
      let current = parseTarget(url)
      for (let hop = 0; ; hop++) {
        const res = await this.request(current, allowPrivate, ctl.signal)
        const status = res.statusCode ?? 0
        const location = res.headers.location
        if (REDIRECTS.has(status) && location) {
          res.destroy()
          if (hop >= WEB_FETCH_MAX_REDIRECTS) throw failed('too_many_redirects')
          // 重定向目标与起点同样校验（协议、凭据、地址），相对地址按当前 URL 解析
          current = parseTarget(location, current)
          continue
        }
        return await this.read(res, current, ctl.signal)
      }
    } catch (err) {
      if (outer?.aborted) throw failed('cancelled')
      if (err instanceof BizError) throw err
      throw failed(ctl.signal.aborted ? 'timeout' : 'network')
    } finally {
      clearTimeout(timer)
      outer?.removeEventListener('abort', stop)
    }
  }

  /** 主机名的全部地址；任一地址非公网（或解析失败、无结果）即拒绝。IP 字面量按它自身检查。 */
  private async vet(hostname: string, allowPrivate: boolean, signal: AbortSignal) {
    const bare = hostname.replace(/^\[(.*)\]$/, '$1')
    const family = isIP(bare)
    const addrs: LookupAddress[] = family
      ? [{ address: bare, family }]
      : await abortable(this.resolve(bare), signal).catch((err: unknown) => {
          if (signal.aborted) throw err
          throw refused('dns')
        })
    // 混合应答（公网 + 内网）也拒绝：连接时可能选到其中任何一个
    if (!addrs.length || (!allowPrivate && addrs.some((a) => this.isBlocked(a.address))))
      throw refused('address')
    return { host: bare, addrs }
  }

  /** 发出一跳 GET：连接只走 {@link vet} 检查过的地址。 */
  private async request(url: URL, allowPrivate: boolean, signal: AbortSignal) {
    const { host, addrs } = await this.vet(url.hostname, allowPrivate, signal)
    const client = url.protocol === 'https:' ? https : http
    return new Promise<IncomingMessage>((resolve, reject) => {
      const req = client.request(
        {
          method: 'GET',
          protocol: url.protocol,
          hostname: host,
          port: url.port || undefined,
          path: `${url.pathname}${url.search}`,
          headers: {
            'user-agent': WEB_FETCH_USER_AGENT,
            accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.1',
            'accept-encoding': 'gzip, deflate, br',
          },
          // 不复用连接池：每个请求的套接字都是用钉住的地址新开的
          agent: false,
          lookup: pinnedLookup(addrs),
          signal,
        },
        resolve,
      )
      req.on('error', reject)
      req.end()
    })
  }

  /** 校验状态与类型，按上限读取（解压后计数）并按字符集解码。 */
  private async read(res: IncomingMessage, url: URL, signal: AbortSignal) {
    const status = res.statusCode ?? 0
    const [mime = '', ...params] = String(res.headers['content-type'] ?? '').split(';')
    const contentType = mime.trim().toLowerCase()
    if (status < 200 || status >= 300) {
      res.destroy()
      throw failed('status')
    }
    if (!ACCEPTED_TYPES.has(contentType)) {
      res.destroy()
      throw failed('content_type')
    }
    const stream = decoded(res)
    const chunks: Buffer[] = []
    let size = 0
    let truncated = false
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        if (signal.aborted) throw failed('timeout')
        chunks.push(chunk)
        size += chunk.length
        if (size > this.maxBytes) {
          truncated = true
          break
        }
      }
    } finally {
      res.destroy()
      stream.destroy()
    }
    const buf = Buffer.concat(chunks).subarray(0, this.maxBytes)
    const charset = params
      .map((p) => /^\s*charset\s*=\s*\x22?([\w.:-]+)\x22?/i.exec(p)?.[1])
      .find(Boolean)
    return {
      url: url.href,
      status,
      contentType,
      body: decodeText(buf, charset ?? sniffCharset(buf, contentType)),
      truncated,
    }
  }
}

/** 只接受 http/https、不带用户名密码的 URL（凭据会被当成 Basic 认证发出）。 */
function parseTarget(raw: string, base?: URL): URL {
  let url: URL
  try {
    url = new URL(raw, base)
  } catch {
    throw refused('url')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw refused('scheme')
  if (url.username || url.password) throw refused('credentials')
  return url
}

/** net/tls 的 lookup：只返回已检查的地址，按调用方要求的形状。 */
const pinnedLookup =
  (addrs: LookupAddress[]): LookupFunction =>
  (_hostname, options, callback) => {
    const list = options.family ? addrs.filter((a) => a.family === options.family) : addrs
    const first = list[0]
    if (!first) callback(new Error('no vetted address'), '', 4)
    else if (options.all) callback(null, list)
    else callback(null, first.address, first.family)
  }

/** `p`，或在 `signal` 中止时失败（DNS 查询本身无法取消）。 */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'))
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/** 按 Content-Encoding 解压；上限按解压后的字节计算（防压缩炸弹）。 */
function decoded(res: IncomingMessage): Readable {
  const encoding = String(res.headers['content-encoding'] ?? '')
    .trim()
    .toLowerCase()
  const decoder =
    encoding === 'gzip' || encoding === 'x-gzip'
      ? zlib.createGunzip()
      : encoding === 'deflate'
        ? zlib.createInflate()
        : encoding === 'br'
          ? zlib.createBrotliDecompress()
          : null
  if (!decoder) return res
  res.on('error', (err) => decoder.destroy(err))
  return res.pipe(decoder)
}

/** 头里没写字符集时，HTML 看前 4 KB 里的 `<meta charset>`（国内站点常见 GBK）。 */
function sniffCharset(buf: Buffer, contentType: string): string | undefined {
  if (!contentType.includes('html')) return undefined
  return /<meta[^>]+charset\s*=\s*[\x22\x27]?\s*([\w.:-]+)/i.exec(
    buf.subarray(0, 4096).toString('latin1'),
  )?.[1]
}

function decodeText(buf: Buffer, charset = 'utf-8'): string {
  try {
    return new TextDecoder(charset).decode(buf)
  } catch {
    // 不认识的字符集名按 UTF-8
    return new TextDecoder().decode(buf)
  }
}
