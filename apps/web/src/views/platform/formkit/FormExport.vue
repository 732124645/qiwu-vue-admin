<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FormSchema } from '@qiwu/shared'
import CodeViewer from '@/core/components/CodeViewer.vue'
import { saveBlob } from '@/core/request/http'
import { formFiles } from './export'

/**
 * The form's code (`openDialog` content): `form.json` and `form.vue` in CodeViewer, which copies
 * the shown file; download saves it.
 */
defineOptions({ name: 'FormExport' })
const { schema } = defineProps<{ schema: FormSchema }>()
const emit = defineEmits<{ cancel: [] }>()
const { t } = useI18n()

const files = computed(() => formFiles(schema))
const active = ref<string>()

function download() {
  const file = files.value.find((f) => f.path === active.value) ?? files.value[0]!
  saveBlob(new Blob([file.content], { type: 'text/plain;charset=utf-8' }), file.path)
}
</script>

<template>
  <CodeViewer v-model:active="active" :files="files" height="60vh" />
  <div class="qw-dialog-footer">
    <el-button @click="emit('cancel')">{{ t('formkit.export.close') }}</el-button>
    <el-button type="primary" @click="download">{{ t('formkit.export.download') }}</el-button>
  </div>
</template>
