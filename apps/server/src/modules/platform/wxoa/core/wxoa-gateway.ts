import { randomBytes } from 'node:crypto'
import https from 'node:https'
import { isIP } from 'node:net'
import { forwardRef, Inject, Injectable } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { Err, type ErrorDef, type WxoaAccountKind } from '@qiwu/shared'
import { fileTypeFromBuffer } from 'file-type'
import type { DataSource } from 'typeorm'
import { AppConfigService } from '../../../../core/config/config.module.js'
import { SecretBox } from '../../../../core/crypto/secret-box.js'
import { BizError } from '../../../../core/http/biz-error.js'
import { tenantId } from '../../../../core/context/tenant.js'
import { guardedAgents } from '../../../../core/net/net-guard.js'
import { WxoaTokenService } from './wxoa-token.js'

/** The account a WeChat call acts for; its access token is looked up by `id`. */
export interface WxoaCaller {
  id: number
  appId: string
  accountKind: WxoaAccountKind
  tenantId?: number
  /**
   * 只用于新建账号前的归属证明（`WxoaTokenService.prove`）：提交的 AppSecret，不落库、不缓存；给了就不再
   * 从库里读，此时 `id` 为 0
   */
  appSecret?: string
}

/** A JSON answer of WeChat (`errcode` 0 or none: any other errcode is thrown as an own error code). */
export type WxoaJson = Record<string, unknown>

export interface WxoaCall {
  /** query parameters besides `access_token`, which the gateway adds itself */
  query?: Record<string, string | number>
  /** sent as a JSON POST; none → GET */
  body?: unknown
  /** answer cap in bytes: 1 MiB unless given (binary answers 10 MiB), never over 10 MiB */
  maxBytes?: number
}

/** A file sent as the `media` part of a multipart upload. */
export interface WxoaUploadFile {
  name: string
  mime: string
  data: Buffer
}

/** A binary answer (media, QR code images): at most 10 MiB, its type matching its magic number. */
export interface WxoaBinary {
  data: Buffer
  mime: string
  /** from `Content-Disposition`, when WeChat sent one */
  fileName: string | null
}

const API_HOST = 'api.weixin.qq.com'
const QR_HOST = 'mp.weixin.qq.com'
const MIB = 1024 * 1024
const JSON_CAP = MIB
const MAX_CAP = 10 * MIB
/** an API path: segments of letters, digits, `_` and `-` (no query, no host, no `..`) */
const API_PATH = /^(\/[\w-]+)+$/

/** The access token API: called by WxoaTokenService only. */
export const WXOA_STABLE_TOKEN = '/cgi-bin/stable_token'

/**
 * The calls signed by the AppSecret instead of a token: the only requests that ever carry it. Their
 * query and body are fixed here (the caller's are ignored), so `force_refresh` is never sent true and
 * the secret goes nowhere else. `clear_quota/v2` documents it in the body but shows it in the query:
 * both carry it.
 */
const BY_SECRET = new Map<
  string,
  (appid: string, secret: string) => Pick<WxoaCall, 'query' | 'body'>
>([
  [
    WXOA_STABLE_TOKEN,
    (appid, secret) => ({
      body: { grant_type: 'client_credential', appid, secret, force_refresh: false },
    }),
  ],
  [
    '/cgi-bin/clear_quota/v2',
    (appid, appsecret) => ({ query: { appid, appsecret }, body: { appid, appsecret } }),
  ],
])

/** A refused access token (invalid, expired, malformed): dropped, fetched again, the call made once more. */
const STALE_TOKEN = new Set([40001, 42001, 40014])
const IP_REFUSED = new Set([40164, 61004])
const ERRCODES = new Map<number, ErrorDef>([
  ...[...STALE_TOKEN, 40013, 40125].map((c) => [c, Err.WXOA_CREDENTIAL_INVALID] as const),
  ...[48001, 50001, 50002].map((c) => [c, Err.WXOA_API_UNAUTHORIZED] as const),
  [45009, Err.WXOA_QUOTA_EXCEEDED],
  ...[45015, 45047].map((c) => [c, Err.WXOA_SEND_WINDOW] as const),
])

