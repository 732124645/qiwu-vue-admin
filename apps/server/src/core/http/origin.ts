import type { Request } from 'express'

/**
 * Whether a browser `Origin` belongs to this deployment (see docs/design-notes.md#security): the request's own origin
 * (`req.protocol` / `req.host`, which honour `trust proxy`) or one of `CORS_ORIGIN` (comma-separated).
 * The CSRF checks of the sign-ins and the refresh cookie and the WebSocket upgrade ask it.
 */
export function originAllowed(origin: string, req: Request, corsOrigin = ''): boolean {
  const allowed = corsOrigin
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
  return origin === `${req.protocol}://${req.host}` || allowed.includes(origin)
}

/**
 * Login CSRF for the sign-ins that set the refresh cookie (password, SMS): a browser always sends
 * `Origin` on a cross-site POST (`null` when it hides it), so a present one `originAllowed` refuses means
 * another site's form or script; a request without one is no browser's (apps, scripts) and passes.
 */
export function foreignOrigin(req: Request, corsOrigin = ''): boolean {
  const origin = req.get('origin')
  return origin !== undefined && !originAllowed(origin, req, corsOrigin)
}
