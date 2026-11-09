<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import IconButton from '@/core/components/IconButton.vue'
import { useImStore } from './im-store'

/**
 * 顶栏聊天入口：探测 `GET /api/im/options` 成功（或断网/5xx 时本地已有本账号缓存）才显示，404（开关关、
 * 套餐不含）与 403（非员工）隐藏；角标是各会话未读合计（99+）。
 */
defineOptions({ name: 'ImHeaderEntry' })
const { t } = useI18n()
const router = useRouter()
const im = useImStore()
const label = computed(() =>
  im.unread ? t('im.entryUnread', { count: im.unread }) : t('im.entry'),
)
</script>

<template>
  <span v-if="im.enabled" class="im-header-entry">
    <el-badge :value="im.unread" :max="99" :hidden="!im.unread" class="im-header-entry__badge">
      <IconButton
        icon="lucide:message-circle"
        :label="label"
        @click="router.push({ name: 'im-chat' })"
      />
    </el-badge>
  </span>
</template>

<style scoped>
.im-header-entry {
  display: inline-flex;
}
.im-header-entry__badge :deep(.el-badge__content) {
  top: 6px;
  right: 8px;
}
</style>
