import type { LookupAddress } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import type { LookupFunction } from 'node:net'
import { Readable, Transform } from 'node:stream'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { assertPublicHost } from '../../net/net-guard.js'
import { WEB_FETCH_USER_AGENT } from '../web/safe-fetcher.js'

/** Longest wait for a response's status line and headers. */
export const MCP_HEADERS_TIMEOUT_MS = 15_000
/** Longest silence inside a response body (not counted while an elicitation waits for the user). */
export const MCP_IDLE_TIMEOUT_MS = 60_000
/** Bytes one response may carry; past it the response fails as `too_large`. */
export const MCP_RESPONSE_MAX_BYTES = 1024 * 1024

/** A refused or failed outbound request; `reason` is a short safe code, never anything from the remote end. */
export class McpNetFailure extends Error {
  constructor(readonly reason: string) {
    super(`mcp request failed: ${reason}`)
    this.name = 'McpNetFailure'
  }
}

export interface GuardedFetchOptions {
  /** the server may sit on a private address (root marked it, or the deployment lifts the check) */
  allowPrivate: boolean
  /** told the safe reason of every failure (refusal, timeout, size, HTTP status >= 400) */
  onFailure?: (reason: string) => void
  /** while true the body silence timer is held (an elicitation waits for the user) */
  paused?: () => boolean
  headersTimeoutMs?: number
  idleTimeoutMs?: number
  maxBytes?: number
}

/** net/tls 的 lookup：只返回已检查的地址，按调用方要求的形状（连接钉在检查过的地址上，防 DNS 重绑定）。 */
const pinnedLookup =
  (addrs: LookupAddress[]): LookupFunction =>
  (_hostname, options, callback) => {
    const list = options.family ? addrs.filter((a) => a.family === options.family) : addrs
    const first = list[0]
    if (!first) callback(new Error('no vetted address'), '', 4)
    else if (options.all) callback(null, list)
    else callback(null, first.address, first.family)
  }

/** 请求体只接受字符串与表单（SDK 发 JSON 文本，OAuth 取令牌发表单），其他形状视为程序错误。 */
function bodyText(body: RequestInit['body']): string | undefined {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return body
  if (body instanceof URLSearchParams) return body.toString()
  throw new McpNetFailure('body')
}

/**
 * 外部 MCP 服务器的出站 fetch（交给 SDK 传输层与 OAuth 取令牌，防 SSRF，see docs/design-notes.md#security）：
 * 只允许 http/https、不带 URL 凭据；先解析主机名的全部地址，除非 `allowPrivate`，任一不是公网地址就拒绝，
 * 并把连接钉在这些已检查的地址上；不自动跟随重定向（SDK 只跟同源重定向，再次经过这里重新检查）；
 * 等响应头有超时，正文有静默超时与大小上限。失败只给出简短原因码，不回显远端内容。
 */
export function guardedFetch(o: GuardedFetchOptions): FetchLike {
  const headersTimeoutMs = o.headersTimeoutMs ?? MCP_HEADERS_TIMEOUT_MS
  const idleTimeoutMs = o.idleTimeoutMs ?? MCP_IDLE_TIMEOUT_MS
  const maxBytes = o.maxBytes ?? MCP_RESPONSE_MAX_BYTES
  const fail = (reason: string) => {
    o.onFailure?.(reason)
    return new McpNetFailure(reason)
  }

  return async (input, init = {}) => {
    let url: URL
    try {
      url = new URL(String(input))
    } catch {
      throw fail('url')
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password)
      throw fail('url')
    const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
    let addrs: LookupAddress[]
    try {
      // 端口不限（MCP 服务器常用自定义端口），地址按公网规则检查
      addrs = await assertPublicHost(url.hostname, port, {
        ports: [port],
        allowPrivate: o.allowPrivate,
      })
    } catch {
      throw fail('address')
    }
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((v, k) => (headers[k] = v))
    headers['user-agent'] = WEB_FETCH_USER_AGENT
    headers['accept-encoding'] = 'identity'
    const body = bodyText(init.body)
    if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body))
    const ctl = new AbortController()
    const signal = init.signal ? AbortSignal.any([init.signal, ctl.signal]) : ctl.signal
    let failed: McpNetFailure | undefined
    const stop = (reason: string) => {
      failed ??= fail(reason)
      ctl.abort(failed)
    }
    const client = url.protocol === 'https:' ? https : http

    return new Promise<Response>((resolve, reject) => {
      const headersTimer = setTimeout(() => stop('timeout'), headersTimeoutMs)
      const req = client.request(
        {
          method: init.method ?? 'GET',
          protocol: url.protocol,
          hostname: url.hostname.replace(/^\[(.*)\]$/, '$1'),
          port: url.port || undefined,
          path: `${url.pathname}${url.search}`,
          headers,
          // 不复用连接池：每个套接字都用钉住的地址新开
          agent: false,
          lookup: pinnedLookup(addrs),
          signal,
        },
        (res) => {
          clearTimeout(headersTimer)
          const status = res.statusCode ?? 0
          // 可选的 GET 事件流被拒（405 等）是正常情况，不算失败原因
          if (status >= 400 && (init.method ?? 'GET') !== 'GET') o.onFailure?.(`http_${status}`)
          let size = 0
          let idle: NodeJS.Timeout | undefined
          // 正文静默超时：等用户回答 elicitation 时暂停计时（服务器此时本来就不发数据）
          const arm = () => {
            clearTimeout(idle)
            idle = setTimeout(() => (o.paused?.() ? arm() : stop('timeout')), idleTimeoutMs)
          }
          const capped = new Transform({
            transform(chunk: Buffer, _enc, cb) {
              arm()
              size += chunk.length
              if (size > maxBytes) {
                stop('too_large')
                cb(failed)
              } else cb(null, chunk)
            },
          })
          arm()
          res.on('error', (e) => capped.destroy(failed ?? e))
          capped.on('close', () => {
            clearTimeout(idle)
            res.destroy()
          })
          res.pipe(capped)
          const h = new Headers()
          for (const [k, v] of Object.entries(res.headers))
            if (typeof v === 'string') h.set(k, v)
            else if (Array.isArray(v)) h.set(k, v.join(', '))
          const empty = status === 204 || status === 205 || status === 304 || init.method === 'HEAD'
          if (empty) capped.destroy()
          resolve(
            new Response(empty ? null : (Readable.toWeb(capped) as ReadableStream<Uint8Array>), {
              status: status < 200 || status > 599 ? 502 : status,
              headers: h,
            }),
          )
        },
      )
      req.on('error', (e) => {
        clearTimeout(headersTimer)
        // 调用方中止原样抛出；我们自己的超时 / 上限给出原因码；其余一律 network
        if (failed) reject(failed)
        else if (init.signal?.aborted) reject(e)
        else reject(fail('network'))
      })
      req.end(body)
    })
  }
}
