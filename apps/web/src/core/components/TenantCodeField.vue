<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useLocalStorage } from '@vueuse/core'
import type { FormInstance } from 'element-plus'
import { loginBody } from '@qiwu/shared'
import { readTenancy } from '@/api/auth-extra'
import { revalidateOnLocale, zodRules } from '@/core/form/zod-rules'
import { Icon } from '@/core/icons'

/**
 * The tenant code of the sign-in pages (see docs/design-notes.md#tenancy): shown only while multi-tenancy
 * is on and this host is bound to no tenant (`GET /auth/tenancy`); blank = the default tenant. Prefilled
 * from `?tenant=`, else the code of the last sign-in in this browser. The pages read `code` (undefined:
 * send none), call `validate()` before a request (it waits for `/auth/tenancy`, so a request sent before
 * that answer still carries the code) and `remember(keep)` once signed in. An unanswered `/auth/tenancy`
 * is not taken for "off": `validate()` asks again and, failing again, throws the request's error for the
 * page to show.
 */
defineOptions({ name: 'TenantCodeField' })
const i18n = useI18n()
const { t } = i18n
const route = useRoute()
const saved = useLocalStorage<string | null>('qw.login.tenant', null)
const shown = ref(false)
const text = ref('')
const code = computed(() => (shown.value && text.value.trim()) || undefined)
const rules = zodRules(loginBody, i18n)
const formRef = ref<FormInstance>()
revalidateOnLocale(formRef)

/** settles once the field shows or not (and is rendered when it does) */
const load = () =>
  readTenancy().then(async ({ enabled, tenant }) => {
    shown.value = enabled && !tenant
    const asked = route.query.tenant
    if (shown.value) text.value = (typeof asked === 'string' ? asked : saved.value) ?? ''
    await nextTick()
  })
let ready = load()
// validate() asks again
ready.catch(() => undefined)

defineExpose({
  code,
  /**
   * true while hidden, blank or well-formed (the message shows under the field otherwise); false when
   * the field has just appeared blank, so a code the user never saw a field for is not taken as blank
   */
  validate: async () => {
    const was = shown.value
    await ready.catch(() => (ready = load()))
    if (!was && shown.value && !code.value) return false
    return !shown.value || !!(await formRef.value?.validate().catch(() => false))
  },
  /** `keep`: offer this sign-in's code next time (blank forgets it); otherwise forget the kept one */
  remember: (keep: boolean) => {
    if (shown.value) saved.value = (keep && code.value) || null
  },
})
</script>

<template>
  <el-form
    v-if="shown"
    ref="formRef"
    :model="{ tenantCode: code }"
    :rules
    label-position="top"
    size="large"
    hide-required-asterisk
    @submit.prevent
  >
    <el-form-item :label="t('auth.tenant.code')" prop="tenantCode">
      <el-input
        v-model="text"
        name="tenantCode"
        :placeholder="t('auth.tenant.placeholder')"
        autocomplete="off"
      >
        <template #prefix><Icon icon="lucide:building-2" /></template>
      </el-input>
    </el-form-item>
  </el-form>
</template>
