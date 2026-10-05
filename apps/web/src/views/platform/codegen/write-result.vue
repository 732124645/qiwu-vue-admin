<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CgWriteResultVo } from '@qiwu/shared'
import CodeViewer from '@/core/components/CodeViewer.vue'

/**
 * Outcome of a write (`openDialog` content). Refused (an existing file differs): nothing was
 * written, each difference shown as Git diff unified hunks (disk → generated). Done: the files written, the ones
 * already identical and the registration lines to add by hand.
 */
defineOptions({ name: 'CodegenWriteResult' })
const { result } = defineProps<{ result: CgWriteResultVo }>()
const emit = defineEmits<{ done: [result: undefined]; cancel: [] }>()
const { t } = useI18n()

const diffs = computed(() =>
  result.conflicts.map((c) => ({ path: c.path, content: c.diff, language: 'diff' })),
)
</script>

<template>
  <div class="codegen-write">
    <template v-if="diffs.length">
      <el-alert
        type="error"
        :title="t('codegen.table.write.refused', { count: diffs.length })"
        :closable="false"
        show-icon
      />
      <CodeViewer :files="diffs" height="56vh" class="codegen-write__diffs" />
    </template>
    <template v-else>
      <el-alert
        type="success"
        :title="
          t('codegen.table.write.done', {
            written: result.written.length,
            unchanged: result.unchanged.length,
          })
        "
        :closable="false"
        show-icon
      />
      <section v-if="result.written.length" class="codegen-write__list">
        <h3>{{ t('codegen.table.write.written') }}</h3>
        <pre>{{ result.written.join('\n') }}</pre>
      </section>
      <section v-if="result.unchanged.length" class="codegen-write__list">
        <h3>{{ t('codegen.table.write.unchanged') }}</h3>
        <pre>{{ result.unchanged.join('\n') }}</pre>
      </section>
      <section v-if="result.registration.length" class="codegen-write__list">
        <h3>{{ t('codegen.table.preview.registration') }}</h3>
        <pre>{{ result.registration.join('\n') }}</pre>
      </section>
    </template>
    <div class="qw-dialog-footer">
      <el-button @click="emit('cancel')">{{ t('codegen.table.close') }}</el-button>
    </div>
  </div>
</template>

<style scoped>
.codegen-write__diffs {
  margin-top: 12px;
}
.codegen-write__list h3 {
  margin: 16px 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--qw-text-2);
}
.codegen-write__list pre {
  max-height: 240px;
  margin: 0;
  padding: 12px 16px;
  overflow: auto;
  font:
    12.5px/1.6 ui-monospace,
    SFMono-Regular,
    Menlo,
    Consolas,
    monospace;
  color: var(--qw-text);
  background: var(--qw-surface-2);
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius-sm);
}
</style>
