<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import { wxoaPerms, type WxoaNoticeTemplateVo } from '@qiwu/shared'
import { wxoaNoticeApi } from '@/api/platform/wxoa/notice'
import QwTable from '@/core/components/QwTable.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import EmptyState from '@/core/components/EmptyState.vue'
import { toastRest } from '@/core/composables/use-crud'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { usePerm } from '@/core/permission'
import { openDialog } from '@/core/dialog'
import AccountSwitch from '../components/AccountSwitch.vue'
import { useWxoaAccount } from '../components/use-wxoa-account'
import VerifiedHint from '../components/VerifiedHint.vue'
import NoticeAdd from './add.vue'
import NoticeSend from './send.vue'

/** 订阅通知：我的模板（可从微信刷新）、从模板库添加、删除与发送。 */
defineOptions({ name: 'WxoaNotice' })
const { t } = useI18n()
const { accountId } = useWxoaAccount()
const perm = usePerm()
const perms = { modify: wxoaPerms.notice.modify, send: wxoaPerms.notice.send }
const can = computed(() => ({ modify: perm.has(perms.modify), send: perm.has(perms.send) }))
const rows = ref<WxoaNoticeTemplateVo[]>([])
const loading = ref(false)
const refreshing = ref(false)
/** 正在删除的模板 */
const removing = ref('')
const columns: QwColumn[] = [
  { prop: 'title', label: 'wxoa.notice.col.title', minWidth: 220, showOverflowTooltip: true },
  { prop: 'content', label: 'wxoa.notice.col.content', minWidth: 300, showOverflowTooltip: true },
  { prop: 'priTmplId', label: 'wxoa.notice.col.id', minWidth: 230, showOverflowTooltip: true },
]
const display = (row: WxoaNoticeTemplateVo) => row.content
async function load(refresh = false) {
  if (accountId.value == null) return
  loading.value = true
  if (refresh) refreshing.value = true
  try {
    rows.value = await wxoaNoticeApi.list(accountId.value, refresh)
  } catch (e) {
    toastRest(e)
  } finally {
    loading.value = refreshing.value = false
  }
}
/** 打开模板库对话框，添加成功后刷新我的模板。 */
async function addTemplate() {
  if (accountId.value == null) return
  const added = await openDialog<string>(
    NoticeAdd,
    { accountId: accountId.value },
    { title: () => t('wxoa.notice.add.title'), width: 720 },
  )
  if (!added) return
  ElMessage.success(t('wxoa.notice.add.done'))
  await load(true)
}
async function remove(row: WxoaNoticeTemplateVo) {
  const id = accountId.value
  if (id == null || removing.value) return
  try {
    await ElMessageBox.confirm(
      t('wxoa.notice.removeConfirm', { title: row.title }),
      t('crud.confirm.title'),
      {
        type: 'warning',
        confirmButtonText: t('crud.action.delete'),
        cancelButtonText: t('common.action.cancel'),
      },
    )
  } catch {
    return
  }
  removing.value = row.priTmplId
  try {
    await wxoaNoticeApi.remove(row.priTmplId, id)
    ElMessage.success(t('crud.msg.deleted'))
    await load(true)
  } catch (e) {
    toastRest(e)
  } finally {
    removing.value = ''
  }
}
async function send(row: WxoaNoticeTemplateVo) {
  if (accountId.value == null) return
  const count = await openDialog<number>(
    NoticeSend,
    { accountId: accountId.value, template: row },
    { title: () => t('wxoa.notice.send.title'), width: 700 },
  )
  if (count != null) ElMessage.success(t('wxoa.notice.send.done', { count }))
}
watch(accountId, () => {
  rows.value = []
  void load()
})
void load()
</script>

<template>
  <div class="qw-page wxoa-notice-page">
    <AccountSwitch />
    <template v-if="accountId != null">
      <VerifiedHint />
      <el-card class="qw-table-panel">
        <TableToolbar
          table-id="wxoa.notice"
          :columns="columns"
          :searchable="false"
          @refresh="load()"
        >
          <el-button :loading="refreshing" @click="load(true)">{{
            t('wxoa.notice.refresh')
          }}</el-button>
          <el-button v-if="can.modify" type="primary" @click="addTemplate">{{
            t('wxoa.notice.add.action')
          }}</el-button>
        </TableToolbar>
        <QwTable
          table-id="wxoa.notice"
          :columns="columns"
          :data="rows"
          :loading="loading"
          :actions-width="160"
        >
          <template #cell-content="{ row }"
            ><span class="wxoa-notice__content">{{ display(row) }}</span></template
          >
          <template #actions="{ row }"
            ><el-button v-if="can.send" link type="primary" @click="send(row)">{{
              t('wxoa.notice.send.action')
            }}</el-button
            ><el-button
              v-if="can.modify"
              link
              type="danger"
              :loading="removing === row.priTmplId"
              :disabled="!!removing && removing !== row.priTmplId"
              @click="remove(row)"
              >{{ t('crud.action.delete') }}</el-button
            ></template
          >
          <template #empty><EmptyState :description="t('wxoa.notice.empty')" /></template>
        </QwTable>
      </el-card>
    </template>
  </div>
</template>

<style scoped>
.wxoa-notice__content {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
