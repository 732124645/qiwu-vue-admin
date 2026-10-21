<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import dayjs from 'dayjs'
import {
  WXOA_MASS_KINDS,
  WXOA_MASS_RETRY_MS,
  WXOA_MASS_TARGETS,
  wxoaPerms,
  type WxoaMassCreate,
  type WxoaMassVo,
  type WxoaTagVo,
} from '@qiwu/shared'
import type { WxoaDraftVo } from '@/api/platform/wxoa/draft'
import { wxoaMassApi } from '@/api/platform/wxoa/mass'
import { wxoaTagApi } from '@/api/platform/wxoa/tag'
import DictTag from '@/core/components/DictTag.vue'
import EmptyState from '@/core/components/EmptyState.vue'
import Pagination from '@/core/components/Pagination.vue'
import QwTable from '@/core/components/QwTable.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import { toastRest, useCrudList } from '@/core/composables/use-crud'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { openDialog } from '@/core/dialog'
import { usePerm } from '@/core/permission'
import AccountSwitch from '../components/AccountSwitch.vue'
import { useWxoaAccount } from '../components/use-wxoa-account'
import VerifiedHint from '../components/VerifiedHint.vue'
import DraftPicker from '../draft/DraftPicker.vue'
import CommentDrawer from './CommentDrawer.vue'

/**
 * 群发：选对象与消息类型、预览给一个粉丝、二次确认后提交；下方是群发记录与结果，图文群发的
 * 记录可打开文章留言（按群发返回的 msg_data_id）。
 */
defineOptions({ name: 'WxoaMass' })
const { t } = useI18n()
const perm = usePerm()
const { accountId } = useWxoaAccount()
const can = computed(() => ({
  send: perm.has(wxoaPerms.mass.send),
  remove: perm.has(wxoaPerms.mass.remove),
  comments: perm.has(wxoaPerms.comment.browse),
}))
const target = reactive<{
  kind: (typeof WXOA_MASS_TARGETS)[number]
  tagId: number | null
  openIds: string
}>({ kind: 'all', tagId: null, openIds: '' })
const msgKind = ref<(typeof WXOA_MASS_KINDS)[number]>('text')
const text = ref('')
const mediaId = ref('')
const draft = ref<WxoaDraftVo | null>(null)
const sendIgnoreReprint = ref(false)
const tags = ref<WxoaTagVo[]>([])
const submitting = ref(false)
const previewOpenId = ref('')
const previewing = ref(false)
const removing = ref<number | null>(null)
const retrying = ref<number | null>(null)
const commentsOpen = ref(false)
const commentsOf = ref<string | null>(null)
/** 图文群发拿到 msg_data_id 后才有留言 */
const hasComments = (row: WxoaMassVo) => row.msgKind === 'mpnews' && !!row.msgDataId
/**
 * 可重发：提交结果未知（仍是 submitted 且没拿到 msg_id）且仍在微信按 clientmsgid 防重的时限内；
 * 过了时限再提交可能真的群发第二次，服务端也会拒绝。
 */
const canRetry = (row: WxoaMassVo) =>
  row.jobState === 'submitted' &&
  !row.wxMsgId &&
  Date.now() - Date.parse(row.createdAt) < WXOA_MASS_RETRY_MS
