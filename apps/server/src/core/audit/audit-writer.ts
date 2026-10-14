import { Injectable, Logger } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import Bowser from 'bowser'
import type { Request } from 'express'
import type { DataSource } from 'typeorm'
import { plainIp } from '../auth/auth-params.js'
import type { Principal } from '../auth/principal.js'
import { clsGet } from '../context/cls.js'
import { requestId } from '../context/context.module.js'
import { TenantContextMissing, tenantId, tenantIdIfAny } from '../context/tenant.js'
import { driverMasked, redactedJson, redactedUrl, stackFrames, textRedactor } from '../redact.js'
import { ipLocator } from './ip-location.js'

const UNLOGGED = new WeakSet<object>()

/**
 * Marks a request of a `@SkipHttpTrace()` route (HttpTraceInterceptor, which sees the handler): the error
 * filter, which gets only the request, writes no `aud_http_fault` row for it either (a health probe
 * answering 503 while a dependency is down would add one row per probe).
 */
export const skipHttpLogs = (req: object): void => void UNLOGGED.add(req)

/** Whether `skipHttpLogs` marked the request. */
export const httpLogsSkipped = (req: object): boolean => UNLOGGED.has(req)

/** Metadata key of `@SkipHttpTrace()` (core/audit/http-trace.ts). */
export const SKIP_HTTP_TRACE = 'qw:audit:skip-http-trace'

const ALWAYS_TRACED = new WeakMap<object, number>()

/**
 * Marks a request the API access log records whatever its mode and excluded paths, a guard's refusal
 * too (the error filter writes that row; see docs/design-notes.md#tenancy): AuthGuard marks every
 * request of a platform user working inside another tenant, and the one that ends it, except on
 * `@SkipHttpTrace()` routes.
 */
export const traceHttpAlways = (req: object): void => void ALWAYS_TRACED.set(req, Date.now())

/** When `traceHttpAlways` marked the request (epoch ms); undefined: it did not. */
export const httpTracedAlways = (req: object): number | undefined => ALWAYS_TRACED.get(req)

/** `aud_signin_log.kind` (see docs/design-notes.md#audit); `wx-mp`: WeChat mini program sign-in and binding. */
export type SigninKind =
  'password' | 'sms' | 'wx-mp' | 'signout' | 'kicked' | 'refresh_reuse' | 'locked'

export interface SigninLogEntry {
  kind: SigninKind
  userType: string
  userId: number | null
  /** as typed by the client */
  username: string
  clientId: string
  ip: string | null
  /** raw User-Agent; stored as browser/os names */
  ua: string
  ok: boolean
  /** server i18n key (`signin.*`), translated when read (see docs/design-notes.md#i18n) */
  msgKey: string
  msgParams?: Record<string, string | number>
  /**
   * The row's tenant when the context has none to give (a password sign-in whose tenant did not
   * resolve: the unavailable tenant its host or code names, null for an unknown code); absent = the
   * context's tenant.
   */
  tenantId?: number | null
  /**
   * When it happened (epoch ms, app clock); absent = now. A successful sign-in passes its session's
   * `loginAt`, so GET /me can tell the session's own row from earlier ones.
   */
  at?: number
}

/** One `@ActionLog` call (see docs/design-notes.md#audit); the writer adds the caller and trace id from CLS. */
export interface ActionLogEntry {
  domain: string
  verb: string
  bizId: string | null
  method: string
  /** path + query as sent; secret-named query values are masked */
  url: string
  ip: string | null
  ua: string
  /** request query/body: secret-named keys masked, JSON cut to 4 KB */
  params: unknown
  /** handler result: masked, cut to 2 KB */
  result: unknown
  /** the route's `@Sensitive` fields, masked like the secret key names */
  sensitive?: readonly string[]
  /** i18n key of the error envelope's message (translated when read); absent = success */
  errorKey?: string
  costMs: number
  /**
   * The row's tenant (its actor's too) and its actor when not the request context's: a platform user
   * entering or leaving another tenant, recorded in its own tenant also outside its requests (see
   * docs/design-notes.md#tenancy)
   */
  context?: { tenantId: number; actor: ActionActor }
}

/** Who an action log row names. */
export type ActionActor = Pick<Principal, 'userType' | 'username' | 'deptName'> & {
  userId: number | null
}

/**
 * What the API logs keep of a request and its caller (see docs/design-notes.md#audit), taken while the request context is
 * active (`requestSummary`): the query and body as JSON with secret-named and `@Sensitive` keys masked
 * (core/redact.ts), cut to 4 KB.
 */
export interface RequestSummary {
  traceId: string
  /** the data tenant of a signed-in caller; null for an anonymous request (see docs/design-notes.md#tenancy) */
  tenantId: number | null
  userId: number | null
  username: string | null
  userType: string | null
  clientId: string | null
  method: string
  /** the path, without the query */
  url: string
  query: string | null
  body: string | null
  ip: string | null
  ua: string
}

