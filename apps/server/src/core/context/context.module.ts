import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ClsModule } from 'nestjs-cls'
import { requestLocale, timezoneOf } from '../i18n/locale.js'

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
 */
export const CoreContextModule = ClsModule.forRoot({
  global: true,
  middleware: {
    mount: true,
    generateId: true,
    idGenerator: requestId,
    setup: (cls, req: IncomingMessage, res: ServerResponse) => {
      cls.set('traceId', cls.getId())
      cls.set('locale', requestLocale(req))
      const tz = req.headers['x-timezone']
      cls.set('timezone', timezoneOf(typeof tz === 'string' ? tz : undefined) ?? undefined)
      res.setHeader('X-Request-Id', cls.getId())
    },
  },
})
