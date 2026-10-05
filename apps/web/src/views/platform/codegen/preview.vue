<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { codegenPerms, type CgPreviewVo } from '@qiwu/shared'
import { codegenApi } from '@/api/platform/codegen'
import CodeViewer from '@/core/components/CodeViewer.vue'
import { usePerm } from '@/core/permission'
import { downloadZip, writeConfigs } from './output'

/**
 * Preview of one stored config (`openDialog` content): the rendered files in `CodeViewer` and
 * the registration lines to add by hand; download them as a zip, or write them (where writing is on).
 */
defineOptions({ name: 'CodegenPreview' })
const { id, tableName, writable } = defineProps<{
  id: number
  tableName: string
  writable: boolean
}>()
const emit = defineEmits<{ done: [result: undefined]; cancel: [] }>()
const { t } = useI18n()
const perm = usePerm()
const canWrite = computed(() => writable && perm.has(codegenPerms.write))

const preview = shallowRef<CgPreviewVo>()
const loading = ref(true)
codegenApi
  .preview(id)
  .then((p) => (preview.value = p))
  .catch(() => emit('cancel')) // toasted by the request layer (422: a config the templates refuse)
  .finally(() => (loading.value = false))

const downloading = ref(false)
async function download() {
  downloading.value = true
  await downloadZip([{ id, tableName }])
  downloading.value = false
}
const writing = ref(false)
async function write() {
  writing.value = true
  await writeConfigs([id])
  writing.value = false
}
</script>

<template>
  <div v-loading="loading" class="codegen-preview">
    <template v-if="preview">
      <p class="codegen-preview__count">
        {{ t('codegen.table.preview.files', { count: preview.files.length }) }}
      </p>
      <CodeViewer :files="preview.files" height="60vh" />
      <section v-if="preview.registration.length" class="codegen-preview__registration">
        <h3>{{ t('codegen.table.preview.registration') }}</h3>
        <pre>{{ preview.registration.join('\n') }}</pre>
      </section>
    </template>
    <div class="qw-dialog-footer">
      <el-button @click="emit('cancel')">{{ t('codegen.table.close') }}</el-button>
      <el-button :disabled="!preview" :loading="downloading" @click="download">
        {{ t('codegen.table.action.download') }}
      </el-button>
      <el-button
        v-if="canWrite"
        type="primary"
        :disabled="!preview"
        :loading="writing"
        @click="write"
      >
        {{ t('codegen.table.action.write') }}
      </el-button>
    </div>
  </div>
</template>

<style scoped>
.codegen-preview {
  min-height: 200px;
}
.codegen-preview__count {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--qw-text-3);
}
.codegen-preview__registration h3 {
  margin: 16px 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--qw-text-2);
}
.codegen-preview__registration pre {
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
