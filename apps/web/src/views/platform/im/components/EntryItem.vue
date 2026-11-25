<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox, type DropdownInstance } from 'element-plus'
import { imEntryEdit, type ImDirectoryUser } from '@qiwu/shared'
import { imBlobKey, type ImEntryRecord, type ImRoomRecord } from '@qiwu/shared/im-client'
import { imApi } from '@/api/platform/im'
import IconButton from '@/core/components/IconButton.vue'
import { useImStore } from '@/core/im/im-store'
import { saveBlob } from '@/core/request/http'
import AuthImage from './AuthImage.vue'
import VoiceMessage from './VoiceMessage.vue'
import { boxButtons, eventText, fileSize, initialOf, shortTime } from './im-view'

/**
 * 一条消息：文字（纯文本，保留换行）、内置/自定义表情、图片缩略图（点开看原图）、文件（授权下载）、撤回
 * 提示与系统事件。右键或“更多”按钮打开操作：复制、编辑、撤回、添加到表情、下载；按钮是否出现按本人、
 * 时间窗与群角色判断，服务端仍是最终裁决。
 */
defineOptions({ name: 'ImEntryItem' })
const props = defineProps<{
  entry: ImEntryRecord
  room: ImRoomRecord
  users: Map<number, ImDirectoryUser>
  mine: boolean
}>()
const emit = defineEmits<{ preview: [url: string] }>()
const { t } = useI18n()
const im = useImStore()
const menu = ref<DropdownInstance>()
const busy = ref(false)

const e = computed(() => props.entry)
const author = computed(() => {
  const id = e.value.authorId
  return (id !== null && props.users.get(id)?.displayName) || e.value.authorLabel || ''
})
const avatar = computed(() =>
  e.value.authorId === null ? null : (props.users.get(e.value.authorId)?.avatarUrl ?? null),
)
const recalled = computed(() => e.value.recalledAt !== null)
const ageMinutes = computed(() => (Date.now() - Date.parse(e.value.createdAt)) / 60_000)
const opts = computed(() => im.options)
const closed = computed(() => !!props.room.detail?.closedAt)

const canEdit = computed(
  () =>
    props.mine &&
    !closed.value &&
    e.value.kind === 'text' &&
    !recalled.value &&
    !!opts.value?.editMinutes &&
    ageMinutes.value < opts.value.editMinutes,
)
/** 本人在撤回时间窗内；群主/管理员撤回他人（是否允许看群规则，服务端裁决）。 */
const canRecall = computed(() => {
  if (recalled.value || closed.value || e.value.kind === 'event' || !opts.value) return false
  const inWindow = !!opts.value.recallMinutes && ageMinutes.value < opts.value.recallMinutes
  if (props.mine) return inWindow
  const role = props.room.detail?.role
  return (
    props.room.detail?.kind === 'group' &&
    (role === 'owner' || role === 'moderator') &&
    (opts.value.groupRecallAnytime || inWindow)
  )
})
const canSticker = computed(
  () =>
    !recalled.value &&
    (e.value.kind === 'image' || (e.value.kind === 'sticker' && !!e.value.attachment)),
)
const hasActions = computed(
  () =>
    e.value.kind !== 'event' &&
    !recalled.value &&
    (e.value.kind === 'text' ||
      canEdit.value ||
      canRecall.value ||
      canSticker.value ||
      e.value.kind === 'file'),
)

const fileOf = (thumb: boolean) => () => imApi.entryFile(props.room.roomId, e.value.seq, thumb)

async function preview() {
  const a = e.value.attachment
  if (!a) return
  try {
    emit(
      'preview',
      await im.blobUrl(imBlobKey.object(a.objectId), props.room.roomId, fileOf(false)),
    )
  } catch {
    ElMessage.error(t('im.message.loadFailed'))
  }
}

async function download() {
  const a = e.value.attachment
  if (!a || busy.value) return
  busy.value = true
  try {
    saveBlob(await fileOf(false)(), a.name)
  } catch {
    ElMessage.error(t('im.message.loadFailed'))
  } finally {
    busy.value = false
  }
}

