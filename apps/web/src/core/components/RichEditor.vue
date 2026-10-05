<script setup lang="ts">
import '@wangeditor-next/editor/dist/css/style.css'
import { nextTick, onBeforeUnmount, shallowRef, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import {
  i18nChangeLanguage,
  type IDomEditor,
  type IEditorConfig,
  type IToolbarConfig,
} from '@wangeditor-next/editor'
import { Editor, Toolbar } from '@wangeditor-next/editor-for-vue'
import { STORAGE_IMAGE_MIMES } from '@qiwu/shared'
import { storageApi } from '@/api/platform/storage/object'
import { isImage, toastUploadError } from '@/core/composables/use-upload'

/**
 * Rich text as HTML (`v-model`, '' when empty; null, a nullable column's, shows as empty), over wangEditor-next. The server cleans every
 * save with the fixed whitelist of `core/sanitize.ts` (no `style`, no `on*`, no iframe, http/https/mailto
 * only), so the toolbar offers only what survives it: no colors, fonts, sizes, alignment, indents or
 * videos. Images upload as public objects under `biz_tag=richtext` and are inserted by their URL (never
 * base64). The editor's own strings follow the app language: a switch re-creates it with the text kept.
 * The toolbar's icon buttons are named by their (translated) tooltip (`aria-label`, visual spec §9).
 */
defineOptions({ name: 'RichEditor' })
const html = defineModel<string | null>({ default: '' })
const {
  placeholder = '',
  disabled = false,
  height = 360,
} = defineProps<{ placeholder?: string; disabled?: boolean; height?: number }>()
const { t, locale } = useI18n()

// every menu writes tags and attributes the whitelist keeps
const toolbarConfig: Partial<IToolbarConfig> = {
  toolbarKeys: [
    'headerSelect',
    'blockquote',
    '|',
    'bold',
    'italic',
    'underline',
    'through',
    'code',
    'clearStyle',
    '|',
    'bulletedList',
    'numberedList',
    '|',
    'insertLink',
    'uploadImage',
    'insertTable',
    'codeBlock',
    'divider',
    '|',
    'undo',
    'redo',
    '|',
    'fullScreen',
  ],
}

/** The file an image menu or a paste hands over: uploaded, then inserted by its public URL. */
async function uploadImage(file: File, insert: (url: string, alt: string, href: string) => void) {
  if (!isImage(file.type)) {
    ElMessage.error(t('upload.error.imageOnly', { name: file.name }))
    return
  }
  try {
    const stored = await storageApi.upload(file, 'richtext')
    if (stored.url) insert(stored.url, file.name, '')
  } catch (e) {
    toastUploadError(e)
  }
}

const editorConfig = (): Partial<IEditorConfig> => ({
  placeholder,
  readOnly: disabled,
  // the default hover bars also offer colors and image widths (inline styles the server strips)
  hoverbarKeys: {
    text: { menuKeys: ['headerSelect', 'insertLink', 'bulletedList', '|', 'bold', 'clearStyle'] },
    image: { menuKeys: ['editImage', 'viewImageLink', 'deleteImage'] },
  },
  MENU_CONF: {
    uploadImage: { allowedFileTypes: [...STORAGE_IMAGE_MIMES], customUpload: uploadImage },
  },
})

const editor = shallowRef<IDomEditor>()
const root = useTemplateRef<HTMLElement>('root')
const valueOf = (e: IDomEditor) => (e.isEmpty() ? '' : e.getHtml())

// wangEditor keeps one global language, read when an editor and its toolbar are built: switch it before
// the keyed block below re-renders with a new editor (the old one is destroyed first)
watch(
  locale,
  (l, before) => {
    if (before) {
      editor.value?.destroy()
      editor.value = undefined
    }
    i18nChangeLanguage(l === 'zh-CN' ? 'zh-CN' : 'en')
  },
  { immediate: true },
)
watch(html, (v) => {
  if (editor.value && (v ?? '') !== valueOf(editor.value)) editor.value.setHtml(v ?? '')
})
watch(
  () => disabled,
  (off) => (off ? editor.value?.disable() : editor.value?.enable()),
)
onBeforeUnmount(() => editor.value?.destroy())

/**
 * The editor is ready; its toolbar renders next. wangEditor's icon buttons carry only a tooltip in the
 * editor's language (`data-tooltip`, a shortcut on its second line): that first line is their name.
 */
async function onCreated(e: IDomEditor) {
  editor.value = e
  await nextTick()
  for (const b of root.value?.querySelectorAll<HTMLButtonElement>('button[data-tooltip]') ?? [])
    if (!b.textContent?.trim()) b.setAttribute('aria-label', b.dataset.tooltip!.split('\n')[0]!)
}
const onChange = (e: IDomEditor) => (html.value = valueOf(e))
const onAlert = (message: string, type: 'success' | 'info' | 'warning' | 'error') =>
  ElMessage({ message, type })
</script>

<template>
  <div ref="root" :key="locale" class="rich-editor" :class="{ 'is-disabled': disabled }">
    <Toolbar v-if="editor" class="rich-editor__toolbar" :editor :default-config="toolbarConfig" />
    <Editor
      class="rich-editor__text"
      :style="{ height: `${height}px` }"
      :default-html="html ?? ''"
      :default-config="editorConfig()"
      @on-created="onCreated"
      @on-change="onChange"
      @custom-alert="onAlert"
    />
  </div>
</template>

<style scoped>
/* wangEditor's theme variables from the design tokens: light and dark follow html.dark */
.rich-editor {
  --w-e-textarea-bg-color: var(--qw-surface);
  --w-e-textarea-color: var(--qw-text);
  --w-e-textarea-border-color: var(--qw-border);
  --w-e-textarea-slight-border-color: var(--qw-border);
  --w-e-textarea-slight-color: var(--qw-text-3);
  --w-e-textarea-slight-bg-color: var(--qw-surface-2);
  --w-e-textarea-selected-border-color: var(--qw-brand-text);
  --w-e-textarea-handler-bg-color: var(--qw-brand);
  --w-e-toolbar-color: var(--qw-text-2);
  --w-e-toolbar-bg-color: var(--qw-surface-2);
  --w-e-toolbar-active-color: var(--qw-text);
  --w-e-toolbar-active-bg-color: var(--qw-brand-weak);
  --w-e-toolbar-disabled-color: var(--qw-text-3);
  --w-e-toolbar-border-color: var(--qw-border);
  --w-e-modal-button-bg-color: var(--qw-surface-2);
  --w-e-modal-button-border-color: var(--qw-border);
  width: 100%;
  line-height: normal;
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius-sm);
}
.rich-editor__toolbar {
  border-bottom: 1px solid var(--qw-border);
  border-radius: var(--qw-radius-sm) var(--qw-radius-sm) 0 0;
}
.rich-editor__text {
  overflow-y: hidden;
}
.rich-editor.is-disabled {
  opacity: 0.7;
}
</style>
