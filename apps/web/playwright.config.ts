// Playwright: the built server with apps/server/.env.e2e (qiwu_e2e, Redis db 14;
// a git-ignored .env.e2e.local overrides them, e2e/env.ts) and the built web app under `vite preview`
// (SPA CSP header) on E2E_WEB_PORT (default 4173). Needs `pnpm -r build` first.
import { existsSync } from 'node:fs'
import { defineConfig } from '@playwright/test'
import { serverDir, serverEnv } from './e2e/env.ts'

if (!existsSync(`${serverDir}dist/main.js`) || !existsSync(`${serverDir}dist/db/reset.js`))
  throw new Error(
    'apps/server/dist is missing: run `pnpm -r build` before `pnpm --filter @qiwu/web e2e`',
  )

const apiOrigin = `http://127.0.0.1:${serverEnv.PORT}`
const WEB_PORT = Number(serverEnv.E2E_WEB_PORT || 4173)

// Local browser channel: PW_CHANNEL, else an installed Edge, else Chrome, else the bundled
// Chromium (`playwright install chromium`). Playwright always uses a fresh temporary profile.
const INSTALLED: Record<string, Record<string, string>> = {
  darwin: {
    msedge: '/Applications/Microsoft Edge.app',
    chrome: '/Applications/Google Chrome.app',
  },
  linux: { msedge: '/opt/microsoft/msedge', chrome: '/opt/google/chrome' },
  win32: {
    msedge: `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
    chrome: `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  },
}
const installed = INSTALLED[process.platform] ?? {}
const channel =
  process.env.PW_CHANNEL || ['msedge', 'chrome'].find((c) => existsSync(installed[c] ?? ''))

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  workers: 1,
  forbidOnly: !!process.env.CI,
  timeout: 30_000,
  reporter: process.env.CI ? 'dot' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    channel,
    locale: 'zh-CN',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      // Playwright starts web servers before globalSetup: reset the e2e database (compiled migrations
      // + seeds) first so the server boots on a clean one
      name: 'server',
      command: 'node dist/db/reset.js && node dist/main.js',
      cwd: serverDir,
      env: serverEnv,
      url: `${apiOrigin}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      name: 'web',
      command: `vite build && vite preview --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      env: { API_PROXY_TARGET: apiOrigin },
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
})
