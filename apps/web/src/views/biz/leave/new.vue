<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { Icon } from '@/core/icons'
import { useTagsStore } from '@/core/stores/tags'
import LeaveForm from './form.vue'

/**
 * New leave request (hidden page /biz/leave/new, model leave's `create_route`; see docs/design-notes.md#workflow): the
 * submit saves the request and starts its approval in one request, then the request's page opens.
 */
defineOptions({ name: 'BizLeaveNew' })
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const tags = useTagsStore()

/** leaves this page for `path`, closing its tag */
function leave(path: string) {
  tags.close((tag) => tag.path === route.path)
  return router.push(path)
}
</script>

<template>
  <div class="qw-page">
    <div class="qw-page-bar">
      <el-button @click="leave('/biz/leave')">
        <el-icon class="el-icon--left"><Icon icon="lucide:arrow-left" /></el-icon>
        {{ t('biz.leave.backToList') }}
      </el-button>
    </div>
    <el-card class="qw-form-card leave-new">
      <LeaveForm @done="(saved) => leave(`/biz/leave/${saved.id}`)" @cancel="leave('/biz/leave')" />
    </el-card>
  </div>
</template>

<style scoped>
.leave-new {
  max-width: 720px;
}
</style>
