<script setup lang="ts">
import { onActivated, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useDict } from '@/core/composables/use-dict'
import { useWxoaAccount } from './use-wxoa-account'

/**
 * The account switch at the top of every wxoa page (the choice is shared by all of them and kept per
 * user). The list reloads each time the page shows, so accounts added or disabled meanwhile show up.
 * No enabled account: a pointer to the account page (when this user may open it); a list that could
 * not load: a retry. Read the choice with `useWxoaAccount().accountId`.
 */
defineOptions({ name: 'WxoaAccountSwitch' })
const { t } = useI18n()
const router = useRouter()
const { options, accountId, loading, failed, empty, load } = useWxoaAccount()
const kinds = useDict('wxoa.account_kind')

onMounted(load)
// a kept-alive page shows again
onActivated(load)

const ACCOUNT_PAGE = 'wxoa-account'
const canOpenAccounts = () => router.hasRoute(ACCOUNT_PAGE)
</script>

<template>
  <div class="wxoa-account-switch">
    <el-alert v-if="failed && !options.length" type="warning" :closable="false" show-icon>
      <template #title>{{ t('wxoa.account.switch.failed') }}</template>
      <el-button type="primary" link :loading="loading" @click="load">
        {{ t('common.action.retry') }}
      </el-button>
    </el-alert>
    <el-alert v-else-if="empty" type="info" :closable="false" show-icon>
      <template #title>{{ t('wxoa.account.switch.none') }}</template>
      <el-button
        v-if="canOpenAccounts()"
        type="primary"
        link
        @click="router.push({ name: ACCOUNT_PAGE })"
      >
        {{ t('wxoa.account.switch.goAccounts') }}
      </el-button>
      <span v-else>{{ t('wxoa.account.switch.askAdmin') }}</span>
    </el-alert>
    <template v-else>
      <span class="wxoa-account-switch__label">{{ t('field.wxoa.account.accountId') }}</span>
      <el-select
        v-model="accountId"
        :loading="loading"
        :aria-label="t('field.wxoa.account.accountId')"
        class="wxoa-account-switch__select"
      >
        <el-option
          v-for="o in options"
          :key="o.id"
          :value="o.id"
          :label="o.label"
          :disabled="!o.enabled"
        >
          <span>{{ o.label }}</span>
          <span class="wxoa-account-switch__meta">
            {{ o.enabled ? kinds.label(o.accountKind) : t('wxoa.account.switch.disabled') }}
          </span>
        </el-option>
      </el-select>
    </template>
  </div>
</template>

<style scoped>
.wxoa-account-switch {
  display: flex;
  gap: 8px;
  align-items: center;
}
.wxoa-account-switch__label {
  color: var(--qw-text-2);
  white-space: nowrap;
}
.wxoa-account-switch__select {
  width: 240px;
}
.wxoa-account-switch__meta {
  float: right;
  margin-left: 12px;
  font-size: 12px;
  color: var(--qw-text-3);
}
</style>
