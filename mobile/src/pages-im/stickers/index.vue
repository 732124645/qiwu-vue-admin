<template>
  <view class="qw-im-stk">
    <view class="qw-sec">
      <text class="qw-sec__title">{{ t('im.mine') }} {{ list.length }}/{{ max }}</text>
      <text class="qw-sec__link" role="button" @click="add">{{ t('im.addSticker') }}</text>
    </view>
    <view class="qw-card qw-im-stk__grid">
      <view v-for="s in list" :key="s.id" class="qw-im-stk__item" role="button" @click="actions(s)">
        <image class="qw-im-stk__img" :src="urls[s.id] || ''" mode="aspectFit" :aria-label="t('im.preview.sticker')" />
      </view>
      <text v-if="!list.length" class="qw-im-stk__empty">{{ t('im.noStickers') }}</text>
    </view>
    <text class="qw-form__hint qw-im-stk__hint">{{ t('im.stickerHint') }}</text>
  </view>
</template>

<script setup lang="ts">
import { computed, reactive, ref, shallowRef, watch } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { IM_LIMITS, type ImSticker } from '@qiwu/shared'
import { t } from '@/core/i18n'
import { stickerFileUrl } from '@/core/im/api'
import { blobUrl } from '@/core/im/blob-app'
import { imCurrent, imOptions, imStart, imState } from '@/core/im/client'
import { chooseUploadFiles } from '@/core/pickers'
import { api, errorText, upload } from '@/core/request'

/**
 * My own stickers (subpackage pages-im): the list from the local snapshot (revalidated with its ETag), images
 * from the attachment cache by content hash. Add one from the photo library (the server normalises it to a
 * small webp, at most `stickerMax`); tap one to move it to the front or delete it. Messages already sent keep
 * their own copy.
 */
const list = shallowRef<ImSticker[]>([])
const urls = reactive<Record<number, string>>({})
const busy = ref(false)
const max = computed(() => imOptions.value?.stickerMax ?? IM_LIMITS.stickerMax)
const toast = (title: string) => uni.showToast({ title, icon: 'none' })

watch(imState, () => {
  if (imCurrent()) return
  list.value = []
  for (const key of Object.keys(urls)) delete urls[Number(key)]
}, { flush: 'sync' })

async function load(revalidate = true) {
  const ctx = imCurrent()
  if (!ctx) return
  if (revalidate) await ctx.engine.loadStickers().catch(() => {})
  if (ctx !== imCurrent()) return
  const cached = await ctx.cache.getStickers()
  if (ctx !== imCurrent()) return
  list.value = cached?.data ?? []
  for (const s of list.value)
    if (!urls[s.id])
      blobUrl(ctx.cache, `s:${s.sha256}`, null, stickerFileUrl(s.id)).then(
        (u) => {
          if (ctx === imCurrent()) urls[s.id] = u
        },
        () => {},
      )
}

async function add() {
  const ctx = imCurrent()
  if (!ctx || busy.value) return
  const [file] = await chooseUploadFiles(1, true)
  if (!file || ctx !== imCurrent()) return
  busy.value = true
  try {
    await upload('/im/stickers', file.path, undefined, { silent: true })
    if (ctx === imCurrent()) await load()
  } catch (e) {
    toast(errorText(e))
  } finally {
    busy.value = false
  }
}

/** 点按一个表情：移到最前（`PUT /im/stickers/order`，其余保持原顺序）或删除。 */
function actions(s: ImSticker) {
  const first = list.value[0]?.id === s.id
  const items = [
    ...(first ? [] : [{ label: t('im.stickerToFront'), run: () => toFront(s) }]),
    { label: t('im.stickerDelete'), run: () => remove(s) },
  ]
  uni.showActionSheet({
    itemList: items.map((i) => i.label),
    success: ({ tapIndex }) => items[tapIndex]?.run(),
  })
}

async function toFront(s: ImSticker) {
  const ctx = imCurrent()
  if (!ctx || busy.value) return
  busy.value = true
  try {
    const ids = [s.id, ...list.value.filter((x) => x.id !== s.id).map((x) => x.id)]
    await api.put('/im/stickers/order', { ids }, { silent: true })
    if (ctx === imCurrent()) await load()
  } catch (e) {
    toast(errorText(e))
  } finally {
    busy.value = false
  }
}

function remove(s: ImSticker) {
  const ctx = imCurrent()
  if (!ctx) return
  uni.showModal({
    content: t('im.deleteSticker'),
    success: async ({ confirm }) => {
      if (!confirm || ctx !== imCurrent()) return
      try {
        await api.delete(`/im/stickers/${s.id}`, { silent: true })
        if (ctx === imCurrent()) await load()
      } catch (e) {
        toast(errorText(e))
      }
    },
  })
}

onLoad(async () => {
  uni.setNavigationBarTitle({ title: t('im.myStickers') })
  await imStart()
  await load(false)
  await load()
})
</script>

<style>
.qw-im-stk {
  min-height: 100vh;
  background: var(--qw-canvas);
}

.qw-im-stk__grid {
  display: flex;
  flex-wrap: wrap;
  margin: 0 var(--qw-space-4);
  padding: var(--qw-space-2);
}

.qw-im-stk__item {
  box-sizing: border-box;
  width: 25%;
  padding: 12rpx;
}

.qw-im-stk__img {
  width: 100%;
  height: 140rpx;
}

.qw-im-stk__empty {
  padding: var(--qw-space-3);
  font-size: var(--qw-fs-body);
  color: var(--qw-text-3);
}

.qw-im-stk__hint {
  display: block;
  margin: var(--qw-space-2) var(--qw-space-4);
}
</style>
