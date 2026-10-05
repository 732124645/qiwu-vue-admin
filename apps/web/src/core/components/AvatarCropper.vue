<script setup lang="ts" generic="R">
import { nextTick, onBeforeUnmount, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
// defines the <cropper-*> custom elements (cropperjs 2, MIT; vite.config.ts isCustomElement)
import 'cropperjs'
import type { CropperCanvas, CropperImage, CropperSelection } from 'cropperjs'
import { IMAGE_ACCEPT, isImage, toastUploadError } from '@/core/composables/use-upload'
import { Icon } from '@/core/icons'
import IconButton from './IconButton.vue'

/**
 * Avatar crop, a dialog content component (see docs/design-notes.md#storage): pick an image, frame a square (the image always
 * covers the square stage and the frame stays inside it, so the crop has no empty corners), rotate or zoom;
 * save crops a 256×256 PNG and hands it to `upload` (e.g. the profile's POST /api/iam/profile/avatar, where
 * sharp makes the webp) while the button shows loading, then emits `done` with what `upload` resolved.
 * `await openDialog(AvatarCropper, { upload }, { title: () => t('upload.avatar.title'), width: 600 })`
 */
defineOptions({ name: 'AvatarCropper' })
const { upload } = defineProps<{ upload: (file: File) => Promise<R> }>()
const emit = defineEmits<{ done: [result: R]; cancel: [] }>()
const { t } = useI18n()

const SIZE = 256
const selectionId = `avatar-crop-${useId()}`
const input = ref<HTMLInputElement>()
const canvas = ref<CropperCanvas>()
const image = ref<CropperImage>()
const selection = ref<CropperSelection>()
/** object URL of the picked image */
const src = ref('')
/** a new key rebuilds the cropper: a new image, or reset */
const version = ref(0)
const submitting = ref(false)

function clear() {
  if (src.value) URL.revokeObjectURL(src.value)
  src.value = ''
}
onBeforeUnmount(clear)

async function pick(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  ;(e.target as HTMLInputElement).value = ''
  if (!file) return
  if (!isImage(file.type)) {
    ElMessage.error(t('upload.error.imageOnly', { name: file.name }))
    return
  }
  clear()
  const url = URL.createObjectURL(file)
  src.value = url
  version.value++
  await nextTick()
  // a broken file with an image type: say so instead of an empty stage
  image.value?.$ready().catch(() => {
    if (src.value !== url) return
    ElMessage.error(t('upload.avatar.failed'))
    clear()
  })
}

type Box = CustomEvent<{ x: number; y: number; width: number; height: number }>
const stage = () => canvas.value?.getBoundingClientRect()

/** the frame stays on the stage (the image covers it, so the crop is all image) */
function keepInside(e: Event) {
  const r = stage()
  const { x, y, width, height } = (e as Box).detail
  if (r?.width && (x < 0 || y < 0 || x + width > r.width || y + height > r.height))
    e.preventDefault()
}
/** moving or zooming the image never uncovers the stage (1px for rounding) */
function keepCovered(e: Event) {
  const r = stage()
  const { x, y, width, height } = (e as Box).detail
  if (r?.width && (x > 1 || y > 1 || x + width < r.width - 1 || y + height < r.height - 1))
    e.preventDefault()
}

async function save() {
  if (!selection.value || submitting.value) return
  submitting.value = true
  try {
    let file: File
    try {
      const out = await selection.value.$toCanvas({ width: SIZE, height: SIZE })
      const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('empty crop')
      file = new File([blob], 'avatar.png', { type: 'image/png' })
    } catch {
      ElMessage.error(t('upload.avatar.failed'))
      return
    }
    emit('done', await upload(file))
  } catch (e) {
    toastUploadError(e)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="avatar-cropper">
    <div class="avatar-cropper__stage">
      <cropper-canvas v-if="src" :key="version" ref="canvas" class="avatar-cropper__canvas">
        <cropper-image
          ref="image"
          :src="src"
          :alt="t('upload.avatar.image')"
          initial-fit="cover"
          rotatable
          scalable
          translatable
          @change="keepCovered"
        />
        <cropper-shade />
        <cropper-handle action="move" plain />
        <cropper-selection
          :id="selectionId"
          ref="selection"
          aspect-ratio="1"
          initial-coverage="0.8"
          movable
          resizable
          outlined
          @change="keepInside"
        >
          <cropper-grid role="grid" covered />
          <cropper-crosshair centered />
          <cropper-handle action="move" plain />
          <cropper-handle action="nw-resize" />
          <cropper-handle action="ne-resize" />
          <cropper-handle action="sw-resize" />
          <cropper-handle action="se-resize" />
        </cropper-selection>
      </cropper-canvas>
      <button v-else type="button" class="avatar-cropper__empty" @click="input?.click()">
        <Icon icon="lucide:image-up" class="avatar-cropper__empty-icon" />
        <span>{{ t('upload.avatar.empty') }}</span>
      </button>
    </div>
    <div class="avatar-cropper__side">
      <div class="avatar-cropper__preview">
        <cropper-viewer v-if="src" :key="version" :selection="`#${selectionId}`" />
        <Icon v-else icon="lucide:user-round" class="avatar-cropper__preview-icon" />
      </div>
      <span class="avatar-cropper__caption">{{ t('upload.avatar.preview') }}</span>
    </div>
  </div>
  <div class="avatar-cropper__tools">
    <input
      ref="input"
      type="file"
      :accept="IMAGE_ACCEPT"
      class="avatar-cropper__input"
      @change="pick"
    />
    <el-button @click="input?.click()">
      <el-icon class="el-icon--left"><Icon icon="lucide:image-up" /></el-icon>
      {{ t('upload.avatar.choose') }}
    </el-button>
    <template v-if="src">
      <IconButton
        icon="lucide:rotate-ccw"
        :label="t('upload.avatar.rotateLeft')"
        @click="image?.$rotate(-Math.PI / 2)"
      />
      <IconButton
        icon="lucide:rotate-cw"
        :label="t('upload.avatar.rotateRight')"
        @click="image?.$rotate(Math.PI / 2)"
      />
      <IconButton
        icon="lucide:zoom-in"
        :label="t('upload.avatar.zoomIn')"
        @click="image?.$zoom(0.1)"
      />
      <IconButton
        icon="lucide:zoom-out"
        :label="t('upload.avatar.zoomOut')"
        @click="image?.$zoom(-0.1)"
      />
      <IconButton icon="lucide:undo-2" :label="t('upload.avatar.reset')" @click="version++" />
    </template>
  </div>
  <div class="qw-dialog-footer">
    <el-button @click="emit('cancel')">{{ t('common.action.cancel') }}</el-button>
    <el-button type="primary" :disabled="!src" :loading="submitting" @click="save">
      {{ t('crud.action.save') }}
    </el-button>
  </div>
</template>

<style scoped>
.avatar-cropper {
  display: flex;
  gap: 24px;
  align-items: flex-start;
}
/* square: a covering image still covers after a quarter turn */
.avatar-cropper__stage {
  flex: none;
  width: 320px;
  height: 320px;
  overflow: hidden;
  background: var(--qw-surface-2);
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius-sm);
}
.avatar-cropper__canvas {
  width: 100%;
  height: 100%;
}
/* the frame and its corner handles in the brand color (cropperjs reads --theme-color) */
.avatar-cropper__canvas cropper-selection,
.avatar-cropper__canvas cropper-handle[action$='-resize'] {
  --theme-color: var(--qw-brand);
}
.avatar-cropper__empty {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font: inherit;
  font-size: 13px;
  color: var(--qw-text-3);
  cursor: pointer;
  background: transparent;
  border: 1px dashed color-mix(in srgb, var(--qw-text-3) 45%, var(--qw-border));
  border-radius: inherit;
  transition:
    color 0.15s,
    border-color 0.15s;
}
.avatar-cropper__empty:hover {
  color: var(--qw-brand-text);
  border-color: var(--qw-brand);
}
.avatar-cropper__empty-icon {
  width: 32px;
  height: 32px;
}
.avatar-cropper__side {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
}
.avatar-cropper__preview {
  display: grid;
  place-items: center;
  width: 128px;
  height: 128px;
  overflow: hidden;
  color: var(--qw-brand-text);
  background: var(--qw-brand-weak);
  border-radius: 50%;
}
.avatar-cropper__preview cropper-viewer {
  width: 128px;
  height: 128px;
}
.avatar-cropper__preview-icon {
  width: 48px;
  height: 48px;
}
.avatar-cropper__caption {
  font-size: 12px;
  color: var(--qw-text-3);
}
.avatar-cropper__tools {
  display: flex;
  gap: 4px;
  align-items: center;
  margin-top: 16px;
}
.avatar-cropper__tools > .el-button {
  margin-right: 8px;
}
.avatar-cropper__input {
  display: none;
}
</style>
