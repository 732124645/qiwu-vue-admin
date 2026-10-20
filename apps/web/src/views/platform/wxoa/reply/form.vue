<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FormItemRule } from 'element-plus'
import {
  fieldLabelKeys,
  utf8Bytes,
  validationMessage,
  WXOA_KEYWORDS_MAX,
  WXOA_MATCH_MODES,
  WXOA_REPLY_KINDS,
  WXOA_REPLY_TRIGGERS,
  WXOA_TEXT_MAX_BYTES,
  wxoaPerms,
  wxoaReplyRuleCreate,
  wxoaReplyRuleUpdate,
  type WxoaMaterialVo,
  type WxoaMediaKind,
  type WxoaQrcodeVo,
  type WxoaReplyKind,
  type WxoaReplyRuleCreate,
  type WxoaReplyTrigger,
} from '@qiwu/shared'
import { wxoaReplyRuleApi } from '@/api/platform/wxoa/reply-rule'
import { useCrudForm } from '@/core/composables/use-crud'
import { useDict } from '@/core/composables/use-dict'
import { openDialog } from '@/core/dialog'
import { usePerm } from '@/core/permission'
import WxoaMaterialPicker from '../components/MaterialPicker.vue'
import WxoaMediaImage from '../components/WxoaMediaImage.vue'

/**
 * Add / edit form of an auto-reply rule of account `accountId`, opened with
 * `openDialog(WxoaReplyForm, { id, accountId })`. The trigger decides the match fields (keywords, a menu
 * key, a QR scene: picked from the account's QR codes or typed), the reply type its content and media
 * (a permanent material of the account). Only the fields of the chosen trigger and type are sent; checks
 * are the shared schema's, byte counts included. An edit never sends `accountId`.
 */
defineOptions({ name: 'WxoaReplyForm' })
const { id, accountId } = defineProps<{ id?: number; accountId: number }>()
const emit = defineEmits<{ done: [saved: { id: number }]; cancel: [] }>()
const { t, te } = useI18n()
const perm = usePerm()
const editing = id != null

type BodyField = 'content' | 'title' | 'description' | 'musicUrl' | 'hqMusicUrl' | 'url' | 'picUrl'
/** the content fields of each reply type; a blank one is left out (an optional one stays unset) */
const BODY_FIELDS: Record<WxoaReplyKind, readonly BodyField[]> = {
  text: ['content'],
  image: [],
  voice: [],
  video: ['title', 'description'],
  music: ['title', 'description', 'musicUrl', 'hqMusicUrl'],
  news: ['title', 'description', 'url', 'picUrl'],
}
const OPTIONAL = new Set(['video.title', 'video.description', 'music.hqMusicUrl'])
const BODY_MAX: Record<BodyField, number> = {
  content: WXOA_TEXT_MAX_BYTES,
  title: 64,
  description: 256,
  musicUrl: 1024,
  hqMusicUrl: 1024,
  url: 1024,
  picUrl: 1024,
}
/** the material each reply type needs (music: its thumbnail) */
const MATERIAL_KIND: Partial<Record<WxoaReplyKind, WxoaMediaKind>> = {
  image: 'image',
  voice: 'voice',
  video: 'video',
  music: 'thumb',
}
const CLICK_KEY_MAX_BYTES = 128

const emptyModel = () => ({
  name: '',
  triggerKind: 'keyword' as WxoaReplyTrigger,
  matchMode: 'exact' as string | null,
  keywords: [] as string[] | null,
  eventKey: '' as string | null,
  priority: 0 as number | null,
  replyKind: 'text' as WxoaReplyKind,
  materialId: null as number | null,
  enabled: true,
  body: {
    content: '',
    title: '',
    description: '',
    musicUrl: '',
    hqMusicUrl: '',
    url: '',
    picUrl: '',
  } as Record<BodyField, string>,
})
type Model = ReturnType<typeof emptyModel>

