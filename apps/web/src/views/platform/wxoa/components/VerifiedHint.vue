<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useWxoaAccount } from './use-wxoa-account'

/**
 * 草稿、发布、群发、统计、留言、订阅通知这些接口微信只对认证账号开放：当前账号未认证或是测试号时提示一句。
 * 只提示不禁用，能否调用以微信的应答为准。
 */
defineOptions({ name: 'WxoaVerifiedHint' })
const { t } = useI18n()
const { account } = useWxoaAccount()
const show = computed(
  () =>
    account.value != null && (!account.value.verified || account.value.accountKind === 'sandbox'),
)
</script>

<template>
  <el-alert
    v-if="show"
    class="wxoa-verified-hint"
    type="info"
    :closable="false"
    show-icon
    :title="t('wxoa.account.needVerified')"
  />
</template>

<style scoped>
.wxoa-verified-hint {
  margin-bottom: 16px;
}
</style>
