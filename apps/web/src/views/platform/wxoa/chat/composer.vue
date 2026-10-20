<script setup lang="ts">
import { computed, reactive, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FormInstance, FormItemRule } from 'element-plus'
import {
  fieldLabelKeys,
  utf8Bytes,
  validationMessage,
  WXOA_REPLY_KINDS,
  WXOA_TEXT_MAX_BYTES,
  wxoaMessageSend,
  wxoaPerms,
  type WxoaMaterialVo,
  type WxoaMediaKind,
  type WxoaMessageSend,
  type WxoaReplyKind,
} from '@qiwu/shared'
import { wxoaMessageApi } from '@/api/platform/wxoa/message'
import { toastRest } from '@/core/composables/use-crud'
import { useDict } from '@/core/composables/use-dict'
import { openDialog } from '@/core/dialog'
import { usePerm } from '@/core/permission'
import WxoaMaterialPicker from '../components/MaterialPicker.vue'
import WxoaMediaImage from '../components/WxoaMediaImage.vue'

/**
 * Sends a customer-service message to fan `fanId` of account `accountId`, by type. Media is a
 * permanent material of the account (picked here) or an inbound media copy of the conversation
 * (`forward(objectId, kind)`); nothing is uploaded here (new media goes to the material page first).
 * Checks are the shared schema's; the button waits for the answer, so a message is sent once.
 */
defineOptions({ name: 'WxoaChatComposer' })
const { accountId, fanId } = defineProps<{ accountId: number; fanId: number }>()
const emit = defineEmits<{ sent: [] }>()
const { t, te } = useI18n()
const perm = usePerm()
const kindDict = useDict('wxoa.reply_kind')

type BodyField = 'content' | 'title' | 'description' | 'musicUrl' | 'hqMusicUrl' | 'url' | 'picUrl'
const BODY_FIELDS: Record<WxoaReplyKind, readonly BodyField[]> = {
  text: ['content'],
  image: [],
  voice: [],
  video: ['title', 'description'],
  music: ['title', 'description', 'musicUrl', 'hqMusicUrl'],
  news: ['title', 'description', 'url', 'picUrl'],
}
const OPTIONAL = new Set(['video.title', 'video.description', 'music.hqMusicUrl'])
const BODY_MAX: Record<Exclude<BodyField, 'content'>, number> = {
  title: 64,
  description: 256,
  musicUrl: 1024,
  hqMusicUrl: 1024,
  url: 1024,
  picUrl: 1024,
}
/** the media a kind sends (from a material or a conversation copy) */
const MEDIA_KIND: Partial<Record<WxoaReplyKind, WxoaMediaKind>> = {
  image: 'image',
  voice: 'voice',
  video: 'video',
}
const THUMB_KINDS: readonly WxoaReplyKind[] = ['video', 'music']

const model = reactive({
  kind: 'text' as WxoaReplyKind,
  body: {
    content: '',
    title: '',
    description: '',
    musicUrl: '',
    hqMusicUrl: '',
    url: '',
    picUrl: '',
  } as Record<BodyField, string>,
  materialId: null as number | null,
  thumbMaterialId: null as number | null,
})

/** the media chosen for `kind`: a material of the account or a media copy of the conversation */
interface Media {
  kind: WxoaReplyKind
  source: 'material' | 'object'
  id: number
  name: string
  objectId: number | null
  wxUrl: string | null
}
const media = shallowRef<Media | null>(null)
const thumb = shallowRef<WxoaMaterialVo | null>(null)
// media of another type does not fit the new one
watch(
  () => model.kind,
  (kind) => {
    if (media.value && media.value.kind !== kind) media.value = null
  },
)

const nameOf = (m: WxoaMaterialVo) => m.title || m.fileName || m.mediaId

