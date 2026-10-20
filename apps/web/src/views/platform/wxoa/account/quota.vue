<script setup lang="ts">
import { onMounted, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import { WXOA_CLEAR_QUOTA_MONTHLY, wxoaPerms, type WxoaQuotaVo } from '@qiwu/shared'
import { wxoaAccountApi } from '@/api/platform/wxoa/account'
import { toastRest } from '@/core/composables/use-crud'
import QwTable from '@/core/components/QwTable.vue'
import type { QwColumn } from '@/core/composables/use-table-prefs'

/**
 * Daily API quotas of an account, `openDialog(WxoaAccountQuota, { id })`. Resetting the counts is
 * confirmed first: WeChat allows it 10 times a month, counted together with the console's reset.
 */
defineOptions({ name: 'WxoaAccountQuota' })
const { id } = defineProps<{ id: number }>()
const emit = defineEmits<{ cancel: [] }>()
const { t } = useI18n()

const rows = shallowRef<WxoaQuotaVo>([])
const loading = ref(false)
const columns: QwColumn[] = [
  { prop: 'api', label: 'wxoa.account.quota.api', minWidth: 200 },
  { prop: 'dailyLimit', label: 'wxoa.account.quota.dailyLimit', width: 110 },
  { prop: 'used', label: 'wxoa.account.quota.used', width: 90 },
  { prop: 'remain', label: 'wxoa.account.quota.remain', width: 90 },
]
async function load() {
  loading.value = true
  try {
    rows.value = await wxoaAccountApi.quota(id)
  } catch (e) {
    toastRest(e)
  } finally {
    loading.value = false
  }
}
onMounted(load)

const clearing = ref(false)
async function clear() {
  if (clearing.value) return
  try {
    await ElMessageBox.confirm(
      t('wxoa.account.quota.clearConfirm', { count: WXOA_CLEAR_QUOTA_MONTHLY }),
      t('wxoa.account.quota.clear'),
      {
        type: 'warning',
        confirmButtonText: t('wxoa.account.quota.clear'),
        cancelButtonText: t('common.action.cancel'),
      },
    )
  } catch {
    return
  }
  clearing.value = true
  try {
    await wxoaAccountApi.clearQuota(id)
    ElMessage.success(t('wxoa.account.quota.cleared'))
    await load()
  } catch (e) {
    toastRest(e)
  } finally {
    clearing.value = false
  }
}
</script>

<template>
  <QwTable table-id="wxoa.account.quota" :columns="columns" :data="rows" :loading="loading" />
  <div class="qw-dialog-footer">
    <el-button
      v-perm="wxoaPerms.account['clear-quota']"
      type="danger"
      plain
      :loading="clearing"
      :disabled="clearing"
      @click="clear"
    >
      {{ t('wxoa.account.quota.clear') }}
    </el-button>
    <el-button @click="emit('cancel')">{{ t('wxoa.account.close') }}</el-button>
  </div>
</template>
