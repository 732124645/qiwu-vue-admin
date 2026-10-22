import { existsSync } from 'node:fs'
import { defineConfig } from '@playwright/test'

/** 只启动前端预览，所有业务请求由浏览器拦截；退出时由 Playwright 关闭预览进程。 */
export default defineConfig({
  testDir: './e2e-ui',
  testMatch: 'agent-ui-surfaces.spec.ts',
  workers: 1,
  timeout: 90_000,
  reporter: 'list',
  outputDir: 'e2e-ui/test-results',
  use: {
    baseURL: 'http://127.0.0.1:4189',
    channel:
      process.env.PW_CHANNEL ||
      (existsSync('/Applications/Microsoft Edge.app') ? 'msedge' : undefined),
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'vite build && vite preview --host 127.0.0.1 --port 4189 --strictPort',
    url: 'http://127.0.0.1:4189',
    reuseExistingServer: false,
    timeout: 180_000,
    env: { API_PROXY_TARGET: 'http://127.0.0.1:1' },
  },
})
