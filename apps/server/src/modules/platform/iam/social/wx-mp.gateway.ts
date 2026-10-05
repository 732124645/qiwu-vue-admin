import https from 'node:https'
import { Injectable } from '@nestjs/common'
import { Err } from '@qiwu/shared'
import { AppConfigService } from '../../../../core/config/config.module.js'
import { BizError } from '../../../../core/http/biz-error.js'
import { guardedAgents } from '../../../../core/net/net-guard.js'

/** Who code2Session says signed in; its `session_key` is dropped on arrival, never stored or sent. */
export interface WxMpIdentity {
  openid: string
  unionid: string | null
}

/** Longest code2Session answer read (a real one is ~150 bytes). */
const MAX_BODY = 8192
/** WeChat's "busy, try again" and rate-limit codes: the upstream failed, the code may still be good. */
const UPSTREAM_ERRCODES = new Set([-1, 45011])

/**
 * A code2Session answer: the identity, or 400 `wx_mp_code_invalid` for a refused code (invalid, used,
 * expired, blocked user), 502 `wx_mp_upstream` for anything else. Nothing of the answer is echoed.
 */
export function parseCode2Session(body: string): WxMpIdentity {
  let json: { openid?: unknown; unionid?: unknown; errcode?: unknown }
  try {
    json = JSON.parse(body) as typeof json
  } catch {
    throw new BizError(Err.AUTH_WX_MP_UPSTREAM)
  }
  const errcode = Number(json?.errcode ?? 0)
  if (errcode !== 0)
    throw new BizError(
      UPSTREAM_ERRCODES.has(errcode) ? Err.AUTH_WX_MP_UPSTREAM : Err.AUTH_WX_MP_CODE_INVALID,
    )
  const id = (v: unknown) => (typeof v === 'string' && /^[\w-]{1,128}$/.test(v) ? v : null)
  const openid = id(json.openid)
  if (!openid) throw new BizError(Err.AUTH_WX_MP_UPSTREAM)
  return { openid, unionid: id(json.unionid) }
}

export interface WxAccessToken {
  token: string
  /** seconds */
  expiresIn: number
}

/** A `subscribeMessage.send` body. */
export interface WxSubscribeSend {
  touser: string
  template_id: string
  page?: string
  data: Record<string, { value: string }>
  miniprogram_state: 'developer' | 'trial' | 'formal'
  lang: 'zh_CN' | 'en_US'
}

const parseJson = (body: string): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(body)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** A stable_token answer; anything but a token throws a bare Error (nothing of the answer is echoed). */
export function parseStableToken(body: string): WxAccessToken {
  const v = parseJson(body)
  const token = v?.access_token
  const expiresIn = Number(v?.expires_in)
  if (
    Number(v?.errcode ?? 0) !== 0 ||
    typeof token !== 'string' ||
    !/^[\x21-\x7e]{1,1024}$/.test(token)
  )
    throw new Error('wx token')
  return { token, expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 7200 }
}

/** A subscribeMessage.send answer's errcode (0 = sent); an unreadable answer is -1 (WeChat's "busy"). */
export function parseSendErrcode(body: string): number {
  const code = Number(parseJson(body)?.errcode ?? -1)
  return Number.isInteger(code) ? code : -1
}

/**
 * WeChat's code2Session (`GET https://api.weixin.qq.com/sns/jscode2session`), stable access token and
 * subscribe-message send through the outbound guard (core/net: public addresses only, port 443, 5 s
 * silence limit). Env `WX_MP_APPID` + `WX_MP_SECRET` (the secret only in `.env.local`). The e2e specs
 * replace this provider with a fake.
 */
@Injectable()
export class WxMpGateway {
  private readonly agent: https.Agent

  constructor(private readonly cfg: AppConfigService) {
    // a fixed public host; ALLOW_PRIVATE_ENDPOINTS only for a dev machine whose DNS answers fake-IPs
    this.agent = guardedAgents({
      ports: [443],
      allowPrivate: cfg.get('ALLOW_PRIVATE_ENDPOINTS'),
    }).httpsAgent
  }

  /** The configured mini program, or null (WeChat sign-in unavailable). */
  appid(): string | null {
    return (this.cfg.get('WX_MP_SECRET') && this.cfg.get('WX_MP_APPID')) || null
  }

  async code2Session(code: string): Promise<WxMpIdentity> {
    const query = new URLSearchParams({
      appid: this.cfg.get('WX_MP_APPID') ?? '',
      secret: this.cfg.get('WX_MP_SECRET') ?? '',
      js_code: code,
      grant_type: 'authorization_code',
    })
    const body = await this.exchange(`/sns/jscode2session?${query}`).catch(() => {
      throw new BizError(Err.AUTH_WX_MP_UPSTREAM)
    })
    return parseCode2Session(body)
  }

  /**
   * An access token from `cgi-bin/stable_token`: the AppSecret travels in the POST body, never
   * a URL; unlike `cgi-bin/token` it does not invalidate the tokens other servers of the app hold.
   */
  async stableToken(): Promise<WxAccessToken> {
    return parseStableToken(
      await this.exchange('/cgi-bin/stable_token', {
        grant_type: 'client_credential',
        appid: this.cfg.get('WX_MP_APPID') ?? '',
        secret: this.cfg.get('WX_MP_SECRET') ?? '',
        force_refresh: false,
      }),
    )
  }

  /** `subscribeMessage.send`: WeChat's errcode (0 = sent). The URL carries the token: never logged. */
  async subscribeSend(token: string, body: WxSubscribeSend): Promise<number> {
    const query = new URLSearchParams({ access_token: token })
    return parseSendErrcode(await this.exchange(`/cgi-bin/message/subscribe/send?${query}`, body))
  }

  /**
   * One exchange with api.weixin.qq.com: GET, or POST of `json`; the answer when 200 and ≤ MAX_BODY.
   * Rejects with a bare Error: the URL or the body may carry the secret or a token.
   */
  private exchange(path: string, json?: object): Promise<string> {
    const payload = json && JSON.stringify(json)
    return new Promise<string>((resolve, reject) => {
      const req = https.request(
        {
          host: 'api.weixin.qq.com',
          port: 443,
          path,
          method: payload ? 'POST' : 'GET',
          headers: payload ? { 'content-type': 'application/json' } : undefined,
          agent: this.agent,
        },
        (res) => {
          let data = ''
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => {
            data += chunk
            if (data.length > MAX_BODY) req.destroy(new Error('answer too large'))
          })
          res.on('end', () => (res.statusCode === 200 ? resolve(data) : reject(res.statusCode)))
          res.on('error', reject)
        },
      )
      req.on('error', reject)
      req.end(payload)
    }).catch(() => {
      throw new Error('wx upstream')
    })
  }
}