/** 回执里的总数、成功数、失败数（MASSSENDJOBFINISH 之后才有） */
function receiptOf(row: WxoaMassVo) {
  const r = row.result ?? {}
  const num = (v: unknown) => (typeof v === 'number' ? v : null)
  const total = num(r.totalCount)
  if (total == null) return ''
  return t('wxoa.mass.receipt', {
    total,
    sent: num(r.sentCount) ?? 0,
    error: num(r.errorCount) ?? 0,
  })
}
function openComments(row: WxoaMassVo) {
  commentsOf.value = row.msgDataId
  commentsOpen.value = true
}
const columns: QwColumn[] = [
  { prop: 'id', label: 'wxoa.mass.col.id', width: 90 },
  { prop: 'targetKind', label: 'wxoa.mass.col.target', width: 120 },
  { prop: 'msgKind', label: 'wxoa.mass.col.kind', width: 120 },
  { prop: 'jobState', label: 'wxoa.mass.col.state', width: 140 },
  {
    prop: 'clientMsgId',
    label: 'wxoa.mass.col.clientMsgId',
    minWidth: 200,
    showOverflowTooltip: true,
  },
  { prop: 'result', label: 'wxoa.mass.col.receipt', minWidth: 200 },
  { prop: 'finishedAt', label: 'wxoa.mass.col.finishedAt', width: 180 },
]
const { query, rows, total, loading, refresh } = useCrudList({
  api: {
    page: (params: Record<string, unknown>) =>
      accountId.value == null
        ? Promise.resolve({ items: [], total: 0 })
        : wxoaMassApi.page({ ...params, accountId: accountId.value }),
  },
  filters: {},
  sort: '-createdAt',
})
const displayDate = (value: string | null) => (value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '')
const openIdList = computed(() =>
  target.openIds
    .split(/[\s,\uFF0C]+/)
    .map((x) => x.trim())
    .filter(Boolean),
)
/** 消息体按微信群发接口的字段名组织；图文由服务端按草稿填 media_id */
const payload = () =>
  msgKind.value === 'text'
    ? { content: text.value }
    : msgKind.value === 'mpnews'
      ? {}
      : { media_id: mediaId.value.trim() }
async function loadTags() {
  if (accountId.value == null) return
  try {
    tags.value = await wxoaTagApi.list(accountId.value)
  } catch (e) {
    toastRest(e)
  }
}
/** 从已同步的草稿里选一份做图文群发（不在这里新建草稿）。 */
async function pickDraft() {
  if (accountId.value == null) return
  const picked = await openDialog<WxoaDraftVo>(
    DraftPicker,
    { accountId: accountId.value },
    { title: () => t('wxoa.mass.chooseDraft'), width: '640px' },
  )
  if (picked) draft.value = picked
}
function bodyOf(): WxoaMassCreate {
  return {
    accountId: accountId.value!,
    targetKind: target.kind,
    ...(target.kind === 'tag' && target.tagId != null ? { tagId: target.tagId } : {}),
    ...(target.kind === 'openids' ? { openIds: openIdList.value } : {}),
    msgKind: msgKind.value,
    payload: payload(),
    ...(msgKind.value === 'mpnews' && draft.value ? { draftId: draft.value.id } : {}),
    sendIgnoreReprint: sendIgnoreReprint.value,
  }
}
/** 提交前的本地检查，给出具体缺什么；其余以服务端校验为准。 */
function validate() {
  if (target.kind === 'tag' && target.tagId == null) {
    ElMessage.error(t('wxoa.mass.validation.tag'))
    return false
  }
  if (target.kind === 'openids' && openIdList.value.length < 2) {
    ElMessage.error(t('wxoa.mass.validation.openIds'))
    return false
  }
  if (msgKind.value === 'text' && !text.value.trim()) {
    ElMessage.error(t('wxoa.mass.validation.text'))
    return false
  }
  if (msgKind.value === 'mpnews' && !draft.value) {
    ElMessage.error(t('wxoa.mass.validation.draft'))
    return false
  }
  if (msgKind.value !== 'text' && msgKind.value !== 'mpnews' && !mediaId.value.trim()) {
    ElMessage.error(t('wxoa.mass.validation.media'))
    return false
  }
  return true
}

/** 二次确认的文案按对象区分：全部粉丝、某个标签（显示标签名）或 N 个 OpenID。 */
function confirmText() {
  if (target.kind === 'openids')
    return t('wxoa.mass.confirm.openids', { count: openIdList.value.length })
  if (target.kind === 'tag')
    return t('wxoa.mass.confirm.tag', {
      tag: tags.value.find((tag) => tag.tagId === target.tagId)?.name ?? String(target.tagId),
    })
  return t('wxoa.mass.confirm.all')
}

