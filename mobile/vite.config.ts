/// <reference types="vitest/config" />
import { realpathSync } from 'node:fs'
import type { IncomingHttpHeaders, Server as HttpServer } from 'node:http'
import { resolve } from 'node:path'
import type { Duplex } from 'node:stream'
import uni from '@dcloudio/vite-plugin-uni'
import { defineConfig, type Plugin, type PreviewServer, type ViteDevServer } from 'vite'

// the app's tsconfig types process.env as uni's (a spec under src/ reads this file too)
const env = process.env as Record<string, string | undefined>

// H5 dev server / preview: /api and the local storage's public files (/files, avatars) go to the backend
// (Playwright: the mobile e2e server on 3201). The realtime socket in the object form: the string one
// rewrites Host, and the server's Origin check would then see a foreign page (forbidden_origin).
const api = env.API_PROXY_TARGET || 'http://127.0.0.1:3000'
const proxy = { '/api': api, '/files': api, '/socket.io': { target: api, ws: true } }

/**
 * engine.io-client's globals without the `Function("return this")` the mini program forbids (src/core/
 * eio-globals.ts; scripts/mp-size.mjs checks the mp build). Only engine.io-client imports that name.
 * Drop it when engine.io-client stops using the eval fallback.
 */
const eioGlobals: Plugin = {
  name: 'qw-eio-globals',
  enforce: 'pre',
  resolveId: (source, importer) =>
    /^\.{1,2}\/globals\.node\.js$/.test(source) && importer?.includes('/engine.io-client/')
      ? resolve(__dirname, 'src/core/eio-globals.ts')
      : null,
}

/** A Host naming this machine directly (a name another site controls could resolve to it: DNS rebinding). */
const directHost = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[\da-f:.]+\])(:\d+)?$/i

/**
 * More host names the H5 server answers (`QW_H5_ALLOWED_HOSTS`, comma separated, without port): a
 * `*.local` name or a tunnel. Only names you control: each one is trusted like localhost.
 */
const allowedHosts = (env.QW_H5_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean)

/**
 * A request the H5 dev server and preview refuse: one naming another host (`hosts` aside), or sent by
 * another site's page in the developer's browser (a foreign Origin, Sec-Fetch-Site cross-site).
 */
export function foreignRequest(
  headers: IncomingHttpHeaders,
  hosts: readonly string[] = allowedHosts,
): boolean {
  const host = (headers.host ?? '').toLowerCase()
  const known = (h: string) => directHost.test(h) || hosts.includes(h.replace(/:\d+$/, ''))
  const from = headers.origin?.toLowerCase().replace(/^https?:\/\//, '')
  return (
    !known(host) ||
    headers['sec-fetch-site'] === 'cross-site' ||
    (from !== undefined && from !== host)
  )
}

/** The guard of one server (dev or preview): its requests, and its socket upgrades before Vite's. */
const guard = (server: Pick<ViteDevServer | PreviewServer, 'middlewares' | 'httpServer'>) => {
  server.middlewares.use((req, res, next) => {
    if (!foreignRequest(req.headers)) return next()
    res.statusCode = 403
    res.end()
  })
  // Vite checks no Origin on the HMR socket, nor the proxy on the realtime one: dropped first
  ;(server.httpServer as HttpServer | null)?.prependListener('upgrade', (req, socket: Duplex) => {
    if (foreignRequest(req.headers)) socket.destroy()
  })
}

/**
 * The H5 dev server and preview answer only their own pages (`foreignRequest` → 403, a socket upgrade
 * dropped). With `fs.strict` (below) and no CORS, no page elsewhere reads the source tree or files
 * beside it. `--host` for a phone on the LAN still works (it asks by IP).
 */
export const devGuard: Plugin = {
  name: 'qw-dev-guard',
  enforce: 'pre',
  configureServer: guard,
  configurePreviewServer: guard,
}

export default defineConfig({
  // vitest runs plain TypeScript: no uni compiler
  plugins: env.VITEST ? [] : [eioGlobals, devGuard, uni()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      // shared from its TypeScript source (uni forces preserveSymlinks, so no workspace
      // link), and one zod for the app and shared, so `z.config({ jitless })` reaches shared's schemas
      '@qiwu/shared': resolve(__dirname, '../packages/shared/src'),
      zod: resolve(__dirname, 'node_modules/zod'),
      // its real folder: with uni's preserveSymlinks, pnpm's link in node_modules finds none of its own
      // dependencies (engine.io-client, socket.io-parser…), the real folder has them beside it
      'socket.io-client': realpathSync(resolve(__dirname, 'node_modules/socket.io-client')),
    },
  },
  // dev server: one copy of wot-ui. Pre-bundled, `@wot-ui/ui/locale` (core/i18n.ts) would be a second copy of
  // the module its components (served as source) read, so a language switch would never reach their texts
  optimizeDeps: { exclude: ['@wot-ui/ui'] },
  // shared targets ES2023, which esbuild 0.20 (vite 5.2) warns about
  esbuild: { tsconfigRaw: { compilerOptions: { target: 'es2022' } } },
  // uni-h5 turns `fs.strict` off, and Vite then serves any file of the machine (its deny list never
  // runs): only the app and shared's source. No CORS: another site's page reads no response.
  server: {
    proxy,
    cors: false,
    fs: { strict: true, allow: [__dirname, resolve(__dirname, '../packages/shared/src')] },
  },
  preview: { proxy, cors: false },
  test: {
    include: ['src/**/__tests__/*.spec.ts'],
    setupFiles: ['src/__tests__/uni-stub.ts'],
    // mobile-theme.spec reads the web's tokens (vitest blanks CSS it does not include)
    css: { include: /tokens\.css/ },
  },
})