/** the rule as sent: the fields of the chosen trigger and reply type only */
function payload(m: Model) {
  const keyword = m.triggerKind === 'keyword'
  const keyed = m.triggerKind === 'click' || m.triggerKind === 'scan'
  const kind = m.replyKind
  return {
    name: m.name,
    triggerKind: m.triggerKind,
    matchMode: keyword ? m.matchMode : null,
    keywords: keyword ? (m.keywords ?? []) : null,
    eventKey: keyed && m.eventKey ? m.eventKey : null,
    priority: keyword ? (m.priority ?? 0) : 0,
    replyKind: kind,
    replyBody: Object.fromEntries(
      BODY_FIELDS[kind].flatMap((f) => (m.body[f].trim() ? [[f, m.body[f]]] : [])),
    ),
    materialId: MATERIAL_KIND[kind] ? m.materialId : null,
    enabled: m.enabled,
  } as Omit<WxoaReplyRuleCreate, 'accountId'>
}

const schema = editing ? wxoaReplyRuleUpdate : wxoaReplyRuleCreate
const { model, row, formRef, loading, submitting, submit } = useCrudForm({
  api: {
    get: (id: number) => wxoaReplyRuleApi.get(id),
    create: (m: Model) => wxoaReplyRuleApi.create({ accountId, ...payload(m) }),
    update: (id: number, m: Model) => wxoaReplyRuleApi.update(id, payload(m)),
  },
  schema,
  emptyModel,
  id,
  emit,
})

const picked = shallowRef<WxoaMaterialVo | null>(null)
// a loaded rule: its content into the per-field model (the fields it lacks stay blank)
watch(row, (r) => {
  if (!r) return
  model.keywords = r.keywords ?? []
  model.matchMode ??= 'exact'
  model.eventKey ??= ''
  for (const [k, v] of Object.entries(r.replyBody))
    if (k in model.body && typeof v === 'string') model.body[k as BodyField] = v
})
// another kind of media: the material picked for the previous one does not fit
watch(
  () => model.replyKind,
  (kind, old) => {
    const before = MATERIAL_KIND[old]
    if (before && before !== MATERIAL_KIND[kind]) {
      model.materialId = null
      picked.value = null
    }
  },
)

const parsed = () =>
  schema.safeParse(editing ? payload(model) : { accountId, ...payload(model) }).error?.issues ?? []
/** a schema issue's form item: `replyBody.<field>` is shown at `body.<field>` */
const propOf = (path: readonly PropertyKey[]) =>
  path[0] === 'replyBody' ? `body.${String(path[1] ?? '')}` : String(path[0] ?? '')
function message(issue: Parameters<typeof validationMessage>[0]) {
  const { key, params } = validationMessage(issue)
  const label = fieldLabelKeys('wxoa.replyRule', issue.path).find((k) => te(k))
  return t(key, { ...params, field: label ? t(label) : '' })
}
const materialKind = computed(() => MATERIAL_KIND[model.replyKind])
const bodyFields = computed(() => BODY_FIELDS[model.replyKind])
const required = computed<Record<string, boolean>>(() => {
  const keyword = model.triggerKind === 'keyword'
  return {
    name: true,
    triggerKind: true,
    replyKind: true,
    matchMode: keyword,
    keywords: keyword,
    eventKey: model.triggerKind === 'click' || model.triggerKind === 'scan',
    materialId: materialKind.value != null,
    ...Object.fromEntries(
      bodyFields.value.map((f) => [`body.${f}`, !OPTIONAL.has(`${model.replyKind}.${f}`)]),
    ),
  }
})
const PROPS = [
  'name',
  'triggerKind',
  'matchMode',
  'keywords',
  'eventKey',
  'priority',
  'replyKind',
  'materialId',
  ...Object.keys(BODY_MAX).map((f) => `body.${f}`),
]
// each item shows the issue the whole rule has at its path (the checks of one field depend on others)
const rules = computed(() =>
  Object.fromEntries(
    PROPS.map((prop) => [
      prop,
      [
        {
          required: required.value[prop] ?? false,
          trigger: 'blur',
          validator: (_rule, _value, callback) => {
            const issue = parsed().find((i) => propOf(i.path) === prop)
            callback(issue ? new Error(message(issue)) : undefined)
          },
        } satisfies FormItemRule,
      ],
    ]),
  ),
)

