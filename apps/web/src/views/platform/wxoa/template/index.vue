<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import { wxoaPerms, type WxoaTemplateVo } from '@qiwu/shared'
import { wxoaTemplateApi } from '@/api/platform/wxoa/template'
import EmptyState from '@/core/components/EmptyState.vue'
import QwTable from '@/core/components/QwTable.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import { toastRest } from '@/core/composables/use-crud'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { openDialog } from '@/core/dialog'
import { Icon } from '@/core/icons'
import { usePerm } from '@/core/permission'
import AccountSwitch from '../components/AccountSwitch.vue'
import { useWxoaAccount } from '../components/use-wxoa-account'
import WxoaTemplateRecords from './records.vue'
import WxoaTemplateSend from './send.vue'

/**
 * Template messages of the chosen account (see docs/design-notes.md#wxoa): the templates as WeChat
 * lists them (the server caches them briefly; "refresh from WeChat" asks again), deleting one on
 * WeChat, sending one to fans, and the send records (the message log's template rows, shown with
 * `wxoa.message.browse`).
 */
// keep-alive name = the seeded menu's component_name
defineOptions({ name: 'WxoaTemplate' })

const { t } = useI18n()
const perms = wxoaPerms.template
const perm = usePerm()
const canRecords = computed(() => perm.has(wxoaPerms.message.browse))
const { accountId } = useWxoaAccount()
const tab = ref<'templates' | 'records'>('templates')

/** the templates and the account they were loaded for (actions name that account) */
const list = shallowRef<{ accountId: number; items: WxoaTemplateVo[] } | null>(null)
const loading = ref(false)
const refreshing = ref(false)
let seq = 0
async function load(refresh = false) {
  const id = accountId.value
  const mine = ++seq
  if (id == null) return
  loading.value = true
  if (refresh) refreshing.value = true
  try {
    const items = await wxoaTemplateApi.list(id, refresh)
    if (mine === seq) list.value = { accountId: id, items }
  } catch (e) {
    if (mine === seq) toastRest(e)
  } finally {
    if (mine === seq) loading.value = refreshing.value = false
  }
}
const rows = computed(() => list.value?.items ?? [])

const columns: QwColumn[] = [
  { prop: 'title', label: 'wxoa.template.col.title', minWidth: 160, showOverflowTooltip: true },
  { prop: 'content', label: 'wxoa.template.col.content', minWidth: 280 },
  { prop: 'industry', label: 'wxoa.template.col.industry', width: 200 },
  {
    prop: 'templateId',
    label: 'wxoa.template.col.templateId',
    minWidth: 220,
    showOverflowTooltip: true,
  },
  { prop: 'example', label: 'wxoa.template.col.example', minWidth: 240, hidden: true },
]
const industry = (row: WxoaTemplateVo) =>
  [row.primaryIndustry, row.deputyIndustry].filter(Boolean).join(' / ')

const records = ref<InstanceType<typeof WxoaTemplateRecords>>()

watch(accountId, () => {
  // nothing of the previous account stays on screen, even if the new list fails to load
  list.value = null
  void load()
})
void load()

async function openSend(row: WxoaTemplateVo) {
  const owner = list.value?.accountId
  if (owner == null) return
  const count = await openDialog<number>(
    WxoaTemplateSend,
    { accountId: owner, template: row },
    { title: () => t('wxoa.template.send.title'), width: 680, top: '6vh' },
  )
  if (count == null) return
  ElMessage.success(t('wxoa.template.send.done', { count }))
  void records.value?.refresh()
}

async function remove(row: WxoaTemplateVo) {
  const owner = list.value?.accountId
  if (owner == null) return
  try {
    await ElMessageBox.confirm(
      t('wxoa.template.removeConfirm', { title: row.title }),
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
  try {
    await wxoaTemplateApi.remove(owner, row.templateId)
  } catch (e) {
    toastRest(e)
    return
  }
  ElMessage.success(t('crud.msg.deleted'))
  await load()
}
</script>

<template>
  <div class="qw-page">
    <AccountSwitch />
    <el-tabs v-if="accountId != null" v-model="tab">
      <el-tab-pane :label="t('wxoa.template.tab.templates')" name="templates">
        <el-card class="qw-table-panel">
          <TableToolbar
            table-id="wxoa.template"
            :columns="columns"
            :searchable="false"
            @refresh="load()"
          >
            <el-button type="primary" plain :loading="refreshing" @click="load(true)">
              <el-icon v-if="!refreshing" class="el-icon--left">
                <Icon icon="lucide:refresh-cw" />
              </el-icon>
              {{ t('wxoa.template.refresh') }}
            </el-button>
          </TableToolbar>
          <QwTable
            table-id="wxoa.template"
            :columns="columns"
            :data="rows"
            :loading="loading"
            row-key="templateId"
            :actions-width="140"
          >
            <template #cell-content="{ row }">
              <p class="wxoa-template__content">{{ row.content }}</p>
            </template>
            <template #cell-industry="{ row }">{{ industry(row) }}</template>
            <template #cell-example="{ row }">
              <p class="wxoa-template__content">{{ row.example }}</p>
            </template>
            <template #actions="{ row }">
              <el-button v-perm="perms.send" link type="primary" @click="openSend(row)">
                {{ t('wxoa.template.send.action') }}
              </el-button>
              <el-button v-perm="perms.remove" link type="danger" @click="remove(row)">
                {{ t('crud.action.delete') }}
              </el-button>
            </template>
            <template #empty>
              <EmptyState :description="t('wxoa.template.empty')" />
            </template>
          </QwTable>
        </el-card>
      </el-tab-pane>
      <el-tab-pane
        v-if="canRecords"
        :label="t('wxoa.template.tab.records')"
        name="records"
        lazy
        class="wxoa-template__records"
      >
        <WxoaTemplateRecords ref="records" :account-id="accountId" />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<style scoped>
.wxoa-template__content {
  margin: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.wxoa-template__records {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
</style>
