<script setup lang="ts">
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, type FormItemRule } from 'element-plus'
import {
  WXOA_ACCOUNT_KINDS,
  WXOA_CRYPTO_MODES,
  wxoaAccountCreate,
  wxoaAccountUpdate,
  wxoaCryptoModeAllowed,
  type WxoaAccountKind,
  type WxoaCryptoMode,
} from '@qiwu/shared'
import { wxoaAccountApi } from '@/api/platform/wxoa/account'
import { useCrudForm } from '@/core/composables/use-crud'
import { useDict } from '@/core/composables/use-dict'
import { zodRules } from '@/core/form/zod-rules'

/**
 * Add / edit form of an official account, opened with `openDialog(WxoaAccountForm, { id })`. The three
 * secrets are write-only: editing shows them blank ("set, leave blank to keep") and a blank one is left
 * out of the save. The AppID is entered once: editing shows it read-only and never sends it.
 */
defineOptions({ name: 'WxoaAccountForm' })
const { id } = defineProps<{ id?: number }>()
const emit = defineEmits<{ done: [saved: { id: number }]; cancel: [] }>()
const i18n = useI18n()
const { t } = i18n
const editing = id != null

const emptyModel = () => ({
  label: '',
  ...(editing ? {} : { appId: '' }),
  accountKind: 'service' as WxoaAccountKind,
  verified: false,
  cryptoMode: 'plain' as WxoaCryptoMode,
  appSecret: '',
  token: '',
  aesKey: '',
  enabled: true,
  note: null as string | null,
})
type Model = ReturnType<typeof emptyModel>

/** blank secrets are left out (edit: the stored ones stay); the AES key only goes with an encrypted mode */
function bodyOf(m: Model) {
  const body: Record<string, unknown> = { ...m }
  for (const k of ['appSecret', 'token', 'aesKey'] as const) if (!m[k].trim()) delete body[k]
  if (m.cryptoMode === 'plain') delete body.aesKey
  return body as Model
}

const schema = editing ? wxoaAccountUpdate : wxoaAccountCreate
const { model, row, formRef, loading, submitting, submit } = useCrudForm({
  api: {
    get: (id: number) => wxoaAccountApi.get(id),
    create: (m: Model) => wxoaAccountApi.create(bodyOf(m)),
    update: (id: number, m: Model) => wxoaAccountApi.update(id, bodyOf(m)),
  },
  schema,
  emptyModel,
  id,
  emit,
})

// a sandbox account pushes in plain mode only
watch(
  () => model.accountKind,
  (kind) => {
    if (!wxoaCryptoModeAllowed(kind, model.cryptoMode)) model.cryptoMode = 'plain'
  },
)

/** compat and secure need an EncodingAESKey: a new one unless the account has one stored */
const aesKeyNeeded = computed(() => model.cryptoMode !== 'plain' && !row.value?.hasAesKey)
const baseRules = zodRules(schema, i18n, model)
const rules = computed(() => ({
  ...baseRules,
  aesKey: [
    ...(baseRules.aesKey ?? []),
    {
      required: aesKeyNeeded.value,
      trigger: 'blur',
      validator: (_rule, value: string | undefined, callback) =>
        aesKeyNeeded.value && !value?.trim()
          ? callback(new Error(t('wxoa.account.aesKeyRequired')))
          : callback(),
    } satisfies FormItemRule,
  ],
}))

const kindDict = useDict('wxoa.account_kind')
const modeDict = useDict('wxoa.crypto_mode')

/** "set, leave blank to keep" for a stored secret */
const keepHint = (has: boolean | undefined) => (has ? t('wxoa.account.secretSet') : '')

