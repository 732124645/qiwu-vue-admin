import type { Request } from 'express'

/**
 * Whether a browser `Origin` belongs to this deployment (see docs/design-notes.md#security): the request's own origin
 * (`req.protocol` / `req.host`, which honour `trust proxy`) or one of `CORS_ORIGIN` (comma-separated).
 * The refresh cookie's CSRF check and the WebSocket upgrade both ask it.
 */
export function originAllowed(origin: string, req: Request, corsOrigin = ''): boolean {
  const allowed = corsOrigin
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
  return origin === `${req.protocol}://${req.host}` || allowed.includes(origin)
}
