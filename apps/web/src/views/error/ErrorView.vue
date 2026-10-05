<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { safeRedirect } from '@/core/router'

const { status = 404 } = defineProps<{ status?: 403 | 404 | 503 }>()
const { t } = useI18n()
const route = useRoute()
const router = useRouter()

const subTitle = {
  403: 'common.error.forbidden',
  404: 'common.error.notFound',
  503: 'common.error.unavailable',
}
/** 503: back to the page the first load was for; the router guard tries the API again (~20 s). */
const retrying = ref(false)
async function retry() {
  retrying.value = true
  try {
    await router.replace(safeRedirect(route.query.redirect))
  } finally {
    retrying.value = false
  }
}
</script>

<template>
  <el-result
    :icon="status === 503 ? 'error' : status === 403 ? 'warning' : 'info'"
    :title="String(status)"
    :sub-title="t(subTitle[status])"
  >
    <template #extra>
      <template v-if="status === 503">
        <el-button type="primary" :loading="retrying" @click="retry">{{
          t('common.action.retry')
        }}</el-button>
        <!-- a way out while the refresh keeps failing -->
        <el-button @click="$router.replace({ path: '/login', query: route.query })">{{
          t('common.action.signIn')
        }}</el-button>
      </template>
      <el-button v-else type="primary" @click="$router.replace('/')">{{
        t('common.action.backHome')
      }}</el-button>
    </template>
  </el-result>
</template>
