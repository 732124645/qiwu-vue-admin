<script setup lang="ts">
import { computed, reactive, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, type FormInstance, type FormItemRule, type UploadFile } from 'element-plus'
import {
  STORAGE_MAX_SIZE_DEFAULT,
  WXOA_MEDIA_KINDS,
  WXOA_MEDIA_LIMITS,
  wxoaMaterialCreate,
  type WxoaMaterialVo,
  type WxoaMediaKind,
} from '@qiwu/shared'
import { wxoaMaterialApi } from '@/api/platform/wxoa/material'
import { useDict } from '@/core/composables/use-dict'
import { formatSize, toastUploadError, uploadMaxSize } from '@/core/composables/use-upload'
import { revalidateOnLocale, zodRules } from '@/core/form/zod-rules'

/**
 * Uploads one permanent material of account `accountId`:
 * `openDialog(WxoaMaterialUpload, { accountId, mediaKind })`, `done` with the stored material. The file
 * is checked here first (WeChat's types and sizes for the kind, within the server's upload limit); the
 * server checks the bytes again.
 */
defineOptions({ name: 'WxoaMaterialUpload' })
const { accountId, mediaKind } = defineProps<{ accountId: number; mediaKind: WxoaMediaKind }>()
const emit = defineEmits<{ done: [material: WxoaMaterialVo]; cancel: [] }>()
const i18n = useI18n()
const { t } = i18n
const kindDict = useDict('wxoa.media_kind')

const model = reactive({ accountId, mediaKind, title: '', intro: '' })
const file = shallowRef<File | null>(null)
const formRef = ref<FormInstance>()
revalidateOnLocale(formRef)
const rules = {
  ...zodRules(wxoaMaterialCreate, i18n, model),
  file: [
    {
      required: true,
      trigger: 'change',
      validator: (_rule, _value, callback) =>
        callback(file.value ? undefined : new Error(t('wxoa.material.upload.noFile'))),
    } satisfies FormItemRule,
  ],
}

const serverMax = ref(STORAGE_MAX_SIZE_DEFAULT)
void uploadMaxSize().then((v) => (serverMax.value = v))
const limit = computed(() => WXOA_MEDIA_LIMITS[model.mediaKind])
const maxBytes = computed(() => Math.min(limit.value.maxBytes, serverMax.value))
const exts = computed(() => limit.value.exts.join(', '))
const accept = computed(() => limit.value.exts.map((e) => `.${e}`).join(','))
const video = computed(() => model.mediaKind === 'video')

const extOf = (name: string) => /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? ''
/** why WeChat would not take `f` as the chosen kind, or null */
function problem(f: File): string | null {
  if (!(limit.value.exts as readonly string[]).includes(extOf(f.name)))
    return t('wxoa.material.upload.badType', {
      name: f.name,
      kind: kindDict.label(model.mediaKind),
      exts: exts.value,
    })
  if (f.size > maxBytes.value)
    return t('upload.error.tooLarge', { name: f.name, size: formatSize(maxBytes.value) })
  return null
}
function choose(picked: UploadFile) {
  const raw = picked.raw
  if (!raw) return
  const why = problem(raw)
  if (why) {
    ElMessage.error(why)
    return
  }
  file.value = raw
  void formRef.value?.validateField('file').catch(() => undefined)
}
// another kind: a chosen file it does not take is dropped
watch(
  () => model.mediaKind,
  () => {
    if (file.value && problem(file.value)) file.value = null
  },
)

const submitting = ref(false)
const percent = ref(0)
async function submit() {
  if (submitting.value) return
  if (!(await formRef.value?.validate().catch(() => false)) || !file.value) return
  submitting.value = true
  percent.value = 0
  try {
    const saved = await wxoaMaterialApi.upload(
      {
        accountId,
        mediaKind: model.mediaKind,
        ...(video.value ? { title: model.title, intro: model.intro } : {}),
      },
      file.value,
      (p) => (percent.value = p),
    )
    emit('done', saved)
  } catch (e) {
    toastUploadError(e)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-form
    ref="formRef"
    :model="model"
    :rules="rules"
    :validate-on-rule-change="false"
    label-position="left"
    @submit.prevent="submit"
  >
    <el-form-item :label="t('field.wxoa.material.mediaKind')" prop="mediaKind">
      <el-radio-group v-model="model.mediaKind">
        <el-radio v-for="k in WXOA_MEDIA_KINDS" :key="k" :value="k">
          {{ kindDict.label(k) }}
        </el-radio>
      </el-radio-group>
    </el-form-item>
    <el-form-item :label="t('field.wxoa.material.file')" prop="file">
      <div class="file">
        <el-upload
          :auto-upload="false"
          :show-file-list="false"
          :accept="accept"
          :on-change="choose"
        >
          <el-button>{{ t('wxoa.material.upload.choose') }}</el-button>
        </el-upload>
        <span v-if="file" class="file__name">{{ file.name }} · {{ formatSize(file.size) }}</span>
      </div>
      <div class="field-hint">
        {{ t('wxoa.material.upload.hint', { exts, size: formatSize(maxBytes) }) }}
      </div>
    </el-form-item>
    <template v-if="video">
      <el-form-item :label="t('field.wxoa.material.title')" prop="title" required>
        <el-input v-model="model.title" maxlength="64" />
      </el-form-item>
      <el-form-item :label="t('field.wxoa.material.intro')" prop="intro" required>
        <el-input v-model="model.intro" type="textarea" :rows="3" maxlength="255" />
      </el-form-item>
    </template>
    <el-progress
      v-if="submitting"
      :percentage="percent"
      :aria-label="t('upload.uploading', { name: file?.name ?? '', percent })"
    />
  </el-form>
  <div class="qw-dialog-footer">
    <el-button @click="emit('cancel')">{{ t('common.action.cancel') }}</el-button>
    <el-button type="primary" :loading="submitting" @click="submit">
      {{ t('wxoa.material.upload.submit') }}
    </el-button>
  </div>
</template>

<style scoped>
.file {
  display: flex;
  gap: 8px;
  align-items: center;
}
.file__name {
  overflow-wrap: anywhere;
}
.field-hint {
  width: 100%;
  font-size: 12px;
  line-height: 1.5;
  color: var(--qw-text-3);
}
</style>