/** 群发不可撤回且有次数限制：确认后才提交。 */
async function send() {
  if (submitting.value || previewing.value || accountId.value == null || !validate()) return
  try {
    await ElMessageBox.confirm(confirmText(), t('wxoa.mass.confirmTitle'), {
      type: 'warning',
      confirmButtonText: t('wxoa.mass.send'),
      cancelButtonText: t('common.action.cancel'),
    })
  } catch {
    return
  }
  submitting.value = true
  try {
    await wxoaMassApi.create(bodyOf())
    ElMessage.success(t('wxoa.mass.sent'))
    await refresh()
  } catch (e) {
    toastRest(e)
    // 失败时任务可能已建好（结果未知或被微信拒绝）：刷新列表，结果未知的那条可以重发
    await refresh()
  } finally {
    submitting.value = false
  }
}
/** 重发结果未知的任务：确认后用原 clientmsgid 再提交一次，结束后刷新列表。 */
async function retry(row: WxoaMassVo) {
  if (retrying.value != null) return
  try {
    await ElMessageBox.confirm(t('wxoa.mass.retryConfirm'), t('wxoa.mass.confirmTitle'), {
      type: 'warning',
      confirmButtonText: t('wxoa.mass.retry'),
      cancelButtonText: t('common.action.cancel'),
    })
  } catch {
    return
  }
  retrying.value = row.id
  try {
    await wxoaMassApi.retry(row.id)
    ElMessage.success(t('wxoa.mass.sent'))
  } catch (e) {
    toastRest(e)
  } finally {
    retrying.value = null
    await refresh()
  }
}
/** 把同样的消息先发给一个粉丝看效果。 */
async function preview() {
  if (previewing.value || submitting.value || accountId.value == null) return
  const toOpenId = previewOpenId.value.trim()
  if (!toOpenId) {
    ElMessage.error(t('wxoa.mass.validation.previewOpenId'))
    return
  }
  if (!validate()) return
  previewing.value = true
  try {
    await wxoaMassApi.preview({ ...bodyOf(), toOpenId })
    ElMessage.success(t('wxoa.mass.preview.done'))
  } catch (e) {
    toastRest(e)
  } finally {
    previewing.value = false
  }
}
async function remove(row: WxoaMassVo) {
  if (removing.value != null) return
  try {
    await ElMessageBox.confirm(t('wxoa.mass.removeConfirm'), t('crud.confirm.title'), {
      type: 'warning',
      confirmButtonText: t('crud.action.delete'),
      cancelButtonText: t('common.action.cancel'),
    })
  } catch {
    return
  }
  removing.value = row.id
  try {
    await wxoaMassApi.remove(row.id)
    ElMessage.success(t('crud.msg.deleted'))
    await refresh()
  } catch (e) {
    toastRest(e)
  } finally {
    removing.value = null
  }
}
watch(accountId, () => {
  rows.value = []
  total.value = 0
  tags.value = []
  draft.value = null
  commentsOpen.value = false
  void loadTags()
  void refresh()
})
void loadTags()
</script>