/** One traced request (`aud_http_trace`). */
export interface HttpTraceEntry {
  req: RequestSummary
  status: number
  /** the envelope's code: `0`, or the error's (`A0404`) */
  bizCode: string
  /** i18n key of the error's message (translated when read); absent = success */
  errorKey?: string
  startedAt: Date
  costMs: number
}

const REQUEST_JSON_MAX = 4096
const STACK_MAX = 8192
/** `text` holds 64 KB: a message of utf8mb4 characters fits at this length */
const MESSAGE_MAX = 16_000

const jsonOf = (v: unknown, sensitive: readonly string[]) =>
  v === undefined ||
  v === null ||
  (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)
    ? null
    : redactedJson(v, REQUEST_JSON_MAX, sensitive)

/**
 * The request and caller as the API logs keep them; call it inside the request context (CLS).
 * `sensitive` = the route's `@Sensitive` fields; undefined (not known: the request failed before its
 * route) keeps no query or body at all, so a plain-named secret never slips through.
 */
export function requestSummary(req: Request, sensitive?: readonly string[]): RequestSummary {
  const p = clsGet('principal')
  return {
    traceId: clsGet('traceId') ?? requestId(req),
    tenantId: p ? (tenantIdIfAny() ?? null) : null,
    userId: p?.userId ?? null,
    username: p?.username?.slice(0, 64) ?? null,
    userType: p?.userType?.slice(0, 16) ?? null,
    clientId: p?.clientId?.slice(0, 64) ?? null,
    method: req.method.slice(0, 10),
    url: req.originalUrl.split('?')[0]!.slice(0, 512),
    query: sensitive ? jsonOf(req.query, sensitive) : null,
    body: sensitive ? jsonOf(req.body, sensitive) : null,
    ip: plainIp(req.ip) || null,
    ua: (req.get('user-agent') ?? '').slice(0, 512),
  }
}

/** An exception as the API error log and the process log keep it (see docs/design-notes.md#audit). */
export interface Fault {
  /** the class (a code identifier, never data) */
  type: string
  /** masked: see `describeFault` */
  message: string
  /** the frames only (`    at …`): the lines above them repeat the message */
  stack: string | null
}

/**
 * The exception, masked: `redact` (core/redact.ts `textRedactor` of the request: what it sent as a
 * secret, secret-named pairs, parameter dumps) over the message, a driver error's quoted values masked
 * behind its code (`driverMasked`), the stack cut to its frames.
 */
export function describeFault(
  error: unknown,
  redact: (text: string) => string = textRedactor(undefined),
): Fault {
  const e = error instanceof Error ? error : undefined
  return {
    type: (e ? e.constructor.name || e.name : typeof error).slice(0, 128),
    message: redact(e ? driverMasked(e.message, e) : String(error)).slice(0, MESSAGE_MAX),
    stack: stackFrames(e?.stack)?.slice(0, STACK_MAX) ?? null,
  }
}

/** `lastSignIn`'s query (params: user id, before, tenant); exported for the spec that checks its index. */
export const LAST_SIGNIN_SQL = `SELECT created_at AS at FROM aud_signin_log
  WHERE user_id = ? AND ok = 1 AND kind IN ('password', 'sms', 'wx-mp') AND created_at < ?
    AND deleted_at IS NULL AND tenant_id = ?
  ORDER BY created_at DESC LIMIT 1`

/** "Chrome 131.0.0.0", cut to the column width. */
const name = (n?: string, v?: string) => (n ? `${n}${v ? ` ${v}` : ''}`.slice(0, 64) : null)

/**
 * Audit rows written without awaiting (see docs/design-notes.md#audit): a failing insert is logged and never fails the
 * request it describes. Sign-in and action rows carry the IP's location (ip2region, empty without it) and
 * the current tenant (an action row also the acting user's, the same one unless it differs).
 */
