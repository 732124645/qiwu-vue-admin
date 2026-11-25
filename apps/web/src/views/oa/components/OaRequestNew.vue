<script setup lang="ts">
import { computed, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useTagsStore } from '@/core/stores/tags'
import { officeResources, type OfficeResource } from './resources'
import { officeWorkflowAvailable } from './access'
import { useAuthStore } from '@/core/stores/auth'
const { kind, form } = defineProps<{ kind: OfficeResource['kind']; form: Component }>()
const resource = officeResources[kind]
const { t } = useI18n()
const router = useRouter()
const route = useRoute()
const tags = useTagsStore()
const auth = useAuthStore()
const hasWorkflow = computed(() => officeWorkflowAvailable(auth.me))
const mayCreate = computed(() => hasWorkflow.value && auth.hasPerm(resource.perms.create))
function leave(path: string) {
  tags.close((tag) => tag.path === route.path)
  return router.push(path)
}
</script>
<template>
  <div class="qw-page">
    <div class="qw-page-bar">
      <el-button @click="leave(resource.path)">{{ t('oa.returnToList') }}</el-button>
    </div>
    <el-alert
      v-if="!mayCreate"
      :title="t(hasWorkflow ? 'oa.notAllowed' : 'oa.workflowUnavailable')"
      type="info"
      :closable="false"
      show-icon
    />
    <el-card v-else class="oa-new"
      ><component
        :is="form"
        @done="(saved: { id: number }) => leave(`${resource.path}/${saved.id}`)"
        @cancel="leave(resource.path)"
    /></el-card>
  </div>
</template>
<style scoped>
.oa-new {
  max-width: 900px;
}
</style>