function payload(): WxoaMessageSend {
  const kind = model.kind
  const m = MEDIA_KIND[kind] ? media.value : null
  return {
    accountId,
    fanId,
    kind,
    body: Object.fromEntries(
      BODY_FIELDS[kind].flatMap((f) => (model.body[f].trim() ? [[f, model.body[f]]] : [])),
    ),
    materialId: m?.source === 'material' ? m.id : null,
    objectId: m?.source === 'object' ? m.id : null,
    thumbMaterialId: THUMB_KINDS.includes(kind) ? (thumb.value?.id ?? null) : null,
  }
}

const formRef = ref<FormInstance>()
/** a schema issue's form item: media from either source shows at `materialId` */
const propOf = (path: readonly PropertyKey[]) =>
  path[0] === 'body'
    ? `body.${String(path[1] ?? '')}`
    : path[0] === 'objectId'
      ? 'materialId'
      : String(path[0] ?? '')
function message(issue: Parameters<typeof validationMessage>[0]) {
  const { key, params } = validationMessage(issue)
  const label = fieldLabelKeys('wxoa.message', issue.path).find((k) => te(k))
  return t(key, { ...params, field: label ? t(label) : '' })
}
const bodyFields = computed(() => BODY_FIELDS[model.kind])
const mediaKind = computed(() => MEDIA_KIND[model.kind])
const needsThumb = computed(() => THUMB_KINDS.includes(model.kind))
const PROPS = [
  'materialId',
  'thumbMaterialId',
  ...['content', ...Object.keys(BODY_MAX)].map((f) => `body.${f}`),
]
function required(prop: string) {
  if (prop === 'materialId') return mediaKind.value != null
  if (prop === 'thumbMaterialId') return needsThumb.value
  return bodyFields.value.some((f) => prop === `body.${f}` && !OPTIONAL.has(`${model.kind}.${f}`))
}
// each item shows the issue the whole message has at its path (a field's check depends on the type)
const rules = computed(() =>
  Object.fromEntries(
    PROPS.map((prop) => [
      prop,
      [
        {
          required: required(prop),
          trigger: 'blur',
          validator: (_rule, _value, callback) => {
            const issue = wxoaMessageSend
              .safeParse(payload())
              .error?.issues.find((i) => propOf(i.path) === prop)
            callback(issue ? new Error(message(issue)) : undefined)
          },
        } satisfies FormItemRule,
      ],
    ]),
  ),
)

const canPick = computed(() => perm.has(wxoaPerms.material.browse))
async function pickMaterial(kind: WxoaMediaKind) {
  return openDialog<WxoaMaterialVo>(
    WxoaMaterialPicker,
    { accountId, mediaKind: kind },
    { title: () => t('wxoa.material.picker.title'), width: 720 },
  )
}
async function pickMedia() {
  const kind = mediaKind.value
  if (!kind) return
  const m = await pickMaterial(kind)
  if (!m) return
  media.value = {
    kind: model.kind,
    source: 'material',
    id: m.id,
    name: nameOf(m),
    objectId: m.objectId,
    wxUrl: m.wxUrl,
  }
  void formRef.value?.validateField('materialId').catch(() => undefined)
}
async function pickThumb() {
  const m = await pickMaterial('thumb')
  if (!m) return
  thumb.value = m
  void formRef.value?.validateField('thumbMaterialId').catch(() => undefined)
}

/** sends a media copy of the conversation (an inbound image or voice) again */
function forward(objectId: number, kind: 'image' | 'voice') {
  model.kind = kind
  media.value = {
    kind,
    source: 'object',
    id: objectId,
    name: t('wxoa.chat.composer.copy', { id: objectId }),
    objectId,
    wxUrl: null,
  }
  formRef.value?.clearValidate()
}
defineExpose({ forward })