@Injectable()
export class AuditWriter {
  private readonly logger = new Logger(AuditWriter.name)

  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /** `created_at` is written from the app clock (never the DB's default): see `lastSignIn`. */
  signin(e: SigninLogEntry): void {
    const at = new Date(e.at ?? Date.now())
    const { browser, os } = parseUa(e.ua)
    const traceId = clsGet('traceId') ?? null
    const tid = e.tenantId === undefined ? tenantIdIfAny() : e.tenantId
    if (tid === undefined) {
      this.logger.error(new TenantContextMissing('no tenant in context'), 'sign-in log skipped')
      return
    }
    void ipLocator
      .location(e.ip)
      .then((location) =>
        this.ds.query(
          `INSERT INTO aud_signin_log
             (trace_id, kind, user_id, user_type, username, client_id, ip, location, browser, os, ok, msg_key,
              msg_params, tenant_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            traceId,
            e.kind,
            e.userId,
            e.userType,
            e.username.slice(0, 64),
            e.clientId,
            e.ip,
            location,
            browser,
            os,
            e.ok ? 1 : 0,
            e.msgKey,
            e.msgParams ? JSON.stringify(e.msgParams) : null,
            tid,
            at,
          ],
        ),
      )
      .catch((err: unknown) => this.logger.error(err, 'sign-in log insert failed'))
  }

  /**
   * GET /me `lastSignInAt`: the user's latest successful `password`/`sms` sign-in logged
   * (and not deleted) before `loginAt`, i.e. the second-to-last one when this session's is the last. Anchored on the
   * session, not on row order: its own row is inserted after `loginAt` and without awaiting (it may not
   * be there yet), and a later sign-in elsewhere must not become this session's "previous" one.
   * Its own row carries `loginAt` itself as `created_at` (app clock on both sides), so the strict `<`
   * keeps it out however far the DB clock is off the app's.
   * Served by idx (user_id, created_at): every /me reads back from loginAt within the user's rows only,
   * in the user's own tenant (where its sign-ins are logged, also while it acts in another one).
   */
  async lastSignIn(userId: number, loginAt: number): Promise<string | null> {
    const [row] = await this.ds.query<{ at: Date }[]>(LAST_SIGNIN_SQL, [
      userId,
      new Date(loginAt),
      clsGet('actorTenantId') ?? tenantId(),
    ])
    return row ? row.at.toISOString() : null
  }

  /**
   * No row without a tenant (`tenant_id` is not nullable): only a public route's request whose sign-in
   * tenant did not resolve has none, and a row in any tenant would show what it tried (a mobile, a
   * username) to that tenant's auditors (see docs/design-notes.md#tenancy). The acting tenant is the data
   * tenant unless a session says otherwise.
   */
  action(e: ActionLogEntry): void {
    const tid = e.context?.tenantId ?? tenantIdIfAny()
    if (tid === undefined) return
    const p = e.context?.actor ?? clsGet('principal')
    const row = [
      clsGet('traceId') ?? null,
      e.domain.slice(0, 64),
      e.verb.slice(0, 32),
      e.bizId?.slice(0, 64) ?? null,
      p?.userId ?? null,
      p?.userType ?? 'admin',
      p?.username?.slice(0, 64) ?? null,
      p?.deptName?.slice(0, 64) ?? null,
      e.method.slice(0, 10),
      redactedUrl(e.url, e.sensitive).slice(0, 512),
      e.ip,
      e.ua.slice(0, 512),
      redactedJson(e.params, 4096, e.sensitive),
      redactedJson(e.result, 2048, e.sensitive),
      e.errorKey ? 0 : 1,
      e.errorKey?.slice(0, 1000) ?? null,
      e.costMs,
    ]
    const actor = e.context ? tid : (clsGet('actorTenantId') ?? tid)
    void ipLocator
      .location(e.ip)
      .then((location) =>
        this.ds.query(
          `INSERT INTO aud_action_log
             (trace_id, domain, verb, biz_id, user_id, user_type, username, dept_name, http_method, url, ip,
              user_agent, params, result, ok, error_msg, cost_ms, location, tenant_id, actor_tenant_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [...row, location, tid, actor],
        ),
      )
      .catch((err: unknown) => this.logger.error(err, 'action log insert failed'))
  }

  trace(e: HttpTraceEntry): void {
    const r = e.req
    void this.ds
      .query(
        `INSERT INTO aud_http_trace
           (trace_id, user_id, username, user_type, client_id, method, url, query, body, status_code,
            biz_code, msg, ip, user_agent, started_at, cost_ms, tenant_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          r.traceId,
          r.userId,
          r.username,
          r.userType,
          r.clientId,
          r.method,
          r.url,
          r.query,
          r.body,
          e.status,
          e.bizCode.slice(0, 16),
          e.errorKey?.slice(0, 255) ?? null,
          r.ip,
          r.ua,
          e.startedAt,
          e.costMs,
          r.tenantId,
        ],
      )
      .catch((err: unknown) => this.logger.error(err, 'http trace insert failed'))
  }

  /** A server error (5xx) of `req` (see docs/design-notes.md#audit), state `open`: the exception as `describeFault` masked it. */
  fault(req: RequestSummary, fault: Fault): void {
    void this.ds
      .query(
        `INSERT INTO aud_http_fault
           (trace_id, user_id, username, method, url, query, body, ip, user_agent, error_name,
            error_message, stack, tenant_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.traceId,
          req.userId,
          req.username,
          req.method,
          req.url,
          req.query,
          req.body,
          req.ip,
          req.ua,
          fault.type,
          fault.message,
          fault.stack,
          req.tenantId,
        ],
      )
      .catch((err: unknown) => this.logger.error(err, 'http fault insert failed'))
  }
}

/** Browser and OS names of a User-Agent ("Chrome 131.0.0.0", "macOS 10.15.7"), cut to the log columns. */
export function parseUa(ua: string): { browser: string | null; os: string | null } {
  if (!ua) return { browser: null, os: null }
  const r = Bowser.parse(ua)
  return { browser: name(r.browser.name, r.browser.version), os: name(r.os.name, r.os.version) }
}
