// SPA Content-Security-Policy (see docs/design-notes.md#security), the single source: `vite preview` sends it (Playwright runs
// the built app under it) and the nginx config reuses the same string.
// style-src 'unsafe-inline': Element Plus sets inline styles; frame-src https: for `link_type=iframe` menus.
// connect-src: the app's own origin plus what the deployer lists in the env `CSP_CONNECT_SRC` when the
// build / preview runs (space or comma separated), e.g. the S3 endpoint browsers PUT direct uploads to
// and fetch private downloads from (docs/deploy.md). Default: none, `connect-src 'self'`.

/** A bare origin: lowercase DNS name, IPv4 or bracketed IPv6 host, optional port; nothing else. */
const HOST = /^(?:[a-z0-9-]+\.)*[a-z0-9-]+$|^\[[0-9a-f:.]+\]$/
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * The origins in `raw` (`CSP_CONNECT_SRC`), each an https origin (`https://host[:port]`, a trailing `/`
 * tolerated) or, for development, `http://localhost|127.0.0.1|[::1][:port]`. Anything else (paths,
 * wildcards, keywords, other schemes, a `;`) throws: the build stops instead of shipping a wider policy.
 */
export function connectOrigins(raw = ''): string[] {
  return raw
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((entry) => {
      let url: URL | null = null
      try {
        url = new URL(entry)
      } catch {
        // reported below
      }
      const scheme =
        url?.protocol === 'https:' || (url?.protocol === 'http:' && LOCAL.has(url.hostname))
      if (!url || !scheme || !HOST.test(url.hostname) || url.origin !== entry.replace(/\/$/, ''))
        throw new Error(`CSP_CONNECT_SRC: '${entry}' is not an https origin (https://host[:port])`)
      return url.origin
    })
}

/** The policy with `connect` (checked origins) allowed besides the app's own. */
export const spaCsp = (connect: readonly string[] = []): string =>
  [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    ["connect-src 'self'", ...connect].join(' '),
    "frame-src 'self' https:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; ')

export const SPA_CSP = spaCsp(connectOrigins(process.env.CSP_CONNECT_SRC))