const triggerDict = useDict('wxoa.reply_trigger')
const modeDict = useDict('wxoa.match_mode')
const kindDict = useDict('wxoa.reply_kind')

const bytes = (s: string | null | undefined) => utf8Bytes(s ?? '')

// the scenes of the account's QR codes, for a scan rule (typing another one stays possible)
const qrcodes = shallowRef<WxoaQrcodeVo[]>([])
let qrLoaded = false
watch(
  () => model.triggerKind === 'scan',
  async (scan) => {
    if (!scan || qrLoaded || !perm.has(wxoaPerms.qrcode.browse)) return
    qrLoaded = true
    qrcodes.value = (await wxoaReplyRuleApi.qrcodes(accountId).catch(() => null))?.items ?? []
  },
  { immediate: true },
)

const canPick = computed(() => perm.has(wxoaPerms.material.browse))
async function pickMaterial() {
  const kind = materialKind.value
  if (!kind) return
  const m = await openDialog<WxoaMaterialVo>(
    WxoaMaterialPicker,
    { accountId, mediaKind: kind },
    { title: () => t('wxoa.material.picker.title'), width: 720 },
  )
  if (!m) return
  picked.value = m
  model.materialId = m.id
  void formRef.value?.validateField('materialId').catch(() => undefined)
}
/** the material picked here (a loaded rule knows its material by id only) */
const current = computed(() =>
  model.materialId != null && picked.value?.id === model.materialId ? picked.value : null,
)
const pickedName = computed(() => {
  if (model.materialId == null) return ''
  const m = current.value
  return m
    ? m.title || m.fileName || m.mediaId
    : t('wxoa.reply.materialNo', { id: model.materialId })
})
const pickedImage = computed(() =>
  materialKind.value === 'image' || materialKind.value === 'thumb' ? current.value : null,
)
</script>