async function onCommand(command: string) {
  const engine = im.engine()
  if (!engine) return
  try {
    if (command === 'copy') await navigator.clipboard.writeText(e.value.text ?? '')
    else if (command === 'download') await download()
    else if (command === 'sticker') {
      await imApi.stickerFromEntry(props.room.roomId, e.value.seq)
      await engine.loadStickers()
      ElMessage.success(t('im.message.stickerAdded'))
    } else if (command === 'recall') {
      await ElMessageBox.confirm(
        t('im.message.recallConfirm'),
        t('im.message.recall'),
        boxButtons(),
      )
      await engine.recall(props.room.roomId, e.value.seq)
    } else if (command === 'edit') {
      const { value } = await ElMessageBox.prompt('', t('im.message.editTitle'), {
        ...boxButtons(),
        type: undefined,
        inputValue: e.value.text ?? '',
        inputType: 'textarea',
        inputValidator: (v: string) =>
          imEntryEdit.safeParse({ text: v, rev: e.value.rev }).success ||
          t('im.message.editInvalid'),
      })
      await engine.edit(props.room.roomId, e.value.seq, value, e.value.rev)
    }
  } catch (err) {
    // 取消对话框不算错误；接口错误显示服务端翻译过的说明
    if (err === 'cancel' || err === 'close') return
    const message = (err as { message?: string })?.message
    if (message) ElMessage.error(message)
  }
}

/** 右键打开同一个操作菜单（键盘用户用“更多”按钮）。 */
function onContext(ev: MouseEvent) {
  if (!hasActions.value) return
  ev.preventDefault()
  menu.value?.handleOpen()
}
</script>

<template>
  <div v-if="e.kind === 'event'" class="im-entry im-entry--event" :data-seq="e.seq">
    {{ eventText(e, users) }}
  </div>
  <div v-else-if="recalled" class="im-entry im-entry--event" :data-seq="e.seq">
    {{ mine ? t('im.message.recalledMine') : t('im.message.recalled', { name: author }) }}
  </div>
  <div v-else class="im-entry" :class="{ 'im-entry--mine': mine }" :data-seq="e.seq">
    <span class="im-entry__avatar" aria-hidden="true">
      <img v-if="avatar" :src="avatar" alt="" />
      <template v-else>{{ initialOf(author) }}</template>
    </span>
    <div class="im-entry__body">
      <div class="im-entry__meta">
        <span v-if="!mine" class="im-entry__author">{{ author }}</span>
        <time :datetime="e.createdAt">{{ shortTime(e.createdAt) }}</time>
        <span v-if="e.editedAt" class="im-entry__edited">{{ t('im.message.edited') }}</span>
      </div>
      <div class="im-entry__bubble-row">
        <div
          class="im-entry__bubble"
          :class="{ 'im-entry__bubble--plain': e.kind !== 'text' && e.kind !== 'file' }"
          @contextmenu="onContext"
        >
          <p v-if="e.kind === 'text'" class="im-entry__text">{{ e.text }}</p>
          <img
            v-else-if="e.kind === 'sticker' && e.stickerCode"
            class="im-entry__sticker"
            :src="`/im/stickers/${e.stickerCode}.png`"
            :alt="t(`im.sticker.${e.stickerCode}`)"
            draggable="false"
          />
          <AuthImage
            v-else-if="e.kind === 'sticker' && e.attachment"
            class="im-entry__sticker"
            :blob-key="imBlobKey.sha(e.attachment.sha256)"
            :room-id="null"
            :fetch="fileOf(false)"
            :alt="t('im.preview.sticker')"
          />
          <button
            v-else-if="e.kind === 'image' && e.attachment"
            type="button"
            class="im-entry__image"
            :aria-label="t('im.message.preview')"
            @click="preview"
          >
            <AuthImage
              :blob-key="imBlobKey.object(e.attachment.thumbObjectId ?? e.attachment.objectId)"
              :room-id="room.roomId"
              :fetch="fileOf(e.attachment.thumbObjectId !== undefined)"
              :alt="e.attachment.name"
            />
          </button>
          <VoiceMessage
            v-else-if="e.kind === 'voice' && e.attachment"
            :entry="e"
            :room-id="room.roomId"
          />
          <div v-else-if="e.kind === 'file' && e.attachment" class="im-entry__file">
            <span class="im-entry__file-name">{{ e.attachment.name }}</span>
            <span class="im-entry__file-size">{{ fileSize(e.attachment.size) }}</span>
            <el-button link type="primary" :loading="busy" @click="download">{{
              t('im.message.download')
            }}</el-button>
          </div>
        </div>
        <el-dropdown v-if="hasActions" ref="menu" trigger="click" @command="onCommand">
          <IconButton
            class="im-entry__more"
            icon="lucide:ellipsis"
            :label="t('im.message.actions')"
          />
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item v-if="e.kind === 'text'" command="copy">{{
                t('im.message.copy')
              }}</el-dropdown-item>
              <el-dropdown-item v-if="canEdit" command="edit">{{
                t('im.message.edit')
              }}</el-dropdown-item>
              <el-dropdown-item v-if="canRecall" command="recall">{{
                t('im.message.recall')
              }}</el-dropdown-item>
              <el-dropdown-item v-if="canSticker" command="sticker">{{
                t('im.message.addSticker')
              }}</el-dropdown-item>
              <el-dropdown-item v-if="e.kind === 'file'" command="download">{{
                t('im.message.download')
              }}</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </div>
  </div>
