<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import type { ThemedToken } from 'shiki/core'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import IconButton from '@/core/components/IconButton.vue'
import { highlight } from '@/core/components/CodeViewer.vue'

const { code, language = '' } = defineProps<{ code: string; language?: string }>()
const { t } = useI18n()
const wrapped = ref(false),
  copying = ref(false),
  copied = ref(false)
const lines = shallowRef<ThemedToken[][] | null>(null)
const ALIASES: Record<string, string> = {
  javascript: 'javascript',
  typescript: 'typescript',
  vue: 'vue',
  json: 'json',
  sql: 'sql',
  diff: 'diff',
  patch: 'diff',
  python: 'python',
  shellscript: 'shellscript',
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  py: 'python',
  sh: 'shellscript',
  bash: 'shellscript',
  shell: 'shellscript',
  html: 'html',
  css: 'css',
}
const grammar = computed(() => {
  const name = language.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  return Object.hasOwn(ALIASES, name) ? ALIASES[name]! : 'text'
})
let sequence = 0,
  timer: ReturnType<typeof setTimeout> | undefined,
  disposed = false
watch(
  () => [code, grammar.value],
  async () => {
    const mine = ++sequence
    lines.value = null
    copied.value = false
    // 大代码仍可完整阅读和复制，避免巨量语法 token 阻塞流式阅读。
    if (code.length > 32_000 || code.split('\n').length > 1000) return
    const result = await highlight(code, grammar.value).catch(() => null)
    if (mine === sequence) lines.value = result
  },
  { immediate: true },
)

/** 复制本次点击时的完整代码，不从带高亮的 DOM 反向提取。 */
async function copy() {
  if (copying.value) return
  copying.value = true
  const value = code
  try {
    await navigator.clipboard.writeText(value)
    if (disposed) return
    copied.value = code === value
    ElMessage.success(t('agent.chat.action.copied'))
    clearTimeout(timer)
    timer = setTimeout(() => (copied.value = false), 1500)
  } catch {
    if (!disposed) ElMessage.error(t('agent.chat.action.copyFailed'))
  } finally {
    copying.value = false
  }
}
onBeforeUnmount(() => {
  disposed = true
  sequence++
  clearTimeout(timer)
})
</script>

<template>
  <section class="agent-md-code">
    <header class="agent-md-code__head">
      <span class="agent-md-code__language" :title="language">{{
        language || t('agent.chat.markdown.plainText')
      }}</span>
      <div class="agent-md-code__actions">
        <IconButton
          icon="lucide:wrap-text"
          :label="t(wrapped ? 'agent.chat.markdown.unwrap' : 'agent.chat.markdown.wrap')"
          :aria-pressed="wrapped"
          @click="wrapped = !wrapped"
        />
        <IconButton
          :icon="copied ? 'lucide:check' : 'lucide:copy'"
          :label="t('agent.chat.markdown.copyCode')"
          :disabled="copying"
          @click="copy"
        />
      </div>
    </header>
    <pre
      class="agent-md-code__body"
      :class="{ 'is-wrapped': wrapped }"
    ><code><template v-if="lines"><template v-for="(line, i) in lines" :key="i"><span v-for="(token, j) in line" :key="j" class="agent-md-code__token" :style="token.htmlStyle">{{ token.content }}</span><template v-if="i < lines.length - 1">{{ '\n' }}</template></template></template><template v-else>{{ code }}</template></code></pre>
  </section>
</template>

<style scoped>
.agent-md-code {
  margin: 0 0 12px;
  overflow: hidden;
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius);
  background: var(--qw-surface-2);
}
.agent-md-code__head {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: space-between;
  min-height: 36px;
  padding: 2px 6px 2px 12px;
  border-bottom: 1px solid var(--qw-border);
}
.agent-md-code__language {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--qw-text-2);
}
.agent-md-code__actions {
  display: flex;
  flex: none;
  gap: 2px;
}
.agent-md-code__body {
  max-height: 560px;
  margin: 0;
  padding: 12px;
  overflow: auto;
  font:
    12.5px/1.7 ui-monospace,
    SFMono-Regular,
    Menlo,
    Consolas,
    monospace;
  color: var(--qw-text);
  border-radius: 0;
  white-space: pre;
}
.agent-md-code__body.is-wrapped {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.agent-md-code__body code {
  padding: 0;
  background: none;
  font: inherit;
  border-radius: 0;
}
.agent-md-code__token {
  color: var(--shiki-light);
  font-style: var(--shiki-light-font-style);
}
</style>
<style>
html.dark .agent-md-code__token {
  color: var(--shiki-dark);
  font-style: var(--shiki-dark-font-style);
}
</style>