const sending = ref(false)
async function send() {
  if (sending.value) return
  sending.value = true
  try {
    if (!(await formRef.value?.validate().catch(() => false))) return
    await wxoaMessageApi.send(payload())
    for (const f of Object.keys(model.body) as BodyField[]) model.body[f] = ''
    media.value = null
    formRef.value?.clearValidate()
    emit('sent')
  } catch (e) {
    // the request layer toasted 403/422 (a closed send window)/429; the message stays for another try
    toastRest(e)
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <el-form
    ref="formRef"
    class="wxoa-composer"
    :model="model"
    :rules="rules"
    :validate-on-rule-change="false"
    label-position="top"
    @submit.prevent
  >
    <el-form-item :label="t('field.wxoa.message.kind')">
      <el-radio-group v-model="model.kind">
        <el-radio v-for="k in WXOA_REPLY_KINDS" :key="k" :value="k">
          {{ kindDict.label(k) }}
        </el-radio>
      </el-radio-group>
    </el-form-item>
    <el-form-item
      v-for="f in bodyFields"
      :key="`${model.kind}.${f}`"
      :label="t(`field.wxoa.message.${f}`)"
      :prop="`body.${f}`"
    >
      <el-input
        v-if="f === 'content'"
        v-model="model.body.content"
        type="textarea"
        :rows="3"
        :aria-label="t('field.wxoa.message.content')"
      />
      <el-input
        v-else
        v-model="model.body[f]"
        :type="f === 'description' ? 'textarea' : 'text'"
        :rows="2"
        :maxlength="BODY_MAX[f]"
        :aria-label="t(`field.wxoa.message.${f}`)"
      />
      <div v-if="f === 'content'" class="wxoa-composer__hint">
        {{
          t('wxoa.chat.composer.bytes', {
            used: utf8Bytes(model.body.content),
            max: WXOA_TEXT_MAX_BYTES,
          })
        }}
      </div>
    </el-form-item>
    <el-form-item
      v-if="mediaKind"
      :label="t(`wxoa.chat.composer.media.${mediaKind}`)"
      prop="materialId"
    >
      <div class="wxoa-composer__media">
        <WxoaMediaImage
          v-if="media && mediaKind === 'image'"
          :object-id="media.objectId"
          :url="media.wxUrl"
          :alt="media.name"
        />
        <span v-if="media">{{ media.name }}</span>
        <span v-else class="wxoa-composer__none">{{ t('wxoa.chat.composer.none') }}</span>
        <el-button v-if="canPick" size="small" @click="pickMedia">
          {{ t('wxoa.chat.composer.pick') }}
        </el-button>
      </div>
      <div class="wxoa-composer__hint">
        {{ t(canPick ? 'wxoa.chat.composer.mediaHint' : 'wxoa.chat.composer.needsMaterial') }}
      </div>
    </el-form-item>
    <el-form-item v-if="needsThumb" :label="t('wxoa.chat.composer.thumb')" prop="thumbMaterialId">
      <div class="wxoa-composer__media">
        <WxoaMediaImage
          v-if="thumb"
          :object-id="thumb.objectId"
          :url="thumb.wxUrl"
          :alt="nameOf(thumb)"
        />
        <span v-if="thumb">{{ nameOf(thumb) }}</span>
        <span v-else class="wxoa-composer__none">{{ t('wxoa.chat.composer.none') }}</span>
        <el-button v-if="canPick" size="small" @click="pickThumb">
          {{ t('wxoa.chat.composer.pick') }}
        </el-button>
      </div>
    </el-form-item>
    <div class="wxoa-composer__actions">
      <el-button type="primary" :loading="sending" @click="send">
        {{ t('wxoa.chat.composer.send') }}
      </el-button>
    </div>
  </el-form>
</template>

<style scoped>
.wxoa-composer {
  padding-top: 12px;
  border-top: 1px solid var(--qw-border);
}
.wxoa-composer__hint {
  width: 100%;
  font-size: 12px;
  line-height: 1.5;
  color: var(--qw-text-3);
}
.wxoa-composer__media {
  display: flex;
  gap: 8px;
  align-items: center;
}
.wxoa-composer__none {
  color: var(--qw-text-3);
}
.wxoa-composer__actions {
  display: flex;
  justify-content: flex-end;
}
</style>