/**
 * WeChat's `errcode` as an own error: nothing of the answer in it but the code of an unmapped one and,
 * for an IP allow-list refusal, the first well-formed IP address of `errmsg`.
 */
export function upstreamError(errcode: number, errmsg = ''): BizError {
  if (IP_REFUSED.has(errcode))
    return new BizError(Err.WXOA_IP_NOT_ALLOWED, {
      ip: errmsg.split(/[\s,;]+/).find((part) => isIP(part) !== 0) ?? '',
    })
  const def = ERRCODES.get(errcode)
  return def ? new BizError(def) : new BizError(Err.WXOA_UPSTREAM_REFUSED, { errcode })
}

class StaleToken extends Error {}

/** A mass send whose `clientmsgid` WeChat already took: its answer carries the earlier `msg_id`. */
const CLIENT_MSG_ID_EXISTS = 45065

/**
 * The answer when its errcode is 0 or absent; a refused token as {@link StaleToken} when `byToken`.
 * A 45065 with a `msg_id` is the earlier send of a retried mass job: its answer, so the job records it.
 */
function ok(json: WxoaJson, byToken: boolean): WxoaJson {
  const code = Number(json.errcode ?? 0)
  if (code === 0) return json
  if (code === CLIENT_MSG_ID_EXISTS && json.msg_id !== undefined && json.msg_id !== null)
    return json
  if (!Number.isInteger(code)) throw new BizError(Err.WXOA_UPSTREAM)
  if (byToken && STALE_TOKEN.has(code)) throw new StaleToken()
  throw upstreamError(code, typeof json.errmsg === 'string' ? json.errmsg : '')
}

/** A JSON object, integers past 2^53 kept as their digits (64-bit msgids); else null. */
function parseJson(data: Buffer): WxoaJson | null {
  try {
    const value: unknown = JSON.parse(
      data.toString('utf8'),
      (_key, v: unknown, ctx?: { source?: string }) =>
        typeof v === 'number' && !Number.isSafeInteger(v) && /^-?\d+$/.test(ctx?.source ?? '')
          ? ctx!.source
          : v,
    )
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as WxoaJson) : null
  } catch {
    return null
  }
}

// NaN or 0 is the default: a cap that compares false would read without end
const capOf = (maxBytes: number | undefined, fallback: number) =>
  Math.min(maxBytes || fallback, MAX_CAP)

const checkPath = (path: string) => {
  if (!API_PATH.test(path)) throw new Error('WxoaGateway: not an API path')
}

const TYPE_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'audio/mp3': 'audio/mpeg',
  'video/mpeg4': 'video/mp4',
}

interface Answer {
  data: Buffer
  /** `Content-Type` */
  type: string
  /** `Content-Disposition` */
  disposition: string
}

/**
 * A binary answer: an image, audio or video by its magic number, its declared type (when one is given)
 * the same; a JSON answer instead is its errcode's error, anything else C1002.
 */
async function binary(answer: Answer, byToken: boolean): Promise<WxoaBinary> {
  const sniffed = await fileTypeFromBuffer(answer.data)
  if (!sniffed) {
    const json = parseJson(answer.data)
    if (json) ok(json, byToken)
    throw new BizError(Err.STORAGE_TYPE_REJECTED)
  }
  const declared = answer.type.split(';')[0]!.trim().toLowerCase()
  if (
    !/^(image|audio|video)\//.test(sniffed.mime) ||
    (declared &&
      declared !== 'application/octet-stream' &&
      (TYPE_ALIASES[declared] ?? declared) !== sniffed.mime)
  )
    throw new BizError(Err.STORAGE_TYPE_REJECTED)
  const name = /filename="?([^";\r\n]+)"?/i.exec(answer.disposition)?.[1]
  return {
    data: answer.data,
    mime: sniffed.mime,
    fileName: name?.replace(/[/\\]/g, '_').slice(0, 255) ?? null,
  }
}

