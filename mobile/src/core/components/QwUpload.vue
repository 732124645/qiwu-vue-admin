<template>
  <view class="qw-upload">
    <view v-for="o in model" :key="o.id" class="qw-upload__item">
      <wd-icon name="file" custom-class="qw-upload__icon" />
      <text class="qw-upload__name">{{ o.originalName }}</text>
      <text v-if="o.size" class="qw-upload__size">{{ formatSize(o.size) }}</text>
      <view v-if="!disabled" class="qw-upload__remove" @click="remove(o)">
        <wd-icon name="close" />
      </view>
    </view>
    <view v-for="p in pending" :key="p.key" class="qw-upload__item is-pending">
      <wd-loading size="32rpx" />
      <text class="qw-upload__name">{{ p.name }}</text>
    </view>
    <template v-if="!disabled">
      <wd-button
        custom-class="qw-upload__pick"
        size="small"
        variant="plain"
        icon="upload"
        :disabled="remaining() <= 0"
        @click="pick"
      >
        {{ t(images ? 'picker.upload.image' : 'picker.upload.file') }}
      </wd-button>
      <text class="qw-upload__hint">
        {{ t('picker.upload.hint', { size: formatSize(sizeLimit()), limit }) }}
      </text>
    </template>
  </view>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { isPublicBizTag, type FsObjectVo, type StorageBizTag } from '@qiwu/shared'
import { formatSize } from '@/core/format'
import { t } from '@/core/i18n'
import { useUpload, type PickedFile } from '@/core/pickers'

/**
 * Attachments field (the web's FileUpload): `v-model` = the stored objects (`FsObjectVo[]`; send their
 * ids). Picked files go one by one through the backend (uni.uploadFile → POST /api/storage/objects) under
 * `bizTag` (private `attachment` by default; a public tag takes images only, so only images are offered).
 * Removing drops a file from the list only (the stored object stays).
 */
// Names only, no opening a stored file (a private one needs downloadFile with the token +
// openDocument); add it with the first read-only view that shows attachments
defineOptions({ options: { virtualHost: true } })
const model = defineModel<FsObjectVo[]>({ default: () => [] })
const props = withDefaults(
  defineProps<{
    bizTag?: StorageBizTag
    limit?: number
    /**
     * bytes, checked before sending (unset: the server's limit, `storage.max_size_mb`); the server's own
     * limit still applies (413)
     */
    maxSize?: number
    disabled?: boolean
  }>(),
  { bizTag: 'attachment', limit: 10, maxSize: undefined, disabled: false },
)
const { pending, remaining, maxSize: sizeLimit, add, remove } = useUpload({
  model,
  bizTag: () => props.bizTag,
  limit: () => props.limit,
  maxSize: () => props.maxSize,
})
const images = computed(() => isPublicBizTag(props.bizTag))

/** The platform's picker: mp-weixin files from a chat, H5 the browser's, App the album / camera. */
function choose(count: number): Promise<PickedFile[]> {
  const type = images.value ? 'image' : 'all'
  return new Promise((resolve) => {
    const closed = () => resolve([])
    // #ifdef MP-WEIXIN
    uni.chooseMessageFile({
      count,
      type,
      success: (r) => resolve(r.tempFiles.map((f) => ({ path: f.path, name: f.name, size: f.size }))),
      fail: closed,
    })
    // #endif
    // #ifdef H5
    uni.chooseFile({
      count,
      type,
      // uni-h5 answers File objects with the blob URL as `path`
      success: (r) =>
        resolve(
          ([r.tempFiles].flat() as (File & { path: string })[]).map((f) => ({
            path: f.path,
            name: f.name,
            size: f.size,
          })),
        ),
      fail: closed,
    })
    // #endif
    // App offers images only (uni has no general file picker there without a native plugin)
    // #ifdef APP-PLUS
    uni.chooseImage({
      count,
      sizeType: ['compressed'],
      // compressed photos: the server's size limit (413) is enough
      success: (r) => resolve([r.tempFilePaths].flat().map((path) => ({ path }))),
      fail: closed,
    })
    // #endif
  })
}

async function pick() {
  const room = remaining()
  if (room <= 0) return
  void add(await choose(room))
}
</script>

<style scoped>
.qw-upload {
  display: flex;
  flex-direction: column;
  gap: 16rpx;
}

.qw-upload__item {
  display: flex;
  align-items: center;
  gap: 16rpx;
  padding: 16rpx 20rpx;
  border-radius: var(--qw-radius-sm);
  background: var(--qw-surface-2);
  font-size: 26rpx;
}

.qw-upload__name {
  flex: 1;
  overflow: hidden;
  color: var(--qw-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.qw-upload__item.is-pending .qw-upload__name,
.qw-upload__size {
  color: var(--qw-text-3);
}

.qw-upload__remove {
  display: flex;
  padding: 4rpx;
  color: var(--qw-text-3);
}

:deep(.qw-upload__icon) {
  color: var(--qw-brand);
}

:deep(.qw-upload__pick) {
  align-self: flex-start;
}

.qw-upload__hint {
  font-size: 24rpx;
  color: var(--qw-text-3);
}
</style>
