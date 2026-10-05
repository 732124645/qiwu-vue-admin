import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, defaultClientConditions } from 'vite'
import vue from '@vitejs/plugin-vue'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import { SPA_CSP } from './csp.ts'
import common from './src/locales/zh-CN/common.json' with { type: 'json' }

// dev → the local server (3000); Playwright points it at the e2e server (3200)
const api = process.env.API_PROXY_TARGET || 'http://127.0.0.1:3000'
// object form keeps the browser's Host (the string shorthand sets changeOrigin), so the server sees its
// own origin like behind nginx and the refresh Origin check passes
// /files: public objects of the local storage (see docs/design-notes.md#storage)
const proxy = {
  '/api': { target: api },
  '/files': { target: api },
  '/socket.io': { target: api, ws: true },
}

// The resolver adds `element-plus/es` and per-component style imports while transforming templates, after
// Vite's dependency scan: pre-bundle every style entry up front, else each newly seen component
// re-optimizes and reloads the page (504 Outdated Optimize Dep). Listed from disk: Vite's glob `include`
// expands through the package exports, whose types-first targets have no .d.ts for style/css.
const epComponents = fileURLToPath(
  new URL('./node_modules/element-plus/es/components/', import.meta.url),
)
const epStyles = readdirSync(epComponents)
  .filter((c) => existsSync(`${epComponents}${c}/style/css.mjs`))
  .map((c) => `element-plus/es/components/${c}/style/css`)

// The designer runs from its source (see below). Optimized, its entry src/index.js became one pre-bundled
// file (with src/utils/form.js, where its components register) while its .vue files stayed outside and
// imported the raw src/utils/form.js: two module instances, the designer's components unregistered
// ("Failed to resolve component: dragTool", an empty canvas; the same for the deep config/locale
// imports). So it is excluded: one module graph through the plugins. Its CommonJS/UMD imports (codemirror 5
// + addons, js-beautify) are still pre-bundled, else "does not provide an export named 'default'". The build
// has one graph and converts CommonJS: only dev showed it (`pnpm smoke:web-dev`). Nested `a > b`:
// pnpm keeps them out of apps/web/node_modules. The rest is ESM.
const fcDesignerCjs = [
  'codemirror/lib/codemirror',
  'codemirror/mode/javascript/javascript',
  'codemirror/addon/hint/show-hint',
  'codemirror/addon/hint/javascript-hint',
  'codemirror/addon/hint/anyword-hint',
  'codemirror/addon/display/placeholder',
  'js-beautify',
].map((d) => `@form-create/designer > ${d}`)

const FC_ICON_CSS = /@form-create[\\/]designer[\\/]src[\\/]style[\\/]icon\.css$/
let appTitle: string | undefined

export default defineConfig({
  plugins: [
    {
      name: 'qw-default-app-title',
      configResolved(config) {
        appTitle = config.env.VITE_APP_TITLE
      },
      // Remove an unset/empty marker before Vite's env hook can warn; HTML defaults to zh-CN.
      transformIndexHtml: {
        order: 'pre',
        handler: (html) => (appTitle ? html : html.replace('%VITE_APP_TITLE%', common.app.title)),
      },
    },
    // cropperjs 2 is a set of custom elements (<cropper-canvas>, …): AvatarCropper uses them in its template
    vue({
      template: { compilerOptions: { isCustomElement: (tag) => tag.startsWith('cropper-') } },
    }),
    // Element Plus on demand (see docs/design-notes.md#layering): <el-*> in templates → per-component import + its CSS.
    // Local components stay explicit imports (no dirs scan); template types come from vue-tsc as before.
    // The form designer's .vue sources (see docs/adr/004-form-create.md) get the same: their <el-*> tags import the component + CSS.
    Components({
      resolvers: [ElementPlusResolver()],
      dirs: [],
      dts: false,
      exclude: [
        /[\\/]node_modules[\\/](?!.*@form-create[\\/]designer[\\/]src[\\/])/,
        /[\\/]\.git[\\/]/,
      ],
    }),
  ],
  resolve: {
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      // docs/adr/004-form-create.md: the designer's dist bundle inlines wangeditor@4, so build
      // the designer from its source, where the rich-text component is a separate import we stub.
      { find: /^@form-create\/designer$/, replacement: '@form-create/designer/src/index.js' },
      {
        find: '@form-create/component-wangeditor',
        replacement: fileURLToPath(new URL('./src/stubs/fc-wangeditor.ts', import.meta.url)),
      },
    ],
    // read @qiwu/shared from src (its "source" export) — no rebuild needed during web dev/tests
    conditions: ['source', ...defaultClientConditions],
  },
  css: {
    postcss: {
      plugins: [
        {
          // the designer's icon.css styles bare `.icon-<name>:before` (248 names, `.icon-button` among
          // them: our IconButton got its glyph): keep them to its own `<i class="fc-icon icon-…">`
          postcssPlugin: 'qw-scope-fc-icons',
          Rule(rule, { result }) {
            if (FC_ICON_CSS.test(result.opts.from ?? ''))
              rule.selectors = rule.selectors.map((s) =>
                s.startsWith('.icon-') ? `.fc-icon${s}` : s,
              )
          },
        },
      ],
    },
  },
  server: { proxy },
  optimizeDeps: {
    include: ['element-plus/es', ...epStyles, ...fcDesignerCjs],
    exclude: ['@form-create/designer'],
  },
  // the built app under the production CSP (Playwright runs `vite build && vite preview`)
  preview: { proxy, headers: { 'Content-Security-Policy': SPA_CSP } },
})
