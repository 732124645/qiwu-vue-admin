import { defineConfig } from 'vitest/config'

// One config for unit (*.spec.ts) and e2e (*.e2e-spec.ts) specs so `pnpm test <stem>` finds either.
export default defineConfig({
  // read @qiwu/shared from src (its "source" export): no shared rebuild needed before tests;
  // `__vitest__` is the environment that runs globalSetup
  ssr: { resolve: { conditions: ['source'] } },
  environments: { __vitest__: { resolve: { conditions: ['source'] } } },
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts', 'test/**/*.e2e-spec.ts'],
    fileParallelism: false,
    // beforeAll boots the whole AppModule in most e2e files: explicit room over the 10 s default under load
    hookTimeout: 30_000,
    // an e2e case of ~10 requests takes 1-3 s alone, past the 5 s default when ci:local runs Playwright
    // beside it on a loaded machine (wf-form's file binding: 5 s at load 24); hangs still end here
    testTimeout: 20_000,
    // once per run: reset qiwu_test (drop, migrate, seed)
    globalSetup: ['test/setup/global-setup.ts'],
    setupFiles: ['test/setup/load-env.ts'],
    // tests run from source, so locale JSON is read from src (the build copies it to dist/i18n);
    // ENV_FILE: CoreConfigModule's mode file (load-env.ts already put the same values in process.env);
    // CODEGEN_TEMPLATES: the generator's templates from source too
    env: { I18N_DIR: 'src/i18n', ENV_FILE: '.env.test', CODEGEN_TEMPLATES: 'codegen-templates' },
    // Enforced by `vitest run --coverage` (pnpm ci:local); workflow/engine 90
    coverage: {
      include: ['src/**'],
      thresholds: { 'src/core/**': { lines: 80 }, 'src/modules/workflow/engine/**': { lines: 90 } },
    },
  },
})