<template>
  <div class="qw-page wxoa-mass-page">
    <AccountSwitch />
    <template v-if="accountId != null">
      <VerifiedHint />
      <el-card v-if="can.send" class="wxoa-mass__composer">
        <template #header
          ><div class="wxoa-mass__heading">{{ t('wxoa.mass.compose') }}</div></template
        >
        <el-form label-position="top">
          <el-form-item :label="t('wxoa.mass.target.label')">
            <el-radio-group v-model="target.kind"
              ><el-radio v-for="k in WXOA_MASS_TARGETS" :key="k" :value="k">{{
                t(`wxoa.mass.target.${k}`)
              }}</el-radio></el-radio-group
            >
          </el-form-item>
          <el-form-item v-if="target.kind === 'tag'" :label="t('wxoa.mass.target.tagLabel')"
            ><el-select v-model="target.tagId" clearable
              ><el-option
                v-for="tag in tags"
                :key="tag.tagId"
                :value="tag.tagId"
                :label="tag.name" /></el-select
          ></el-form-item>
          <el-form-item v-if="target.kind === 'openids'" :label="t('wxoa.mass.target.openIds')"
            ><el-input
              v-model="target.openIds"
              type="textarea"
              :rows="3"
              :placeholder="t('wxoa.mass.target.openIdsPlaceholder')"
            />
            <div class="wxoa-mass__hint">
              {{ t('wxoa.mass.target.openIdsHint', { count: openIdList.length }) }}
            </div></el-form-item
          >
          <el-form-item :label="t('wxoa.mass.kindLabel')"
            ><el-radio-group v-model="msgKind"
              ><el-radio v-for="k in WXOA_MASS_KINDS" :key="k" :value="k">{{
                t(`wxoa.mass.kind.${k}`)
              }}</el-radio></el-radio-group
            ></el-form-item
          >
          <el-form-item v-if="msgKind === 'text'" :label="t('wxoa.mass.text')"
            ><el-input v-model="text" type="textarea" :rows="4" maxlength="600" show-word-limit
          /></el-form-item>
          <el-form-item v-else-if="msgKind === 'mpnews'" :label="t('wxoa.mass.draft')"
            ><div class="wxoa-mass__draft">
              <el-tag v-if="draft">{{ draft.title }}</el-tag
              ><el-button type="primary" plain @click="pickDraft">{{
                draft ? t('wxoa.mass.changeDraft') : t('wxoa.mass.chooseDraft')
              }}</el-button>
            </div></el-form-item
          >
          <el-form-item v-else :label="t('wxoa.mass.mediaId')"
            ><el-input v-model="mediaId"
          /></el-form-item>
          <el-checkbox v-model="sendIgnoreReprint">{{ t('wxoa.mass.ignoreReprint') }}</el-checkbox>
          <div class="wxoa-mass__footer">
            <el-input
              v-model="previewOpenId"
              :placeholder="t('wxoa.mass.preview.openId')"
              :aria-label="t('wxoa.mass.preview.openId')"
              class="wxoa-mass__preview-id"
            /><el-button :loading="previewing" :disabled="submitting" @click="preview">{{
              t('wxoa.mass.preview.action')
            }}</el-button
            ><el-button type="primary" :loading="submitting" :disabled="previewing" @click="send">{{
              t('wxoa.mass.send')
            }}</el-button>
          </div>
        </el-form>
      </el-card>
      <el-card class="qw-table-panel">
        <TableToolbar
          table-id="wxoa.mass"
          :columns="columns"
          :searchable="false"
          @refresh="refresh"
        />
        <QwTable table-id="wxoa.mass" :columns="columns" :data="rows" :loading="loading">
          <template #cell-targetKind="{ row }"
            ><DictTag code="wxoa.mass_target" :value="row.targetKind"
          /></template>
          <template #cell-msgKind="{ row }">{{ t(`wxoa.mass.kind.${row.msgKind}`) }}</template>
          <template #cell-jobState="{ row }"
            ><DictTag code="wxoa.mass_state" :value="row.jobState"
          /></template>
          <template #cell-result="{ row }">{{ receiptOf(row) }}</template>
          <template #cell-finishedAt="{ row }">{{ displayDate(row.finishedAt) }}</template>
          <template #actions="{ row }"
            ><el-button
              v-if="can.send && canRetry(row)"
              link
              type="primary"
              :loading="retrying === row.id"
              :disabled="retrying != null && retrying !== row.id"
              @click="retry(row)"
              >{{ t('wxoa.mass.retry') }}</el-button
            ><el-button
              v-if="can.comments && hasComments(row)"
              link
              type="primary"
              @click="openComments(row)"
              >{{ t('wxoa.mass.comments.action') }}</el-button
            ><el-button
              v-if="can.remove"
              link
              type="danger"
              :loading="removing === row.id"
              :disabled="removing != null && removing !== row.id"
              @click="remove(row)"
              >{{ t('crud.action.delete') }}</el-button
            ></template
          >
          <template #empty><EmptyState :description="t('wxoa.mass.empty')" /></template>
        </QwTable>
        <Pagination
          v-model:page="query.page"
          v-model:page-size="query.pageSize"
          :total="total"
          @change="refresh"
        />
      </el-card>
      <CommentDrawer v-model="commentsOpen" :account-id="accountId" :msg-data-id="commentsOf" />
    </template>
  </div>
</template>

<style scoped>
.wxoa-mass__composer {
  margin-bottom: 16px;
}
.wxoa-mass__heading {
  font-weight: 600;
}
.wxoa-mass__draft {
  display: flex;
  gap: 8px;
  align-items: center;
}
.wxoa-mass__hint {
  width: 100%;
  font-size: 12px;
  line-height: 1.5;
  color: var(--qw-text-3);
}
.wxoa-mass__footer {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  justify-content: flex-end;
  margin-top: 16px;
}
.wxoa-mass__footer .el-button + .el-button {
  margin-left: 0;
}
.wxoa-mass__preview-id {
  width: 240px;
}
</style>
