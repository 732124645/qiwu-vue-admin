<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import { Icon } from '@/core/icons'

/**
 * 刚建好的访问令牌，只显示这一次（服务端只存摘要）：`openDialog(AccessTokenCreated, { token },
 * { closeOnPressEscape: false })`。关闭后令牌不再保留在页面里。
 */
defineOptions({ name: 'AccessTokenCreated' })
const { token } = defineProps<{ token: string }>()
const emit = defineEmits<{ done: [ok: true]; cancel: [] }>()
const { t } = useI18n()

/** 复制令牌；没有剪贴板权限时提示手动选中复制。 */
async function copy() {
  try {
    await navigator.clipboard.writeText(token)
    ElMessage.success(t('mcp.copied'))
  } catch {
    ElMessage.error(t('mcp.copyFailed'))
  }
}
</script>

<template>
  <el-alert type="warning" :title="t('mcp.token.once')" :closable="false" show-icon />
  <el-input :model-value="token" readonly class="token-created" :aria-label="t('menu.mcp.token')">
    <template #append>
      <el-button :aria-label="t('mcp.copy')" @click="copy">
        <Icon icon="lucide:copy" />
      </el-button>
    </template>
  </el-input>
  <div class="qw-dialog-footer">
    <el-button type="primary" @click="emit('done', true)">{{ t('mcp.token.saved') }}</el-button>
  </div>
</template>

<style scoped>
.token-created {
  margin-top: 16px;
}
.token-created :deep(input) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
</style>