/** what the WeChat console's server URL takes: this page's origin + the account's callback path */
const callbackUrl = computed(() =>
  row.value ? `${location.origin}${row.value.callbackPath}` : null,
)
async function copyCallback() {
  if (!callbackUrl.value) return
  try {
    await navigator.clipboard.writeText(callbackUrl.value)
    ElMessage.success(t('wxoa.account.copied'))
  } catch {
    // no clipboard (an insecure context, a denied permission): the URL stays there to select
    ElMessage.error(t('wxoa.account.copyFailed'))
  }
}
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
    <el-form-item :label="t('field.wxoa.account.label')" prop="label">
      <el-input v-model="model.label" maxlength="64" />
    </el-form-item>
    <el-form-item v-if="!editing" :label="t('field.wxoa.account.appId')" prop="appId">
      <el-input v-model="model.appId" maxlength="32" />
      <div class="field-hint">{{ t('wxoa.account.appIdFixed') }}</div>
    </el-form-item>
    <el-form-item v-else :label="t('field.wxoa.account.appId')">
      <span class="app-id">{{ row?.appId }}</span>
      <div class="field-hint">{{ t('wxoa.account.appIdFixed') }}</div>
    </el-form-item>
    <el-form-item :label="t('field.wxoa.account.accountKind')" prop="accountKind">
      <el-radio-group v-model="model.accountKind">
        <el-radio v-for="k in WXOA_ACCOUNT_KINDS" :key="k" :value="k">
          {{ kindDict.label(k) }}
        </el-radio>
      </el-radio-group>
    </el-form-item>
    <el-form-item :label="t('field.wxoa.account.verified')" prop="verified">
      <el-switch v-model="model.verified" />
    </el-form-item>
    <el-form-item :label="t('field.wxoa.account.cryptoMode')" prop="cryptoMode">
      <el-radio-group v-model="model.cryptoMode">
        <el-radio
          v-for="m in WXOA_CRYPTO_MODES"
          :key="m"
          :value="m"
          :disabled="!wxoaCryptoModeAllowed(model.accountKind, m)"
        >
          {{ modeDict.label(m) }}
        </el-radio>
      </el-radio-group>
      <div v-if="model.accountKind === 'sandbox'" class="field-hint">
        {{ t('wxoa.account.sandboxPlain') }}
      </div>
      <div v-else-if="model.cryptoMode === 'plain'" class="field-hint">
        {{ t('wxoa.account.plainHint') }}
      </div>
    </el-form-item>
    <el-form-item :label="t('field.wxoa.account.appSecret')" prop="appSecret">
      <el-input
        v-model="model.appSecret"
        type="password"
        show-password
        autocomplete="new-password"
        maxlength="32"
        :placeholder="keepHint(row?.hasAppSecret)"
      />
    </el-form-item>
    <el-form-item :label="t('field.wxoa.account.token')" prop="token">
      <el-input
        v-model="model.token"
        type="password"
        show-password
        autocomplete="new-password"
        maxlength="32"
        :placeholder="keepHint(row?.hasToken)"
      />
    </el-form-item>
    <el-form-item
      v-if="model.cryptoMode !== 'plain'"
      :label="t('field.wxoa.account.aesKey')"
      prop="aesKey"
    >
      <el-input
        v-model="model.aesKey"
        type="password"
        show-password
        autocomplete="new-password"
        maxlength="43"
        :placeholder="keepHint(row?.hasAesKey)"
      />
    </el-form-item>
    <el-form-item :label="t('field.wxoa.account.enabled')" prop="enabled">
      <el-switch v-model="model.enabled" />
    </el-form-item>
    <el-form-item :label="t('field.wxoa.account.note')" prop="note">
      <el-input v-model="model.note" type="textarea" :rows="2" maxlength="500" />
    </el-form-item>
    <el-form-item :label="t('wxoa.account.callbackUrl')">
      <template v-if="callbackUrl">
        <div class="callback">
          <code class="callback__url">{{ callbackUrl }}</code>
          <el-button size="small" @click="copyCallback">{{ t('wxoa.account.copy') }}</el-button>
        </div>
        <div class="field-hint">{{ t('wxoa.account.callbackHint') }}</div>
      </template>
      <div v-else class="field-hint">{{ t('wxoa.account.callbackLater') }}</div>
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
.app-id,
.callback__url {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  word-break: break-all;
}
.callback {
  display: flex;
  gap: 8px;
  align-items: center;
  width: 100%;
}
</style>
