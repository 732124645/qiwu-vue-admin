<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import type { WxoaAccountTestVo } from '@qiwu/shared'
import { wxoaAccountApi } from '@/api/platform/wxoa/account'
import { toastRest } from '@/core/composables/use-crud'

/**
 * Connection test of an account, `openDialog(WxoaAccountTest, { id })`: runs at once (a fresh token,
 * then an API call needing it) and shows each step, the refused IP and the last push received.
 */
defineOptions({ name: 'WxoaAccountTest' })
const { id } = defineProps<{ id: number }>()
const emit = defineEmits<{ cancel: [] }>()
const { t, te } = useI18n()

const testing = ref(false)
/** null: not tested yet, or the request itself failed (the request layer said why) */
const result = ref<WxoaAccountTestVo | null>(null)
async function run() {
  if (testing.value) return
  testing.value = true
  result.value = null
  try {
    result.value = await wxoaAccountApi.test(id)
  } catch (e) {
    toastRest(e)
  } finally {
    testing.value = false
  }
}
onMounted(run)

const state = (ok: boolean) => (ok ? 'ok' : 'failed')
/** what the code means and what to fix; an unknown code shows alone */
const codeHint = (code: string) => {
  const key = `wxoa.account.test.codes.${code}`
  return te(key) ? t(key) : ''
}
</script>

<template>
  <div v-loading="testing" class="account-test">
    <dl v-if="result">
      <div class="account-test__row">
        <dt>{{ t('wxoa.account.test.token') }}</dt>
        <dd :class="`is-${state(result.tokenOk)}`">
          {{ t(`wxoa.account.test.${state(result.tokenOk)}`) }}
        </dd>
      </div>
      <div class="account-test__row">
        <dt>{{ t('wxoa.account.test.api') }}</dt>
        <dd v-if="result.tokenOk" :class="`is-${state(result.apiOk)}`">
          {{ t(`wxoa.account.test.${state(result.apiOk)}`) }}
        </dd>
        <dd v-else>{{ t('wxoa.account.test.skipped') }}</dd>
      </div>
      <div v-if="result.code" class="account-test__row">
        <dt>{{ t('wxoa.account.test.code') }}</dt>
        <dd>
          {{ result.code }}
          <div v-if="codeHint(result.code)" class="field-hint">{{ codeHint(result.code) }}</div>
        </dd>
      </div>
      <div v-if="result.ip" class="account-test__row">
        <dt>{{ t('wxoa.account.test.ip') }}</dt>
        <dd>
          {{ result.ip }}
          <div class="field-hint">{{ t('wxoa.account.test.ipHint') }}</div>
        </dd>
      </div>
      <div class="account-test__row">
        <dt>{{ t('wxoa.account.test.lastPush') }}</dt>
        <dd>
          {{
            result.lastPushAt
              ? dayjs(result.lastPushAt).format('YYYY-MM-DD HH:mm:ss')
              : t('wxoa.account.test.noPush')
          }}
        </dd>
      </div>
    </dl>
  </div>
  <div class="qw-dialog-footer">
    <el-button @click="emit('cancel')">{{ t('wxoa.account.close') }}</el-button>
    <el-button type="primary" :loading="testing" :disabled="testing" @click="run">
      {{ t('wxoa.account.test.again') }}
    </el-button>
  </div>
</template>

<style scoped>
.account-test {
  min-height: 120px;
}
.account-test__row {
  display: grid;
  grid-template-columns: 10em 1fr;
  gap: 12px;
  padding: 6px 0;
}
.account-test__row dt {
  color: var(--qw-text-2);
}
.account-test__row dd {
  margin: 0;
  word-break: break-all;
}
.is-ok {
  color: var(--qw-success);
}
.is-failed {
  color: var(--qw-danger);
}
.field-hint {
  font-size: 12px;
  line-height: 1.5;
  color: var(--qw-text-3);
}
</style>
