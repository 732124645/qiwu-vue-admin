<template>
  <view v-if="tenant.shown" :class="['qw-field qw-login__tenant', { 'is-focus': focus }]">
    <wd-input
      v-model="tenant.text"
      :placeholder="t('login.tenantCode')"
      :maxlength="32"
      clearable
      clear-trigger="focus"
      :adjust-position="false"
      :error="!!tenant.error"
      @focus="focus = true"
      @blur="focus = false"
    >
      <template #prefix>
        <QwIcon class="qw-login__icon" name="briefcase" size="37rpx" />
      </template>
    </wd-input>
    <text v-if="tenant.error" class="qw-field__error">{{ tenant.error }}</text>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import QwIcon from '@/core/components/QwIcon.vue'
import { t } from '@/core/i18n'
import type { TenantCode } from '@/core/tenancy'

/**
 * The tenant code (the sign-in page, both tabs, and the WeChat bind page): the caller's `useTenantCode()`,
 * which decides whether it shows; nothing renders while multi-tenancy is off.
 */
defineProps<{ tenant: TenantCode }>()

const focus = ref(false)
</script>

<style>
.qw-login__tenant {
  margin-bottom: 26rpx;
}
</style>
