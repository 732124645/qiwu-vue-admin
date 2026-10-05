<script lang="ts">
import type { HighlighterCore, ThemedToken } from 'shiki/core'

/** A file to show; `language` defaults to the one of its extension (else plain text). */
export interface CodeFile {
  path: string
  content: string
  language?: string
}

// shiki/core + the JavaScript regex engine (no WASM, CSP-safe) and only these grammars, each loaded the first
// time a file needs it; `diff` for the generator's write conflicts
const GRAMMARS: Record<string, () => Promise<unknown>> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
}
const BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  vue: 'vue',
  json: 'json',
  sql: 'sql',
  diff: 'diff',
  patch: 'diff',
}
export const languageOf = (f: CodeFile) =>
  f.language ?? BY_EXTENSION[f.path.split('.').pop() ?? ''] ?? 'text'

let core: Promise<HighlighterCore> | undefined
const highlighter = () =>
  (core ??= Promise.all([import('shiki/core'), import('shiki/engine/javascript')]).then(
    ([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) =>
      createHighlighterCore({
        themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')],
        langs: [],
        engine: createJavaScriptRegexEngine(),
      }),
  ))

/**
 * Lines of tokens carrying both themes as CSS variables (`--shiki-light` / `--shiki-dark`: the page's
 * html.dark picks one), or null for a language without a grammar here (shown as plain text).
 */
export async function highlight(code: string, lang: string): Promise<ThemedToken[][] | null> {
  const grammar = GRAMMARS[lang]
  if (!grammar) return null
  const h = await highlighter()
  if (!h.getLoadedLanguages().includes(lang))
    await h.loadLanguage(grammar() as Parameters<HighlighterCore['loadLanguage']>[0])
  return h.codeToTokens(code, {
    lang,
    themes: { light: 'github-light', dark: 'github-dark' },
    defaultColor: false,
  }).tokens
}

export interface FileNode {
  id: string
  label: string
  file?: CodeFile
  children?: FileNode[]
}

/** Paths → a folder tree in the files' order; a folder holding just one folder is shown as one (`a/b/c`). */
export function fileTree(files: CodeFile[]): FileNode[] {
  const root: FileNode[] = []
  for (const file of files) {
    const parts = file.path.split('/')
    let level = root
    parts.forEach((label, i) => {
      const id = parts.slice(0, i + 1).join('/')
      if (i === parts.length - 1) level.push({ id, label, file })
      else {
        let dir = level.find((n) => n.id === id && n.children)
        if (!dir) level.push((dir = { id, label, children: [] }))
        level = dir.children!
      }
    })
  }
  const compact = (nodes: FileNode[]): FileNode[] =>
    nodes.map((n) => {
      while (n.children?.length === 1 && n.children[0]!.children) {
        const only = n.children[0]!
        n = { ...only, label: `${n.label}/${only.label}` }
      }
      return n.children ? { ...n, children: compact(n.children) } : n
    })
  return compact(root)
}
</script>

<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import { Icon } from '@/core/icons'
import IconButton from './IconButton.vue'

/**
 * Read-only code: the files as a folder tree (el-tree) beside the selected one, highlighted by
 * shiki in the light and the dark theme at once (CSS picks by html.dark), line numbers, a copy button.
 * One file: no tree. `v-model:active` = the shown path (default: the first file).
 */
defineOptions({ name: 'CodeViewer' })
const { files, height = '560px' } = defineProps<{ files: CodeFile[]; height?: string }>()
const active = defineModel<string>('active')
const { t } = useI18n()

const tree = computed(() => fileTree(files))
const current = computed(() => files.find((f) => f.path === active.value) ?? files[0])
watch(
  () => files,
  () => {
    if (!files.some((f) => f.path === active.value)) active.value = files[0]?.path
  },
  { immediate: true },
)

const plain = (code: string): ThemedToken[][] =>
  code.split('\n').map((content) => [{ content, offset: 0 }])
const lines = shallowRef<ThemedToken[][]>([])
let seq = 0
watch(
  current,
  async (f) => {
    const mine = ++seq
    // plain text at once, the colors when the grammar is there
    lines.value = plain(f?.content ?? '')
    if (!f) return
    const tokens = await highlight(f.content, languageOf(f)).catch(() => null)
    if (tokens && mine === seq) lines.value = tokens
  },
  { immediate: true },
)

// the async Clipboard API: secure contexts (https, localhost), which the admin is served from
const canCopy = typeof navigator !== 'undefined' && !!navigator.clipboard
const copied = ref(false)
async function copyCurrent() {
  if (!current.value) return
  await navigator.clipboard.writeText(current.value.content)
  copied.value = true
  ElMessage.success(t('code.copied'))
  setTimeout(() => (copied.value = false), 1500)
}

function onNode(node: FileNode) {
  if (node.file) active.value = node.file.path
}
</script>

<template>
  <div class="code-viewer" :style="{ height }">
    <el-scrollbar v-if="files.length > 1" class="code-viewer__files">
      <el-tree
        :data="tree"
        node-key="id"
        :current-node-key="current?.path"
        :expand-on-click-node="true"
        :aria-label="t('code.files')"
        default-expand-all
        highlight-current
        @node-click="onNode"
      >
        <template #default="{ data }: { data: FileNode }">
          <span class="code-viewer__node" :title="data.id">
            <Icon :icon="data.children ? 'lucide:folder' : 'lucide:file-code'" />
            <span>{{ data.label }}</span>
          </span>
        </template>
      </el-tree>
    </el-scrollbar>
    <section class="code-viewer__main">
      <header class="code-viewer__head">
        <span class="code-viewer__path">{{ current?.path }}</span>
        <IconButton
          v-if="canCopy && current"
          :icon="copied ? 'lucide:check' : 'lucide:copy'"
          :label="t('code.copy')"
          @click="copyCurrent"
        />
      </header>
      <el-scrollbar class="code-viewer__body">
        <pre
          class="code-viewer__code"
        ><code><span v-for="(line, i) in lines" :key="i" class="code-viewer__line"><span v-for="(token, j) in line" :key="j" :style="token.htmlStyle">{{ token.content }}</span>
</span></code></pre>
      </el-scrollbar>
    </section>
  </div>
</template>

<style scoped>
.code-viewer {
  display: flex;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius);
}
.code-viewer__files {
  flex: none;
  width: 280px;
  background: var(--qw-surface);
  border-right: 1px solid var(--qw-border);
}
.code-viewer__files :deep(.el-tree) {
  padding: 8px 4px;
  background: transparent;
}
.code-viewer__node {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  min-width: 0;
  font-size: 13px;
  white-space: nowrap;
}
.code-viewer__node svg {
  flex: none;
  width: 16px;
  height: 16px;
  color: var(--qw-text-3);
}
.code-viewer__main {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  background: var(--qw-surface-2);
}
.code-viewer__head {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
  height: 40px;
  padding: 0 8px 0 16px;
  border-bottom: 1px solid var(--qw-border);
}
.code-viewer__path {
  overflow: hidden;
  font-size: 12px;
  color: var(--qw-text-2);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.code-viewer__body {
  flex: 1;
  min-height: 0;
}
.code-viewer__code {
  margin: 0;
  padding: 12px 0;
  font:
    12.5px/1.6 ui-monospace,
    SFMono-Regular,
    Menlo,
    Consolas,
    monospace;
  color: var(--qw-text);
  counter-reset: line;
}
.code-viewer__line {
  display: block;
  padding-right: 16px;
}
/* line numbers: not selected or copied with the code */
.code-viewer__line::before {
  display: inline-block;
  width: 3.5em;
  margin-right: 16px;
  padding-right: 8px;
  color: var(--qw-text-3);
  text-align: right;
  content: counter(line);
  counter-increment: line;
  user-select: none;
}
/* the theme colors come with each token; html.dark switches to the dark theme */
.code-viewer__line > span {
  color: var(--shiki-light);
  font-style: var(--shiki-light-font-style);
}
</style>

<style>
/* unscoped: the dark switch sits on <html>, outside the component */
html.dark .code-viewer__line > span {
  color: var(--shiki-dark);
  font-style: var(--shiki-dark-font-style);
}
</style>
