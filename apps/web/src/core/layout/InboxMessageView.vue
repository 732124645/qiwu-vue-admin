<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import dayjs from 'dayjs'
import { agentPerms, type MyInboxItemVo } from '@qiwu/shared'
import { useAuthStore } from '@/core/stores/auth'
import { useMenuStore } from '@/core/stores/menu'

/**
 * One inbox message as its recipient sees it (`openDialog` content, the dialog title is the message's):
 * category, sender, time and the body as plain text (never v-html; line breaks by
 * `white-space: pre-line`; see docs/design-notes.md#security).
 */
defineOptions({ name: 'InboxMessageView' })
const { message } = defineProps<{ message: MyInboxItemVo }>()
const emit = defineEmits<{ cancel: [] }>()
const { t } = useI18n()
const router = useRouter()
const auth = useAuthStore()
const menu = useMenuStore()
const opening = ref(false)
const threadId = computed(() => {
  const action = message.action
  return action?.kind === 'agent-thread' &&
    Number.isSafeInteger(action.threadId) &&
    action.threadId > 0 &&
    auth.hasPerm(agentPerms.chat.use) &&
    menu.routes.some((route) => route.name === 'agent-chat')
    ? action.threadId
    : null
})

/** 使用已核对的会话编号构造站内路由；通知参数没有任意跳转地址。 */
async function openConversation() {
  if (!threadId.value || opening.value) return
  opening.value = true
  try {
    const result = await router.push({
      name: 'agent-chat',
      query: { thread: String(threadId.value) },
    })
    if (!result) emit('cancel')
  } finally {
    opening.value = false
  }
}
</script>

<template>
  <article class="inbox-message-view">
    <div class="inbox-message-view__meta">
      <span>{{ t(`notify.inbox.category.${message.category}`) }}</span>
      <span>{{ message.senderLabel || t('notify.inbox.systemSender') }}</span>
      <time :datetime="message.createdAt">{{
        dayjs(message.createdAt).format('YYYY-MM-DD HH:mm')
      }}</time>
    </div>
    <div class="inbox-message-view__body">{{ message.body }}</div>
    <div class="qw-dialog-footer">
      <el-button
        v-if="threadId"
        type="primary"
        :loading="opening"
        :disabled="opening"
        @click="openConversation"
      >
        {{ t('notify.inbox.openConversation') }}
      </el-button>
      <el-button @click="emit('cancel')">{{ t('notify.inbox.close') }}</el-button>
    </div>
  </article>
</template>

<style scoped>
.inbox-message-view__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 16px;
  font-size: 13px;
  color: var(--qw-text-3);
}
.inbox-message-view__body {
  max-height: 60vh;
  overflow: auto;
  line-height: 1.7;
  white-space: pre-line;
  overflow-wrap: anywhere;
  color: var(--qw-text);
}
</style>
