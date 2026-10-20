<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AccessTokenVo } from '@qiwu/shared'
import { tokenState } from '@/api/platform/mcp'

/** 令牌状态胶囊：有效、已吊销、已过期（按此刻计算）。 */
const { token } = defineProps<{ token: Pick<AccessTokenVo, 'revokedAt' | 'expiresAt'> }>()
const { t } = useI18n()
const state = computed(() => tokenState(token))
const TYPE = { active: 'success', revoked: 'danger', expired: 'info' } as const
</script>

<template>
  <el-tag size="small" :type="TYPE[state]" disable-transitions>
    {{ t(`mcp.token.state.${state}`) }}
  </el-tag>
</template>
