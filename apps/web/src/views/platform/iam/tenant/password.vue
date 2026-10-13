<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import { Icon } from '@/core/icons'

/**
 * A tenant's initial password, shown this once (after opening the tenant, with its administrator's
 * username, or after a reset): the server keeps only its hash. Opened with
 * `openDialog(TenantPassword, { username?, password }, { closeOnPressEscape: false })`.
 */
defineOptions({ name: 'IamTenantPassword' })
const { username } = defineProps<{ username?: string; password: string }>()
const emit = defineEmits<{ done: [ok: true]; cancel: [] }>()
const { t } = useI18n()

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success(t('iam.tenant.copied'))
  } catch {
    // no clipboard (an insecure context, a denied permission): the field stays there to select
    ElMessage.error(t('iam.tenant.copyFailed'))
  }
}
</script>

<template>
  <el-alert
    type="warning"
    :title="t(username == null ? 'iam.tenant.resetPassword.hint' : 'iam.tenant.created.hint')"
    :closable="false"
    show-icon
  />
  <el-form label-position="top" class="tenant-password">
    <el-form-item v-if="username != null" :label="t('iam.tenant.created.username')">
      <el-input :model-value="username" readonly>
        <template #append>
          <el-button :aria-label="t('iam.tenant.copy')" @click="copy(username)">
            <Icon icon="lucide:copy" />
          </el-button>
        </template>
      </el-input>
    </el-form-item>
    <el-form-item :label="t('iam.tenant.created.password')">
      <el-input :model-value="password" readonly class="tenant-password__value">
        <template #append>
          <el-button :aria-label="t('iam.tenant.copy')" @click="copy(password)">
            <Icon icon="lucide:copy" />
          </el-button>
        </template>
      </el-input>
    </el-form-item>
  </el-form>
  <div class="qw-dialog-footer">
    <el-button type="primary" @click="emit('done', true)">{{ t('iam.tenant.saved') }}</el-button>
  </div>
</template>

<style scoped>
.tenant-password {
  margin-top: 16px;
}
.tenant-password__value :deep(input) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
</style>
