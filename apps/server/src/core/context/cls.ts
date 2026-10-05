import type { Locale } from '@qiwu/shared'
import { ClsServiceManager, type ClsStore } from 'nestjs-cls'
import type { PermRequirement } from '../auth/decorators.js'
import type { Principal } from '../auth/principal.js'

/** Per-request context (nestjs-cls, one per HTTP request; jobs open their own with `cls.run`). */
export interface AppClsStore extends ClsStore {
  /** = CLS id = pino `reqId` = `X-Request-Id` response header = error envelope `traceId`. */
  traceId: string
  /** Absent on public routes and outside requests. */
  principal?: Principal
  /** Explicit request language (`?lang`, then `Accept-Language`); resolved by core/i18n. */
  locale?: Locale
  /** Valid IANA zone of the request's `X-Timezone` header, for server-rendered times (see docs/design-notes.md#api-envelope). */
  timezone?: string
  /**
   * What PermGuard checked (`@RequirePerm`): `.all()` → every required perm, `all: true`; any-of → the
   * perms the caller holds among those listed, `all: false`. Absent = the route checks none. Data scope
   * reads it (core/data-scope `roleGroups`).
   */
  checkedPerm?: PermRequirement
  /** Data-scope results computed during this request (core/data-scope), keyed by the caller. */
  scopeCache?: Map<string, unknown>
  /** Set by `@SkipDataScope()` for the decorated call: `scopedQb` applies no data scope. */
  skipDataScope?: boolean
}

/**
 * Typed read of the current request context without DI (subscribers, filters, services);
 * `undefined` outside a CLS context (CLI scripts, bootstrap).
 */
export function clsGet<K extends keyof AppClsStore & string>(key: K): AppClsStore[K] | undefined {
  const cls = ClsServiceManager.getClsService()
  return cls.isActive() ? (cls.get(key) as AppClsStore[K]) : undefined
}

/** Typed write to the current request context; throws outside one (a bug, not a condition). */
export function clsSet<K extends keyof AppClsStore & string>(key: K, value: AppClsStore[K]): void {
  ClsServiceManager.getClsService().set(key, value)
}
