<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { WxoaMessageVo } from '@qiwu/shared'
import { storageApi } from '@/api/platform/storage/object'
import { useDict } from '@/core/composables/use-dict'
import { toastRest } from '@/core/composables/use-crud'
import WxoaMediaImage from './WxoaMediaImage.vue'

/**
 * The content of one message as plain text (see docs/design-notes.md#wxoa): the payload is whatever the
 * fan or WeChat sent, so it is never rendered as HTML and links stay text. Inbound rows carry WeChat's
 * field names (`Content`, `PicUrl`, `Recognition`…), outbound ones the sent body's (`content`, `title`…).
 * Images show the local copy or an mmbiz link (`WxoaMediaImage`); voice (amr, which browsers cannot
 * play) is downloaded and shows WeChat's recognized text; a video shows its thumbnail copy.
 */
defineOptions({ name: 'WxoaMessageBody' })
const { message } = defineProps<{ message: WxoaMessageVo }>()
const { t, te } = useI18n()
const kinds = useDict('wxoa.msg_kind')

/** the first non-empty text among `keys` of the payload */
function field(...keys: string[]): string {
  for (const k of keys) {
    const v = message.payload[k]
    if (typeof v === 'string' && v.trim() !== '') return v
    if (typeof v === 'number') return String(v)
  }
  return ''
}

const inbound = computed(() => message.direction === 'in')
const kind = computed(() => message.msgKind)
const image = computed(() => inbound.value && kind.value === 'image')
// a video's local copy is its thumbnail
const thumbnail = computed(
  () => inbound.value && (kind.value === 'video' || kind.value === 'shortvideo'),
)
const voice = computed(() => kind.value === 'voice')

/** the kind before the content, for everything that is not a plain text */
const kindLabel = computed(() =>
  kind.value === 'text' || kind.value === 'event' ? '' : kinds.label(kind.value),
)
function eventLabel(event: string | null) {
  if (!event) return kinds.label('event')
  const key = `wxoa.message.event.${event}`
  return te(key) ? t(key) : event
}

const lines = computed<string[]>(() => {
  switch (kind.value) {
    case 'text':
      return [field('Content', 'content')]
    case 'event':
      return [eventLabel(message.eventKind), message.eventKey ?? '']
    case 'voice': {
      const recognized = field('Recognition')
      return [recognized && t('wxoa.message.body.recognition', { text: recognized })]
    }
    case 'location': {
      const at = [field('Location_X'), field('Location_Y')].filter(Boolean).join(', ')
      return [field('Label'), at]
    }
    case 'template': {
      const data = message.payload.data
      const values =
        data && typeof data === 'object'
          ? Object.entries(data as Record<string, unknown>).map(([k, v]) => `${k}: ${String(v)}`)
          : []
      return [field('title'), ...values]
    }
    default:
      // link, video, music, news, and kinds added later
      return [
        field('Title', 'title'),
        field('Description', 'description'),
        field('Url', 'url', 'MusicUrl', 'musicUrl'),
      ]
  }
})
const shown = computed(() => lines.value.filter((l) => l !== ''))

const downloading = ref(false)
async function downloadVoice() {
  const id = message.objectId
  if (id == null || downloading.value) return
  const format = field('Format').toLowerCase()
  const ext = /^[a-z0-9]{1,8}$/.test(format) ? format : 'amr'
  downloading.value = true
  try {
    await storageApi.download({ id, originalName: `voice-${message.id}.${ext}` })
  } catch (e) {
    toastRest(e)
  } finally {
    downloading.value = false
  }
}
</script>

<template>
  <div class="wxoa-msg">
    <span v-if="kindLabel" class="wxoa-msg__kind">{{ kindLabel }}</span>
    <WxoaMediaImage
      v-if="image"
      :object-id="message.objectId"
      :url="field('PicUrl')"
      :alt="kindLabel"
      preview
    />
    <WxoaMediaImage
      v-else-if="thumbnail && message.objectId != null"
      :object-id="message.objectId"
      :alt="kindLabel"
      preview
    />
    <el-button
      v-if="voice && message.objectId != null"
      link
      type="primary"
      :loading="downloading"
      @click="downloadVoice"
    >
      {{ t('wxoa.message.body.download') }}
    </el-button>
    <p v-for="(line, i) in shown" :key="i" class="wxoa-msg__line">{{ line }}</p>
    <p v-if="message.payload.truncated === true" class="wxoa-msg__note">
      {{ t('wxoa.message.body.truncated') }}
    </p>
  </div>
</template>

<style scoped>
.wxoa-msg {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: flex-start;
  min-width: 0;
}
.wxoa-msg__kind {
  font-size: 12px;
  color: var(--qw-text-3);
}
.wxoa-msg__line {
  margin: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.wxoa-msg__note {
  margin: 0;
  font-size: 12px;
  color: var(--qw-text-3);
}
</style>
