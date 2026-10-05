/// <reference types="vitest/config" />
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import uni from '@dcloudio/vite-plugin-uni'
import { defineConfig, type Plugin } from 'vite'

// H5 dev server / preview: /api and the local storage's public files (/files, avatars) go to the backend
// (Playwright: the mobile e2e server on 3201). The realtime socket in the object form: the string one
// rewrites Host, and the server's Origin check would then see a foreign page (forbidden_origin).
const api = process.env.API_PROXY_TARGET || 'http://127.0.0.1:3000'
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

export default defineConfig({
  // vitest runs plain TypeScript: no uni compiler
  plugins: process.env.VITEST ? [] : [eioGlobals, uni()],
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
  // shared targets ES2023, which esbuild 0.20 (vite 5.2) warns about
  esbuild: { tsconfigRaw: { compilerOptions: { target: 'es2022' } } },
  server: { proxy },
  preview: { proxy },
  test: {
    include: ['src/**/__tests__/*.spec.ts'],
    setupFiles: ['src/__tests__/uni-stub.ts'],
    // mobile-theme.spec reads the web's tokens (vitest blanks CSS it does not include)
    css: { include: /tokens\.css/ },
  },
})
