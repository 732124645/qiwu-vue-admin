<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FormInstance } from 'element-plus'
import {
  WXOA_QR_EXPIRE_SECONDS,
  WXOA_QR_KINDS,
  wxoaQrcodeCreate,
  wxoaQrcodeUpdate,
  type WxoaQrcodeCreate,
  type WxoaQrcodeUpdate,
  type WxoaQrcodeVo,
  type WxoaTagVo,
} from '@qiwu/shared'
import { wxoaQrcodeApi } from '@/api/platform/wxoa/qrcode'
import { toastRest } from '@/core/composables/use-crud'
import { useDict } from '@/core/composables/use-dict'
import { revalidateOnLocale, zodRules } from '@/core/form/zod-rules'

/**
 * Creates a channel QR code of account `accountId`, or with `row` changes its name and auto tag (all a
 * code may change), `openDialog(WxoaQrcodeForm, { accountId, row?, tags })`. `tags` are the account's
 * tags to offer as the auto tag; null when they cannot be listed here (the field is hidden, an edit keeps
 * the code's tag). `done(true)` once saved.
 */
defineOptions({ name: 'WxoaQrcodeForm' })
const {
  accountId,
  row = null,
  tags = null,
} = defineProps<{ accountId: number; row?: WxoaQrcodeVo | null; tags?: WxoaTagVo[] | null }>()
const emit = defineEmits<{ done: [saved: true]; cancel: [] }>()
const i18n = useI18n()
const { t } = i18n
const kinds = useDict('wxoa.qr_kind')

// a temporary code's validity: an amount of a unit, sent in seconds
const UNITS = { minute: 60, hour: 3600, day: 86_400 } as const
type Unit = keyof typeof UNITS
const expiry = reactive({ amount: 30 as number | undefined, unit: 'day' as Unit })

const model = reactive(
  row
    ? ({ label: row.label, tagId: row.tagId } satisfies WxoaQrcodeUpdate)
    : ({
        accountId,
        label: '',
        qrKind: 'temporary',
        scene: '',
        expireSeconds: null,
        tagId: null,
      } as WxoaQrcodeCreate),
) as Partial<WxoaQrcodeCreate> & WxoaQrcodeUpdate
const formRef = ref<FormInstance>()
const rules = zodRules(row ? wxoaQrcodeUpdate : wxoaQrcodeCreate, i18n, model)
revalidateOnLocale(formRef)
const expiryHint = () =>
  t('wxoa.qrcode.form.expiryHint', {
    min: WXOA_QR_EXPIRE_SECONDS.min,
    days: WXOA_QR_EXPIRE_SECONDS.max / UNITS.day,
  })
// the validity is entered in a unit of choice: out of range, name the range rather than seconds
const expiryRule = rules.expireSeconds?.[0]
if (expiryRule?.validator) {
  const check = expiryRule.validator
  rules.expireSeconds = [
    {
      ...expiryRule,
      validator: (rule, value, callback, ...rest) =>
        check(rule, value, (e) => callback(e ? new Error(expiryHint()) : undefined), ...rest),
    },
  ]
}

const temporary = computed(() => !row && model.qrKind === 'temporary')
watch(
  [temporary, () => expiry.amount, () => expiry.unit],
  ([on]) => {
    model.expireSeconds = on ? (expiry.amount ?? 0) * UNITS[expiry.unit] : null
    if (on) void formRef.value?.validateField('expireSeconds').catch(() => undefined)
  },
  { immediate: true },
)

const submitting = ref(false)
async function submit() {
  if (submitting.value) return
  if (!(await formRef.value?.validate().catch(() => false))) return
  submitting.value = true
  try {
    // a cleared tag select holds undefined: no tag
    const tagId = model.tagId ?? null
    if (row) await wxoaQrcodeApi.update(row.id, { label: model.label, tagId })
    else await wxoaQrcodeApi.create({ ...model, tagId } as WxoaQrcodeCreate)
    emit('done', true)
  } catch (e) {
    toastRest(e)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-form ref="formRef" :model="model" :rules="rules" label-position="left">
    <el-form-item :label="t('field.wxoa.qrcode.label')" prop="label">
      <el-input v-model="model.label" name="label" maxlength="64" />
    </el-form-item>
    <template v-if="!row">
      <el-form-item :label="t('field.wxoa.qrcode.qrKind')" prop="qrKind">
        <el-radio-group v-model="model.qrKind">
          <el-radio v-for="k in WXOA_QR_KINDS" :key="k" :value="k">{{ kinds.label(k) }}</el-radio>
        </el-radio-group>
        <div v-if="model.qrKind === 'permanent'" class="wxoa-qrcode-form__hint">
          {{ t('wxoa.qrcode.form.permanentHint') }}
        </div>
      </el-form-item>
      <el-form-item :label="t('field.wxoa.qrcode.scene')" prop="scene">
        <el-input v-model="model.scene" name="scene" maxlength="64" />
        <div class="wxoa-qrcode-form__hint">{{ t('wxoa.qrcode.form.sceneHint') }}</div>
      </el-form-item>
      <el-form-item v-if="temporary" :label="t('wxoa.qrcode.form.validity')" prop="expireSeconds">
        <div class="wxoa-qrcode-form__expiry">
          <el-input-number
            v-model="expiry.amount"
            :min="1"
            :step="1"
            step-strictly
            value-on-clear="min"
            :aria-label="t('wxoa.qrcode.form.validity')"
          />
          <el-select v-model="expiry.unit" class="wxoa-qrcode-form__unit">
            <el-option
              v-for="(_, u) in UNITS"
              :key="u"
              :value="u"
              :label="t(`wxoa.qrcode.unit.${u}`)"
            />
          </el-select>
        </div>
        <div class="wxoa-qrcode-form__hint">{{ expiryHint() }}</div>
      </el-form-item>
    </template>
    <el-form-item v-if="tags" :label="t('field.wxoa.qrcode.tagId')" prop="tagId">
      <el-select
        v-model="model.tagId"
        clearable
        filterable
        :placeholder="t('wxoa.qrcode.form.noTag')"
      >
        <el-option v-for="tag in tags" :key="tag.id" :value="tag.tagId" :label="tag.name" />
      </el-select>
      <div class="wxoa-qrcode-form__hint">{{ t('wxoa.qrcode.form.tagHint') }}</div>
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
.wxoa-qrcode-form__hint {
  width: 100%;
  font-size: 12px;
  line-height: 1.5;
  color: var(--qw-text-3);
}
.wxoa-qrcode-form__expiry {
  display: flex;
  gap: 8px;
}
.wxoa-qrcode-form__unit {
  width: 100px;
}
</style>
