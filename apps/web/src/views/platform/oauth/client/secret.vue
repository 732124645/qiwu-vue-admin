<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import { Icon } from '@/core/icons'

/**
 * A client's secret, shown this once (after an add or a reset): the server keeps only its hash. Opened with
 * `openDialog(ClientSecret, { clientId, secret }, { closeOnPressEscape: false })`.
 */
defineOptions({ name: 'OauthClientSecret' })
defineProps<{ clientId: string; secret: string }>()
const emit = defineEmits<{ done: [ok: true]; cancel: [] }>()
const { t } = useI18n()

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success(t('code.copied'))
  } catch {
    // no clipboard (an insecure context, a denied permission): the field stays there to select
    ElMessage.error(t('oauth.client.copyFailed'))
  }
}
</script>

<template>
  <el-alert type="warning" :title="t('oauth.client.secretOnce')" :closable="false" show-icon />
  <el-form label-position="top" class="client-secret">
    <el-form-item :label="t('field.oauth.client.clientId')">
      <el-input :model-value="clientId" readonly>
        <template #append>
          <el-button :aria-label="t('oauth.client.copy')" @click="copy(clientId)">
            <Icon icon="lucide:copy" />
          </el-button>
        </template>
      </el-input>
    </el-form-item>
    <el-form-item :label="t('field.oauth.client.secret')">
      <el-input :model-value="secret" readonly class="client-secret__value">
        <template #append>
          <el-button :aria-label="t('oauth.client.copy')" @click="copy(secret)">
            <Icon icon="lucide:copy" />
          </el-button>
        </template>
      </el-input>
    </el-form-item>
  </el-form>
  <div class="qw-dialog-footer">
    <el-button type="primary" @click="emit('done', true)">
      {{ t('oauth.client.secretSaved') }}
    </el-button>
  </div>
</template>

<style scoped>
.client-secret {
  margin-top: 16px;
}
.client-secret__value :deep(input) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
</style>
