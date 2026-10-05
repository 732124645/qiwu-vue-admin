// Mobile Playwright: the built server (apps/server dist, e2e/env.ts: qiwu_mobile_e2e, Redis db 9,
// port 3201) and the H5 build under `vite preview` on 4175 (a parallel checkout's own values from the
// git-ignored apps/server/.env.mobile-e2e.local), in the local Edge (PW_CHANNEL overrides). Needs the server build first (`pnpm -r build` at the repo root).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'
import { H5_PORT, serverDir, serverEnv } from './e2e/env'

if (
  !existsSync(join(serverDir, 'dist/main.js')) ||
  !existsSync(join(serverDir, 'dist/db/reset.js'))
)
  throw new Error('apps/server/dist is missing: run `pnpm -r build` at the repo root first')

const api = `http://127.0.0.1:${serverEnv.PORT}`

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  workers: 1,
  forbidOnly: !!process.env.CI,
  timeout: 30_000,
  reporter: process.env.CI ? 'dot' : 'list',
  use: {
    ...devices['Pixel 7'],
    baseURL: `http://127.0.0.1:${H5_PORT}`,
    channel: process.env.PW_CHANNEL || 'msedge',
    locale: 'zh-CN',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      // reset the database (compiled migrations + seeds) before the server boots on it
      name: 'server',
      command: 'node dist/db/reset.js && node dist/main.js',
      cwd: serverDir,
      env: serverEnv,
      url: `${api}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      name: 'h5',
      command: `uni build && vite preview --outDir dist/build/h5 --host 127.0.0.1 --port ${H5_PORT} --strictPort`,
      env: { API_PROXY_TARGET: api },
      url: `http://127.0.0.1:${H5_PORT}`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
})