/** A multipart/form-data body: the `media` part, then the text fields. */
function multipart(boundary: string, file: WxoaUploadFile, fields: Record<string, string>): Buffer {
  // a quote or a line break in a name would end the header or start another
  const safe = (s: string) => s.replace(/["\\\r\n]/g, '_')
  const mime = /^[\w.+-]+\/[\w.+-]+$/.test(file.mime) ? file.mime : 'application/octet-stream'
  const parts = [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="${safe(file.name)}"\r\n` +
        `Content-Type: ${mime}\r\n\r\n`,
    ),
    file.data,
  ]
  for (const [name, value] of Object.entries(fields))
    parts.push(
      Buffer.from(
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="${safe(name)}"\r\n\r\n${value}`,
      ),
    )
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))
  return Buffer.concat(parts)
}

interface Request {
  host: string
  path: string
  query?: Record<string, string | number>
  body?: { type: string; data: Buffer }
}

/**
 * The only way out to WeChat (see docs/design-notes.md#wxoa): fixed hosts (`api.weixin.qq.com`,
 * `mp.weixin.qq.com` for QR code images), port 443, the core/net guarded agents, capped answers; the
 * account's access token in the URL only; URLs, secrets and answers never in logs, errors or responses;
 * nothing at all in demo mode (`A0431`). Called from management routes, inbound hub handlers and jobs,
 * never inside the callback request.
 */
@Injectable()
export class WxoaGateway {
  private readonly agent: https.Agent

  constructor(
    private readonly cfg: AppConfigService,
    @InjectDataSource() private readonly ds: DataSource,
    private readonly box: SecretBox,
    // the token service calls back into this gateway for `stable_token`: forwardRef on both sides, and
    // a structural type so no class is read while the two files load each other
    @Inject(forwardRef(() => WxoaTokenService))
    private readonly tokens: Pick<WxoaTokenService, 'get' | 'drop'>,
  ) {
    // fixed public hosts; ALLOW_PRIVATE_ENDPOINTS only for tests and a dev machine behind fake-IP DNS
    this.agent = guardedAgents({
      ports: [443],
      allowPrivate: cfg.get('ALLOW_PRIVATE_ENDPOINTS'),
    }).httpsAgent
  }

  /**
   * A JSON API on `api.weixin.qq.com` (`path` such as `/cgi-bin/menu/create`) with the account's token;
   * `stable_token` and `clear_quota/v2` are signed by the AppSecret instead ({@link BY_SECRET}).
   */
  async json<T extends WxoaJson = WxoaJson>(
    account: WxoaCaller,
    path: string,
    call: WxoaCall = {},
  ): Promise<T> {
    checkPath(path)
    const cap = capOf(call.maxBytes, JSON_CAP)
    const bySecret = BY_SECRET.get(path)
    if (bySecret) {
      const signed = bySecret(account.appId, await this.appSecret(account))
      return ok(
        await this.sendJson({ host: API_HOST, path, query: signed.query }, signed.body, cap),
        false,
      ) as T
    }
    return this.authed(account, async (token) =>
      ok(
        await this.sendJson(
          { host: API_HOST, path, query: { ...call.query, access_token: token } },
          call.body,
          cap,
        ),
        true,
      ),
    ) as Promise<T>
  }

  /** A multipart upload: `file` as the `media` part plus text `fields` (a video's `description`). */
  async upload(
    account: WxoaCaller,
    path: string,
    file: WxoaUploadFile,
    call: Pick<WxoaCall, 'query'> & { fields?: Record<string, string> } = {},
  ): Promise<WxoaJson> {
    checkPath(path)
    const boundary = `qw-${randomBytes(16).toString('hex')}`
    const data = multipart(boundary, file, call.fields ?? {})
    return this.authed(account, async (token) => {
      const answer = await this.send(
        {
          host: API_HOST,
          path,
          query: { ...call.query, access_token: token },
          body: { type: `multipart/form-data; boundary=${boundary}`, data },
        },
        JSON_CAP,
      )
      return ok(parseJson(answer.data) ?? upstreamFailed(), true)
    })
  }

  /** A binary answer of an API (`/cgi-bin/media/get` …) with the account's token. */
  async download(account: WxoaCaller, path: string, call: WxoaCall = {}): Promise<WxoaBinary> {
    checkPath(path)
    const cap = capOf(call.maxBytes, MAX_CAP)
    return this.authed(account, async (token) =>
      binary(
        await this.send(
          {
            host: API_HOST,
            path,
            query: { ...call.query, access_token: token },
            body: call.body === undefined ? undefined : jsonBody(call.body),
          },
          cap,
        ),
        true,
      ),
    )
  }