<template>
  <el-form
    ref="formRef"
    v-loading="loading"
    :model="model"
    :rules="rules"
    :validate-on-rule-change="false"
    label-position="left"
  >
    <el-form-item :label="t('field.wxoa.replyRule.name')" prop="name">
      <el-input v-model="model.name" maxlength="64" />
    </el-form-item>
    <el-form-item :label="t('field.wxoa.replyRule.triggerKind')" prop="triggerKind">
      <el-radio-group v-model="model.triggerKind">
        <el-radio v-for="k in WXOA_REPLY_TRIGGERS" :key="k" :value="k">
          {{ triggerDict.label(k) }}
        </el-radio>
      </el-radio-group>
      <div class="field-hint">{{ t(`wxoa.reply.triggerHint.${model.triggerKind}`) }}</div>
    </el-form-item>

    <template v-if="model.triggerKind === 'keyword'">
      <el-form-item :label="t('field.wxoa.replyRule.matchMode')" prop="matchMode">
        <el-radio-group v-model="model.matchMode">
          <el-radio v-for="m in WXOA_MATCH_MODES" :key="m" :value="m">
            {{ modeDict.label(m) }}
          </el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item :label="t('field.wxoa.replyRule.keywords')" prop="keywords">
        <el-input-tag
          v-model="model.keywords"
          :max="WXOA_KEYWORDS_MAX"
          :aria-label="t('field.wxoa.replyRule.keywords')"
          :placeholder="t('wxoa.reply.keywordPlaceholder')"
        />
        <div class="field-hint">
          {{ t('wxoa.reply.keywordHint', { max: WXOA_KEYWORDS_MAX }) }}
        </div>
      </el-form-item>
      <el-form-item :label="t('field.wxoa.replyRule.priority')" prop="priority">
        <el-input-number v-model="model.priority" :min="0" :max="9999" :step="1" step-strictly />
        <div class="field-hint">{{ t('wxoa.reply.priorityHint') }}</div>
      </el-form-item>
    </template>
    <el-form-item
      v-else-if="model.triggerKind === 'click'"
      :label="t('wxoa.reply.clickKey')"
      prop="eventKey"
    >
      <el-input v-model="model.eventKey" :aria-label="t('wxoa.reply.clickKey')" />
      <div class="field-hint">
        {{ t('wxoa.reply.bytes', { used: bytes(model.eventKey), max: CLICK_KEY_MAX_BYTES }) }}
        · {{ t('wxoa.reply.clickHint') }}
      </div>
    </el-form-item>
    <el-form-item
      v-else-if="model.triggerKind === 'scan'"
      :label="t('wxoa.reply.scanScene')"
      prop="eventKey"
    >
      <el-select
        v-model="model.eventKey"
        filterable
        allow-create
        default-first-option
        clearable
        :aria-label="t('wxoa.reply.scanScene')"
        :placeholder="t('wxoa.reply.scanPlaceholder')"
      >
        <el-option
          v-for="q in qrcodes"
          :key="q.id"
          :value="q.scene"
          :label="`${q.label} (${q.scene})`"
        />
      </el-select>
      <div class="field-hint">{{ t('wxoa.reply.scanHint') }}</div>
    </el-form-item>

    <el-form-item :label="t('field.wxoa.replyRule.replyKind')" prop="replyKind">
      <el-radio-group v-model="model.replyKind">
        <el-radio v-for="k in WXOA_REPLY_KINDS" :key="k" :value="k">
          {{ kindDict.label(k) }}
        </el-radio>
      </el-radio-group>
    </el-form-item>
    <el-form-item
      v-for="f in bodyFields"
      :key="`${model.replyKind}.${f}`"
      :label="t(`field.wxoa.replyRule.${f}`)"
      :prop="`body.${f}`"
    >
      <el-input
        v-if="f === 'content'"
        v-model="model.body.content"
        type="textarea"
        :rows="4"
        :aria-label="t('field.wxoa.replyRule.content')"
      />
      <el-input
        v-else
        v-model="model.body[f]"
        :type="f === 'description' ? 'textarea' : 'text'"
        :rows="2"
        :maxlength="BODY_MAX[f]"
        :aria-label="t(`field.wxoa.replyRule.${f}`)"
      />
      <div v-if="f === 'content'" class="field-hint">
        {{ t('wxoa.reply.bytes', { used: bytes(model.body.content), max: WXOA_TEXT_MAX_BYTES }) }}
      </div>
    </el-form-item>
    <el-form-item
      v-if="materialKind"
      :label="t(`wxoa.reply.material.${materialKind}`)"
      prop="materialId"
    >
      <div class="material">
        <WxoaMediaImage
          v-if="pickedImage"
          :object-id="pickedImage.objectId"
          :url="pickedImage.wxUrl"
          :alt="pickedName"
        />
        <span v-if="pickedName" class="material__name">{{ pickedName }}</span>
        <span v-else class="material__none">{{ t('wxoa.reply.materialNone') }}</span>
        <el-button v-if="canPick" size="small" @click="pickMaterial">
          {{
            t(model.materialId == null ? 'wxoa.reply.materialPick' : 'wxoa.reply.materialChange')
          }}
        </el-button>
      </div>
      <div v-if="!canPick" class="field-hint">{{ t('wxoa.reply.materialNeedsBrowse') }}</div>
    </el-form-item>

    <el-form-item :label="t('field.wxoa.replyRule.enabled')" prop="enabled">
      <el-switch v-model="model.enabled" />
      <div
        v-if="model.triggerKind === 'subscribe' || model.triggerKind === 'default'"
        class="field-hint"
      >
        {{ t('wxoa.reply.soleHint') }}
      </div>
    </el-form-item>
  </el-form>
  <div class="qw-dialog-footer">
    <el-button @click="emit('cancel')">{{ t('common.action.cancel') }}</el-button>
    <el-button type="primary" :loading="submitting" @click="submit">
      {{ t('crud.action.save') }}
    </el-button>
  </div>
</template>

<style scoped>
.field-hint {
  width: 100%;
  font-size: 12px;
  line-height: 1.5;
  color: var(--qw-text-3);
}
.material {
  display: flex;
  gap: 8px;
  align-items: center;
}
.material__none {
  color: var(--qw-text-3);
}
</style>
