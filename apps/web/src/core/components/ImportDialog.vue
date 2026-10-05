<script setup lang="ts">
import { ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { genFileId, type UploadFile, type UploadInstance, type UploadRawFile } from 'element-plus'
import { IMPORT_MODES, type ImportMode, type ImportResult } from '@qiwu/shared'
import { download } from '@/core/request/http'
import { Icon } from '@/core/icons'

/**
 * Import from .xlsx (`POST /<resources>/import`; see docs/design-notes.md#api-envelope), a dialog content component: download the
 * module's template, pick one file, insert or upsert, then the counts; rows that failed come back as a
 * report to download (`GET /api/excel/reports/:id`, the caller's own, kept 30 min). `name` = the resource
 * as the file names say it (a getter follows the locale); `upload` sends the file (a page reloads its list
 * there once rows were written); `template(filename)` saves the template; `modes` = the ones the endpoint
 * takes (`['insert']` for a resource without a natural key: no mode choice shown).
 * `openDialog(ImportDialog, { name: () => t('menu.iam.user'), template, upload }, { title })`
 */
defineOptions({ name: 'ImportDialog' })
const {
  name,
  upload,
  template,
  modes = [...IMPORT_MODES],
} = defineProps<{
  name: () => string
  upload: (file: File, mode: ImportMode) => Promise<ImportResult>
  template: (filename: string) => Promise<void>
  modes?: ImportMode[]
}>()
const emit = defineEmits<{ done: [result: ImportResult]; cancel: [] }>()
const { t } = useI18n()

const uploadRef = ref<UploadInstance>()
const file = shallowRef<File>()
const mode = ref<ImportMode>(modes[0] ?? 'insert')
const result = shallowRef<ImportResult>()
const submitting = ref(false)
const fetching = ref(false)

function pick(picked: UploadFile) {
  file.value = picked.raw
  result.value = undefined
}
/** a second file replaces the first */
function replace(files: File[]) {
  uploadRef.value?.clearFiles()
  const raw = files[0] as UploadRawFile | undefined
  if (!raw) return
  raw.uid = genFileId()
  uploadRef.value?.handleStart(raw)
}

async function saveTemplate() {
  fetching.value = true
  try {
    await template(`${t('crud.import.templateName', { name: name() })}.xlsx`)
  } catch {
    // the request layer showed why
  } finally {
    fetching.value = false
  }
}

async function submit() {
  if (!file.value || submitting.value) return
  submitting.value = true
  try {
    result.value = await upload(file.value, mode.value)
  } catch {
    // the request layer toasted it (400 bad file, 413 too large, 422 limits, 403, 429)
  } finally {
    submitting.value = false
  }
}

const report = (id: string) =>
  download(
    `/excel/reports/${id}`,
    {},
    `${t('crud.import.reportName', { name: name() })}.xlsx`,
  ).catch(() => undefined)
</script>

<template>
  <div class="import-dialog">
    <el-upload
      ref="uploadRef"
      drag
      :auto-upload="false"
      :limit="1"
      accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      :on-change="pick"
      :on-exceed="replace"
      :on-remove="() => (file = undefined)"
    >
      <Icon icon="lucide:file-spreadsheet" class="import-dialog__icon" />
      <div class="import-dialog__drop">
        {{ t('crud.import.drop') }} <em>{{ t('crud.import.choose') }}</em>
      </div>
      <template #tip>
        <div class="import-dialog__tip">
          <span>{{ t('crud.import.hint') }}</span>
          <el-button link type="primary" :loading="fetching" @click="saveTemplate">
            <el-icon class="el-icon--left"><Icon icon="lucide:download" /></el-icon>
            {{ t('crud.import.template') }}
          </el-button>
        </div>
      </template>
    </el-upload>

    <el-radio-group
      v-if="modes.length > 1"
      v-model="mode"
      class="import-dialog__mode"
      :aria-label="t('crud.import.mode')"
    >
      <el-radio value="insert">{{ t('crud.import.insert') }}</el-radio>
      <el-radio value="upsert">{{ t('crud.import.upsert') }}</el-radio>
    </el-radio-group>

    <el-alert
      v-if="result"
      :type="result.failed ? 'warning' : 'success'"
      :title="
        t(result.failed ? 'crud.import.partial' : 'crud.import.done', {
          inserted: result.inserted,
          updated: result.updated,
          failed: result.failed,
        })
      "
      show-icon
      :closable="false"
      role="status"
    >
      <el-button v-if="result.reportId" link type="primary" @click="report(result.reportId)">
        <el-icon class="el-icon--left"><Icon icon="lucide:file-warning" /></el-icon>
        {{ t('crud.import.report') }}
      </el-button>
    </el-alert>
  </div>
  <div class="qw-dialog-footer">
    <el-button v-if="result" @click="emit('done', result)">{{ t('crud.import.close') }}</el-button>
    <el-button v-else @click="emit('cancel')">{{ t('common.action.cancel') }}</el-button>
    <el-button type="primary" :disabled="!file" :loading="submitting" @click="submit">
      {{ t('crud.import.submit') }}
    </el-button>
  </div>
</template>

<style scoped>
.import-dialog {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.import-dialog__icon {
  width: 36px;
  height: 36px;
  color: var(--qw-text-3);
}
.import-dialog__drop {
  margin-top: 8px;
  font-size: 13px;
  color: var(--qw-text-2);
}
.import-dialog__drop em {
  font-style: normal;
  color: var(--qw-brand-text);
}
.import-dialog__tip {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
  font-size: 12px;
  color: var(--qw-text-3);
}
.import-dialog__mode {
  display: flex;
  gap: 8px;
}
</style>