  /** The image of a QR code `ticket` from `mp.weixin.qq.com` (no token). */
  async qrImage(ticket: string): Promise<WxoaBinary> {
    return binary(
      await this.send({ host: QR_HOST, path: '/cgi-bin/showqrcode', query: { ticket } }, MAX_CAP),
      false,
    )
  }

  /**
   * `attempt` with the account's token; a refused token is dropped and `attempt` runs once more with a
   * new one. Refused again: B6006, never a loop.
   */
  private async authed<T>(account: WxoaCaller, attempt: (token: string) => Promise<T>): Promise<T> {
    try {
      return await attempt(await this.tokens.get(account))
    } catch (err) {
      if (!(err instanceof StaleToken)) throw err
    }
    await this.tokens.drop(account.id)
    try {
      return await attempt(await this.tokens.get(account))
    } catch (err) {
      throw err instanceof StaleToken ? new BizError(Err.WXOA_CREDENTIAL_INVALID) : err
    }
  }

  /** The live account's AppSecret (by id and AppID both, so a token is never fetched for another app). */
  private async appSecret(account: WxoaCaller): Promise<string> {
    if (account.appSecret !== undefined) return account.appSecret
    const [row] = await this.ds.query<{ app_secret_enc: string }[]>(
      'SELECT app_secret_enc FROM wxoa_account WHERE id = ? AND app_id = ? AND tenant_id = ? AND deleted_at IS NULL',
      [account.id, account.appId, account.tenantId ?? tenantId()],
    )
    if (!row) throw new BizError(Err.NOT_FOUND)
    try {
      return this.box.decrypt(row.app_secret_enc)
    } catch {
      // stored under another APP_SECRET: the secret must be entered again
      throw new BizError(Err.WXOA_CREDENTIAL_INVALID)
    }
  }

  private async sendJson(req: Request, body: unknown, cap: number): Promise<WxoaJson> {
    const answer = await this.send(
      { ...req, body: body === undefined ? undefined : jsonBody(body) },
      cap,
    )
    return parseJson(answer.data) ?? upstreamFailed()
  }

  /**
   * One HTTPS exchange: the answer when it is a 200 of at most `cap` bytes (read until then, the
   * request destroyed past it: A0413), else B6001. No redirect is followed. Every failure is an own
   * error with nothing of the request in it (the URL may carry a token or the AppSecret).
   */
  private send(req: Request, cap: number): Promise<Answer> {
    if (this.cfg.get('APP_DEMO_MODE')) return Promise.reject(new BizError(Err.DEMO_READ_ONLY))
    const query = new URLSearchParams(
      Object.entries(req.query ?? {}).map(([k, v]) => [k, String(v)]),
    ).toString()
    return new Promise<Answer>((resolve, reject) => {
      const fail = (err: BizError) => {
        outgoing.destroy()
        reject(err)
      }
      const outgoing = https.request(
        {
          host: req.host,
          port: 443,
          path: query ? `${req.path}?${query}` : req.path,
          method: req.body ? 'POST' : 'GET',
          headers: req.body && {
            'content-type': req.body.type,
            'content-length': req.body.data.length,
          },
          agent: this.agent,
        },
        (res) => {
          if (res.statusCode !== 200) return fail(new BizError(Err.WXOA_UPSTREAM))
          const chunks: Buffer[] = []
          let size = 0
          res.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > cap) fail(new BizError(Err.PAYLOAD_TOO_LARGE))
            else chunks.push(chunk)
          })
          res.on('end', () =>
            resolve({
              data: Buffer.concat(chunks),
              type: String(res.headers['content-type'] ?? ''),
              disposition: String(res.headers['content-disposition'] ?? ''),
            }),
          )
          res.on('error', () => fail(new BizError(Err.WXOA_UPSTREAM)))
        },
      )
      outgoing.on('error', () => fail(new BizError(Err.WXOA_UPSTREAM)))
      outgoing.end(req.body?.data)
    })
  }
}

const jsonBody = (body: unknown) => ({
  type: 'application/json',
  data: Buffer.from(JSON.stringify(body)),
})

function upstreamFailed(): never {
  throw new BizError(Err.WXOA_UPSTREAM)
}
