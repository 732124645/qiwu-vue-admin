<script setup lang="ts">
import { computed, onBeforeUnmount, onDeactivated, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import {
  IM_EMOJI_CATEGORIES,
  IM_IMAGE_EXTS,
  IM_STICKER_CODES,
  imCodePoints,
  imTextOk,
} from '@qiwu/shared'
import { imBlobKey, type ImRoomRecord } from '@qiwu/shared/im-client'
import { imApi } from '@/api/platform/im'
import IconButton from '@/core/components/IconButton.vue'
import { useImCallsStore } from '@/core/im/calls-store'
import { imVoiceRecorder, stopImVoicePlayback } from '@/core/im/voice'
import { useImStore } from '@/core/im/im-store'
import AuthImage from './AuthImage.vue'
import { extOf } from './im-view'

/**
 * 输入框：Enter 发送、Shift+Enter 换行（输入法组字中不发送）；Unicode emoji 面板插入字符；表情面板分
 * 内置（静态图片，零接口请求）与我的（自定义表情，可上传、删除，右键可移到最前）；图片与文件先按限额校验再进发件箱。
 */
defineOptions({ name: 'ImComposer' })
const props = defineProps<{ room: ImRoomRecord }>()
const { t } = useI18n()
const im = useImStore()
const calls = useImCallsStore()
const recording = ref(false),
  recordBusy = ref(false),
  elapsed = ref(0)
let recordGeneration = 0,
  recordClock: ReturnType<typeof setInterval> | null = null
function cancelVoice() {
  recordGeneration++
  imVoiceRecorder.cancel()
  recording.value = recordBusy.value = false
  if (recordClock) clearInterval(recordClock)
  recordClock = null
}
async function recordVoice() {
  if (recordBusy.value) return
  if (recording.value) {
    recordBusy.value = true
    imVoiceRecorder.stop()
    return
  }
  if (
    recordBusy.value ||
    closed.value ||
    !im.options?.voiceEnabled ||
    calls.view.current ||
    calls.view.media.state !== 'idle'
  )
    return
  const at = ++recordGeneration
  recordBusy.value = true
  stopImVoicePlayback()
  try {
    await imVoiceRecorder.start({
      maxSeconds: im.options.voiceMaxSeconds ?? 60,
      onStop: async (file) => {
        if (at !== recordGeneration) return
        recording.value = false
        recordBusy.value = true
        if (recordClock) clearInterval(recordClock)
        recordClock = null
        try {
          if (file.size > (im.options?.voiceMaxMb ?? 5) * 1024 * 1024) {
            ElMessage.error(t('im.voice.tooLarge'))
            return
          }
          await im.sendVoice(props.room.roomId, file)
        } catch {
          if (at === recordGeneration) ElMessage.error(t('im.voice.saveFailed'))
        } finally {
          if (at === recordGeneration) recordBusy.value = false
        }
      },
      onError: () => {
        if (at === recordGeneration) {
          cancelVoice()
          ElMessage.error(t('im.voice.failed'))
        }
      },
    })
    if (at !== recordGeneration) return
    recording.value = true
    elapsed.value = 0
    recordClock = setInterval(() => elapsed.value++, 1000)
  } catch {
    if (at === recordGeneration) ElMessage.error(t('im.voice.failed'))
  } finally {
    if (at === recordGeneration) recordBusy.value = false
  }
}
watch(
  () => calls.view.current,
  (call) => {
    if (call) cancelVoice()
  },
)
watch(
  () => ['idle', 'locked', 'disabled'].includes(im.state),
  (off) => {
    if (off) cancelVoice()
  },
)
onBeforeUnmount(cancelVoice)
onDeactivated(cancelVoice)
const text = ref('')
const sending = ref(false)
const input = ref<{ textarea?: HTMLTextAreaElement }>()
const emojiOpen = ref(false)
const stickerOpen = ref(false)
const stickerTab = ref<'builtin' | 'mine'>('builtin')
const imagePicker = ref<HTMLInputElement>()
const filePicker = ref<HTMLInputElement>()
const stickerPicker = ref<HTMLInputElement>()
const uploadingSticker = ref(false)

const closed = computed(() => !!props.room.detail?.closedAt)
const maxChars = computed(() => im.options?.textMaxChars ?? 5000)
const tooLong = computed(() => imCodePoints(text.value) > maxChars.value)
const canSend = computed(
  () => !closed.value && !sending.value && imTextOk(text.value) && !tooLong.value,
)

async function sendText() {
  if (!canSend.value) return
  const value = text.value
  sending.value = true
  try {
    await im.send(props.room.roomId, { kind: 'text', text: value })
    if (text.value === value) text.value = ''
  } catch {
    ElMessage.error(t('im.message.failed'))
  } finally {
    sending.value = false
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
  e.preventDefault()
  void sendText()
}

/** 在光标处插入 emoji。 */
function insertEmoji(ch: string) {
  const el = input.value?.textarea
  if (!el) {
    text.value += ch
    return
  }
  const start = el.selectionStart ?? text.value.length
  const end = el.selectionEnd ?? start
  text.value = text.value.slice(0, start) + ch + text.value.slice(end)
  requestAnimationFrame(() => {
    el.focus()
    el.setSelectionRange(start + ch.length, start + ch.length)
  })
}

function sendSticker(draft: { stickerCode: string } | { stickerId: number }) {
  stickerOpen.value = false
  void im.send(props.room.roomId, { kind: 'sticker', ...draft })
}

/** 选中的文件：扩展名与大小按 `/options` 校验，通过才进发件箱。 */
function onPick(ev: Event, kind: 'image' | 'file') {
  const target = ev.target as HTMLInputElement
  const files = [...(target.files ?? [])]
  target.value = ''
  const o = im.options
  if (!o) return
  const exts = kind === 'image' ? o.imageExts : o.fileExts
  for (const file of files) {
    if (!exts.includes(extOf(file.name))) {
      ElMessage.error(t('im.composer.badType'))
      continue
    }
    if (file.size > o.fileMaxMb * 1024 * 1024) {
      ElMessage.error(t('im.composer.tooLarge', { mb: o.fileMaxMb }))
      continue
    }
    void im.sendFile(props.room.roomId, file, kind)
  }
}

async function onStickerUpload(ev: Event) {
  const target = ev.target as HTMLInputElement
  const file = target.files?.[0]
  target.value = ''
  if (!file || uploadingSticker.value) return
  uploadingSticker.value = true
  try {
    await imApi.uploadSticker(file, file.name)
    await im.engine()?.loadStickers()
  } catch {
    // 接口错误已提示
  } finally {
    uploadingSticker.value = false
  }
}

/** 我的表情右键菜单：移到最前（其余保持原顺序）或删除。 */
async function onMine(command: string, id: number) {
  if (command === 'remove') return removeSticker(id)
  try {
    await imApi.reorderStickers([id, ...im.stickers.filter((x) => x.id !== id).map((x) => x.id)])
    await im.engine()?.loadStickers()
  } catch {
    // 接口错误已提示
  }
}

async function removeSticker(id: number) {
  try {
    await imApi.removeSticker(id)
    await im.engine()?.loadStickers()
  } catch {
    // 接口错误已提示
  }
}

const imageAccept = computed(() =>
  (im.options?.imageExts ?? IM_IMAGE_EXTS).map((x) => `.${x}`).join(','),
)
const fileAccept = computed(() => (im.options?.fileExts ?? []).map((x) => `.${x}`).join(','))
</script>

<template>
  <div class="im-composer">
    <p v-if="closed" class="im-composer__closed">{{ t('im.composer.closed') }}</p>
    <template v-else>
      <div class="im-composer__tools">
        <el-button
          v-if="im.options?.voiceEnabled"
          :loading="recordBusy"
          :disabled="recordBusy || !!calls.view.current || calls.view.media.state !== 'idle'"
          :aria-pressed="recording"
          @click="recordVoice"
          >{{
            recording ? t('im.voice.finish', { seconds: elapsed }) : t('im.voice.record')
          }}</el-button
        >
        <el-button v-if="recording || recordBusy" @click="cancelVoice">{{
          t('im.voice.cancel')
        }}</el-button>
        <el-popover v-model:visible="emojiOpen" trigger="click" placement="top-start" :width="340">
          <template #reference>
            <IconButton
              icon="lucide:smile"
              :label="t('im.composer.emoji')"
              :aria-expanded="emojiOpen"
            />
          </template>
          <div class="im-composer__emoji" role="dialog" :aria-label="t('im.composer.emoji')">
            <section v-for="c in IM_EMOJI_CATEGORIES" :key="c.category">
              <h3 class="im-composer__heading">{{ t(`im.emoji.${c.category}`) }}</h3>
              <div class="im-composer__grid">
                <button
                  v-for="ch in c.items"
                  :key="ch"
                  type="button"
                  class="im-composer__emoji-item"
                  :aria-label="ch"
                  @click="insertEmoji(ch)"
                >
                  {{ ch }}
                </button>
              </div>
            </section>
          </div>
        </el-popover>
        <el-popover
          v-model:visible="stickerOpen"
          trigger="click"
          placement="top-start"
          :width="380"
        >
          <template #reference>
            <IconButton
              icon="lucide:sticker"
              :label="t('im.composer.sticker')"
              :aria-expanded="stickerOpen"
            />
          </template>
          <el-tabs v-model="stickerTab" class="im-composer__stickers">
            <el-tab-pane :label="t('im.composer.builtin')" name="builtin">
              <div class="im-composer__sticker-grid">
                <button
                  v-for="code in IM_STICKER_CODES"
                  :key="code"
                  type="button"
                  class="im-composer__sticker"
                  :aria-label="t(`im.sticker.${code}`)"
                  :title="t(`im.sticker.${code}`)"
                  @click="sendSticker({ stickerCode: code })"
                >
                  <img :src="`/im/stickers/${code}.png`" alt="" draggable="false" />
                </button>
              </div>
            </el-tab-pane>
            <el-tab-pane :label="t('im.composer.mine')" name="mine">
              <div class="im-composer__sticker-grid">
                <span v-for="(s, i) in im.stickers" :key="s.id" class="im-composer__mine">
                  <el-dropdown trigger="contextmenu" @command="(c: string) => onMine(c, s.id)">
                    <button
                      type="button"
                      class="im-composer__sticker"
                      :aria-label="t('im.composer.mineItem', { id: s.id })"
                      @click="sendSticker({ stickerId: s.id })"
                    >
                      <AuthImage
                        :blob-key="imBlobKey.sha(s.sha256)"
                        :room-id="null"
                        :fetch="() => imApi.stickerFile(s.id)"
                        alt=""
                      />
                    </button>
                    <template #dropdown>
                      <el-dropdown-menu>
                        <el-dropdown-item v-if="i > 0" command="front">{{
                          t('im.composer.stickerToFront')
                        }}</el-dropdown-item>
                        <el-dropdown-item command="remove">{{
                          t('im.composer.removeSticker')
                        }}</el-dropdown-item>
                      </el-dropdown-menu>
                    </template>
                  </el-dropdown>
                  <button
                    type="button"
                    class="im-composer__remove"
                    :aria-label="t('im.composer.removeSticker')"
                    @click="removeSticker(s.id)"
                  >
                    ×
                  </button>
                </span>
              </div>
              <p v-if="!im.stickers.length" class="im-composer__hint">
                {{ t('im.composer.mineEmpty') }}
              </p>
              <el-button
                size="small"
                :loading="uploadingSticker"
                :disabled="im.stickers.length >= (im.options?.stickerMax ?? 100)"
                @click="stickerPicker?.click()"
                >{{ t('im.composer.uploadSticker') }}</el-button
              >
              <input
                ref="stickerPicker"
                type="file"
                :accept="imageAccept"
                hidden
                @change="onStickerUpload"
              />
            </el-tab-pane>
          </el-tabs>
        </el-popover>
        <IconButton
          icon="lucide:image"
          :label="t('im.composer.image')"
          @click="imagePicker?.click()"
        />
        <IconButton
          icon="lucide:paperclip"
          :label="t('im.composer.file')"
          @click="filePicker?.click()"
        />
        <input
          ref="imagePicker"
          type="file"
          multiple
          :accept="imageAccept"
          hidden
          :aria-label="t('im.composer.image')"
          @change="(e) => onPick(e, 'image')"
        />
        <input
          ref="filePicker"
          type="file"
          multiple
          :accept="fileAccept"
          hidden
          :aria-label="t('im.composer.file')"
          @change="(e) => onPick(e, 'file')"
        />
      </div>
      <el-input
        ref="input"
        v-model="text"
        type="textarea"
        resize="none"
        :autosize="{ minRows: 2, maxRows: 6 }"
        :placeholder="t('im.composer.placeholder')"
        :aria-label="t('im.composer.label')"
        @keydown="onKey"
      />
      <div class="im-composer__foot">
        <span v-if="tooLong" class="im-composer__error">{{
          t('im.composer.tooLong', { max: maxChars })
        }}</span>
        <el-button type="primary" :loading="sending" :disabled="!canSend" @click="sendText">{{
          t('im.composer.send')
        }}</el-button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.im-composer {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 16px 12px;
  border-top: 1px solid var(--qw-border);
}
.im-composer__closed {
  margin: 8px 0;
  color: var(--qw-text-3);
  text-align: center;
}
.im-composer__tools {
  display: flex;
  gap: 2px;
}
.im-composer__foot {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: flex-end;
}
.im-composer__error {
  font-size: 12px;
  color: var(--qw-danger);
}
.im-composer__emoji {
  max-height: 280px;
  overflow-y: auto;
}
.im-composer__heading {
  margin: 4px 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--qw-text-3);
}
.im-composer__grid {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
}
.im-composer__emoji-item,
.im-composer__sticker,
.im-composer__remove {
  padding: 2px;
  font: inherit;
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: var(--qw-radius-sm);
}
.im-composer__emoji-item {
  font-size: 20px;
  line-height: 32px;
}
.im-composer__emoji-item:hover,
.im-composer__sticker:hover {
  background: var(--qw-surface-2);
}
.im-composer__sticker-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 4px;
  max-height: 260px;
  margin-bottom: 8px;
  overflow-y: auto;
}
.im-composer__sticker img,
.im-composer__sticker :deep(img) {
  width: 52px;
  height: 52px;
  object-fit: contain;
}
.im-composer__mine {
  position: relative;
}
.im-composer__remove {
  position: absolute;
  top: -4px;
  right: -4px;
  width: 18px;
  height: 18px;
  font-size: 12px;
  line-height: 14px;
  color: var(--qw-on-brand);
  background: var(--qw-danger);
  border-radius: 50%;
  opacity: 0;
}
.im-composer__mine:hover .im-composer__remove,
.im-composer__remove:focus-visible {
  opacity: 1;
}
.im-composer__hint {
  font-size: 12px;
  color: var(--qw-text-3);
}
</style>