</template>

<style scoped>
.im-entry {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 6px 0;
}
.im-entry--mine {
  flex-direction: row-reverse;
}
.im-entry--event {
  justify-content: center;
  font-size: 12px;
  color: var(--qw-text-3);
}
.im-entry__avatar {
  display: grid;
  flex: none;
  place-items: center;
  width: 32px;
  height: 32px;
  overflow: hidden;
  font-size: 12px;
  font-weight: 650;
  color: var(--qw-brand-text);
  background: var(--qw-brand-weak);
  border-radius: 50%;
}
.im-entry__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.im-entry__body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: 70%;
}
.im-entry--mine .im-entry__body {
  align-items: flex-end;
}
.im-entry__meta {
  display: flex;
  gap: 8px;
  font-size: 12px;
  color: var(--qw-text-3);
}
.im-entry__author {
  color: var(--qw-text-2);
}
.im-entry__bubble-row {
  display: flex;
  gap: 4px;
  align-items: center;
}
.im-entry--mine .im-entry__bubble-row {
  flex-direction: row-reverse;
}
.im-entry__bubble {
  padding: 8px 12px;
  color: var(--qw-text);
  background: var(--qw-surface-2);
  border-radius: var(--qw-radius);
}
.im-entry--mine .im-entry__bubble {
  background: var(--qw-brand-weak);
}
.im-entry__bubble--plain,
.im-entry--mine .im-entry__bubble--plain {
  padding: 0;
  background: transparent;
}
.im-entry__text {
  margin: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.im-entry__sticker {
  width: 96px;
  height: 96px;
  object-fit: contain;
}
.im-entry__image {
  display: block;
  max-width: 240px;
  max-height: 240px;
  padding: 0;
  cursor: zoom-in;
  background: transparent;
  border: 0;
}
.im-entry__file {
  display: flex;
  gap: 12px;
  align-items: center;
}
.im-entry__file-name {
  font-weight: 600;
  overflow-wrap: anywhere;
}
.im-entry__file-size {
  font-size: 12px;
  color: var(--qw-text-3);
}
.im-entry__edited {
  font-style: italic;
}
.im-entry__more {
  opacity: 0;
}
.im-entry__bubble-row:hover .im-entry__more,
.im-entry__more:focus-visible,
.im-entry__more[aria-expanded='true'] {
  opacity: 1;
}
</style>
