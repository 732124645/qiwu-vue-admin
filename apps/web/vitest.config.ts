import { fileURLToPath } from 'node:url'
import { mergeConfig, defineConfig, configDefaults } from 'vitest/config'
import viteConfig from './vite.config.ts'

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'happy-dom',
      exclude: [...configDefaults.exclude, 'e2e/**'],
      setupFiles: ['src/__tests__/setup.ts'],
      // mounting Element Plus widgets (cron-editor) takes seconds on a loaded machine: room over the 5 s default
      testTimeout: 20_000,
      // half the cores, not all but one: the files fight less over the CPU (10 cores, 4 fast + 6 slow):
      // alone 20 s instead of 18 s, beside another full run 38 s instead of 43 s, its slowest test halved
      maxWorkers: '50%',
      // vitest blanks CSS imports, `?raw` too: core/theme.ts reads the design tokens as text, the
      // contrast spec element.css
      css: { include: [/\/styles\/(tokens|element)\.css/] },
      root: fileURLToPath(new URL('./', import.meta.url)),
      // Run element-plus through Vite (see docs/adr/003-validation.md): loaded natively by Node, its `import AsyncValidator from
      // 'async-validator'` gets the CJS exports object, so el-form validate() silently resolves true.
      server: { deps: { inline: ['element-plus'] } },
    },
  }),
)
