<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  WXOA_COMMENT_PAGE_MAX,
  wxoaPerms,
  type WxoaCommentOpen,
  type WxoaCommentVo,
} from '@qiwu/shared'
import { wxoaCommentApi } from '@/api/platform/wxoa/comment'
import Pagination from '@/core/components/Pagination.vue'
import { toastRest } from '@/core/composables/use-crud'
import { usePerm } from '@/core/permission'

/**
 * 图文群发的文章留言：微信的留言接口按群发返回的 msg_data_id 和篇序号（从 0 开始）定位文章，
 * 所以只能从群发记录打开。可切换篇目、只看精选，可打开或关闭该篇的留言；精选、回复、删除回复与删除
 * 同一时间只跑一个。
 */
const props = defineProps<{ accountId: number; msgDataId: string | null }>()
const visible = defineModel<boolean>({ required: true })
const { t } = useI18n()
const perm = usePerm()
const can = computed(() => ({
  modify: perm.has(wxoaPerms.comment.modify),
  send: perm.has(wxoaPerms.comment.send),
  remove: perm.has(wxoaPerms.comment.remove),
}))
const comments = ref<WxoaCommentVo[]>([])
const loading = ref(false)
const total = ref(0)
const page = ref(1)
/** 第几篇（界面从 1 数，发给微信时减 1） */
const article = ref(1)
const type = ref<'all' | 'elect'>('all')
const replyText = ref<Record<string, string>>({})
/** 正在执行的操作（如 `elect:<留言 id>`），对应按钮加载、其余禁用 */
const acting = ref('')

/** 当前文章的留言定位 */
function parentOf(): WxoaCommentOpen | null {
  if (!props.msgDataId) return null
  return { accountId: props.accountId, msgDataId: props.msgDataId, index: article.value - 1 }
}
async function load() {
  const parent = parentOf()
  if (!parent) return
  loading.value = true
  try {
    const result = await wxoaCommentApi.page({
      ...parent,
      type: type.value,
      page: page.value,
      pageSize: WXOA_COMMENT_PAGE_MAX,
    })
    comments.value = result.items
    total.value = result.total
  } catch (e) {
    toastRest(e)
  } finally {
    loading.value = false
  }
}
/** 执行一个留言操作：同一时间只跑一个，结束后重载留言。 */
async function act(key: string, run: (parent: WxoaCommentOpen) => Promise<unknown>) {
  const parent = parentOf()
  if (!parent || acting.value) return false
  acting.value = key
  try {
    await run(parent)
    await load()
    return true
  } catch (e) {
    toastRest(e)
    return false
  } finally {
    acting.value = ''
  }
}
function toggleElect(c: WxoaCommentVo) {
  return act(`elect:${c.userCommentId}`, (parent) =>
    c.isElect
      ? wxoaCommentApi.unelect(c.userCommentId, parent)
      : wxoaCommentApi.elect(c.userCommentId, parent),
  )
}
async function reply(c: WxoaCommentVo) {
  const content = replyText.value[c.userCommentId]?.trim()
  if (!content) return
  const done = await act(`reply:${c.userCommentId}`, (parent) =>
    wxoaCommentApi.reply(c.userCommentId, { ...parent, content }),
  )
  if (done) replyText.value[c.userCommentId] = ''
}
/** 删除前的二次确认；取消返回 false。 */
async function confirmed(message: string) {
  try {
    await ElMessageBox.confirm(message, t('crud.confirm.title'), {
      type: 'warning',
      confirmButtonText: t('crud.action.delete'),
      cancelButtonText: t('common.action.cancel'),
    })
    return true
  } catch {
    return false
  }
}
async function remove(c: WxoaCommentVo) {
  if (acting.value || !(await confirmed(t('wxoa.mass.comments.removeConfirm')))) return
  await act(`remove:${c.userCommentId}`, (parent) => wxoaCommentApi.remove(c.userCommentId, parent))
}
/** 删除作者对这条留言的回复（不可恢复，先确认）。 */
async function removeReply(c: WxoaCommentVo) {
  if (acting.value || !(await confirmed(t('wxoa.mass.comments.removeReplyConfirm')))) return
  await act(`removeReply:${c.userCommentId}`, (parent) =>
    wxoaCommentApi.removeReply(c.userCommentId, parent),
  )
}
/** 打开或关闭当前这篇文章的留言功能。 */
async function toggleOpen(open: boolean) {
  const done = await act(open ? 'open' : 'close', (parent) =>
    open ? wxoaCommentApi.open(parent) : wxoaCommentApi.close(parent),
  )
  if (done) ElMessage.success(t(open ? 'wxoa.mass.comments.opened' : 'wxoa.mass.comments.closed'))
}
// 打开或换了群发任务时回到第一篇第一页；换篇目或筛选时回到第一页
watch(
  () => [visible.value, props.msgDataId] as const,
  ([open]) => {
    if (!open) return
    page.value = 1
    comments.value = []
    // 换回第一篇时由下面的监听加载，避免重复请求
    if (article.value !== 1) article.value = 1
    else void load()
  },
  { immediate: true },
)
watch([article, type], () => {
  if (!visible.value) return
  page.value = 1
  void load()
})
</script>

