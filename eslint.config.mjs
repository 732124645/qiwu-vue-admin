// ESLint only for apps/web (Vue template rules oxlint cannot check); oxlint covers everything else.
import { globalIgnores } from 'eslint/config'
import { fileURLToPath } from 'node:url'
import {
  configureVueProject,
  defineConfigWithVueTs,
  vueTsConfigs,
} from '@vue/eslint-config-typescript'
import pluginVue from 'eslint-plugin-vue'
import pluginVitest from '@vitest/eslint-plugin'
import pluginOxlint from 'eslint-plugin-oxlint'
import skipFormatting from 'eslint-config-prettier/flat'

// The preset globs every .vue file under rootDir (default: the repo root), which can run out of memory on
// nested checkouts and their node_modules. Only apps/web is linted and no type-aware Vue rules are used,
// so scope the scan to apps/web.
configureVueProject({ rootDir: fileURLToPath(new URL('./apps/web', import.meta.url)) })

export default defineConfigWithVueTs(
  { name: 'web/files', files: ['apps/web/**/*.{vue,ts,mts}'] },
  globalIgnores([
    '**/dist/**',
    '**/coverage/**',
    'apps/server/**',
    'packages/**',
    'scripts/**',
    'mobile/**',
    '*.mjs',
    '*.js',
  ]),
  ...pluginVue.configs['flat/essential'],
  vueTsConfigs.recommended,
  { ...pluginVitest.configs.recommended, files: ['apps/web/src/**/__tests__/*'] },
  ...pluginOxlint.buildFromOxlintConfigFile('.oxlintrc.json'),
  skipFormatting,
)
