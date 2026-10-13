import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ClsModule, type ClsService } from 'nestjs-cls'
import { AppConfigService } from '../config/config.module.js'
import { requestLocale, timezoneOf } from '../i18n/locale.js'
import { clearTenantContext, DEFAULT_TENANT_ID } from './tenant.js'

// Client-supplied ids end up in logs and error envelopes: accept only short, plain tokens.
const SAFE_ID = /^[\w.:-]{1,64}$/

/**
 * Request id (= traceId): a well-formed incoming `X-Request-Id`, else a new UUID.
 * Memoized on `req.id`, so the CLS id and pino-http's `reqId` are the same value whatever the middleware order.
 */
export function requestId(req: IncomingMessage & { id?: unknown }): string {
  if (typeof req.id === 'string') return req.id
  const header = req.headers['x-request-id']
  const id = typeof header === 'string' && SAFE_ID.test(header) ? header : randomUUID()
  req.id = id
  return id
}

/**
 * Global request context (ClsService, typed keys in `cls.ts`); plugins such as transactions register
 * via ClsModule.registerPlugins. Every response (errors included) echoes the id as `X-Request-Id`.
 * The tenant keys are written on every request (see docs/design-notes.md#tenancy): multi-tenancy off,
 * the default tenant; on, none: only the sign-in resolution, the session (AuthGuard, refresh) or the row
 * a public route works on names it. Without the config module (CLI tools, unit tests) it counts as off.
 */
export const CoreContextModule = ClsModule.forRootAsync({
  global: true,
  inject: [{ token: AppConfigService, optional: true }],
  useFactory: (cfg?: AppConfigService) => {
    const preset = cfg?.get('APP_MULTI_TENANT') ? undefined : DEFAULT_TENANT_ID
    return {
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: requestId,
        setup: (cls: ClsService, req: IncomingMessage, res: ServerResponse) => {
          cls.set('traceId', cls.getId())
          cls.set('locale', requestLocale(req))
          const tz = req.headers['x-timezone']
          cls.set('timezone', timezoneOf(typeof tz === 'string' ? tz : undefined) ?? undefined)
          // a request runs in a copy of its connection's context: the tenant keys are always written
          clearTenantContext()
          cls.set('tenantId', preset)
          res.setHeader('X-Request-Id', cls.getId())
        },
      },
    }
  },
})