<template>
  <el-drawer v-model="visible" :title="t('wxoa.mass.comments.title')" size="560px">
    <div class="wxoa-comments">
      <div class="wxoa-comments__filters">
        <span>{{ t('wxoa.mass.comments.article') }}</span>
        <el-input-number
          v-model="article"
          :min="1"
          :max="8"
          :aria-label="t('wxoa.mass.comments.article')"
          size="small"
        />
        <el-radio-group v-model="type"
          ><el-radio-button value="all">{{ t('wxoa.mass.comments.all') }}</el-radio-button
          ><el-radio-button value="elect">{{
            t('wxoa.mass.comments.elected')
          }}</el-radio-button></el-radio-group
        >
        <template v-if="can.modify"
          ><el-button
            size="small"
            :loading="acting === 'open'"
            :disabled="!!acting && acting !== 'open'"
            @click="toggleOpen(true)"
            >{{ t('wxoa.mass.comments.open') }}</el-button
          ><el-button
            size="small"
            :loading="acting === 'close'"
            :disabled="!!acting && acting !== 'close'"
            @click="toggleOpen(false)"
            >{{ t('wxoa.mass.comments.close') }}</el-button
          ></template
        >
      </div>
      <el-skeleton v-if="loading" :rows="5" animated />
      <el-empty v-else-if="!comments.length" :description="t('wxoa.mass.comments.empty')" />
      <article v-for="c in comments" v-else :key="c.userCommentId" class="wxoa-comments__item">
        <div class="wxoa-comments__meta">
          <strong>{{ c.openId ?? '' }}</strong
          ><time>{{ c.createTime ?? '' }}</time>
        </div>
        <p>{{ c.content }}</p>
        <div class="wxoa-comments__actions">
          <el-button
            v-if="can.modify"
            link
            :loading="acting === `elect:${c.userCommentId}`"
            :disabled="!!acting && acting !== `elect:${c.userCommentId}`"
            @click="toggleElect(c)"
            >{{
              c.isElect ? t('wxoa.mass.comments.unselect') : t('wxoa.mass.comments.select')
            }}</el-button
          >
          <el-button
            v-if="can.remove"
            link
            type="danger"
            :loading="acting === `remove:${c.userCommentId}`"
            :disabled="!!acting && acting !== `remove:${c.userCommentId}`"
            @click="remove(c)"
            >{{ t('crud.action.delete') }}</el-button
          >
        </div>
        <div v-if="c.reply" class="wxoa-comments__reply">
          <span>{{ c.reply.content ?? '' }}</span
          ><el-button
            v-if="can.remove"
            link
            type="danger"
            :loading="acting === `removeReply:${c.userCommentId}`"
            :disabled="!!acting && acting !== `removeReply:${c.userCommentId}`"
            @click="removeReply(c)"
            >{{ t('wxoa.mass.comments.removeReply') }}</el-button
          >
        </div>
        <el-input
          v-if="can.send"
          v-model="replyText[c.userCommentId]"
          :placeholder="t('wxoa.mass.comments.replyPlaceholder')"
          @keyup.enter="reply(c)"
          ><template #append
            ><el-button
              :loading="acting === `reply:${c.userCommentId}`"
              :disabled="!!acting && acting !== `reply:${c.userCommentId}`"
              @click="reply(c)"
              >{{ t('wxoa.mass.comments.reply') }}</el-button
            ></template
          ></el-input
        >
      </article>
      <Pagination
        v-model:page="page"
        :page-size="WXOA_COMMENT_PAGE_MAX"
        :total="total"
        @change="load"
      />
    </div>
  </el-drawer>
</template>

<style scoped>
.wxoa-comments {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.wxoa-comments__filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  color: var(--qw-text-2);
}
.wxoa-comments__item {
  padding: 12px 0;
  border-bottom: 1px solid var(--qw-border);
}
.wxoa-comments__meta {
  display: flex;
  justify-content: space-between;
  color: var(--qw-text-2);
}
.wxoa-comments__item p {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.wxoa-comments__actions {
  display: flex;
  gap: 4px;
}
.wxoa-comments__reply {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  justify-content: space-between;
  padding: 8px;
  margin: 8px 0;
  color: var(--qw-text-2);
  background: var(--qw-surface-2);
  border-radius: var(--qw-radius-sm);
}
</style>
