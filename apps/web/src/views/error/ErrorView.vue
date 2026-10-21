<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const { status = 404 } = defineProps<{ status?: 403 | 404 }>()
const { t } = useI18n()

const subTitle = {
  403: 'common.error.forbidden',
  404: 'common.error.notFound',
}
</script>

<template>
  <el-result
    :icon="status === 403 ? 'warning' : 'info'"
    :title="String(status)"
    :sub-title="t(subTitle[status])"
  >
    <template #extra>
      <el-button type="primary" @click="$router.replace('/')">{{
        t('common.action.backHome')
      }}</el-button>
    </template>
  </el-result>
</template>
