<script setup lang="ts">
import { computed, reactive, ref, shallowRef, toRaw } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, type FormInstance, type FormItemRule } from 'element-plus'
import {
  validationMessage,
  WXOA_ARTICLE_MAX,
  WXOA_CONTENT_MAX,
  wxoaDraftCreate,
  wxoaPerms,
  type WxoaDraftArticle,
  type WxoaMaterialVo,
} from '@qiwu/shared'
import { wxoaDraftApi, type WxoaDraftVo } from '@/api/platform/wxoa/draft'
import RichEditor from '@/core/components/RichEditor.vue'
import HtmlFrame from '@/core/components/HtmlFrame.vue'
import { openDialog } from '@/core/dialog'
import { toastRest } from '@/core/composables/use-crud'
import { usePerm } from '@/core/permission'
import MaterialPicker from '../components/MaterialPicker.vue'
import WxoaMediaImage from '../components/WxoaMediaImage.vue'

/**
 * 图文草稿编辑器（对话框内容）：1–8 篇文章，每篇标题、作者、摘要、原文链接、封面（本账号永久图片素材）与正文。
 * 保存只存本地；“同步到微信”先保存再推到草稿箱。新建后同步失败时保留已建的草稿 id，重试不会再建一份。
 */
defineOptions({ name: 'WxoaDraftForm' })
const { accountId, draft = null } = defineProps<{ accountId: number; draft?: WxoaDraftVo | null }>()
const emit = defineEmits<{ done: [draft: WxoaDraftVo]; cancel: [] }>()
const { t } = useI18n()
const perm = usePerm()

const model = reactive<{ articles: WxoaDraftArticle[] }>({
  // 表格行是 Vue 响应式代理，先取原对象再克隆，避免二次打开编辑器触发 DataCloneError。
  articles: draft?.articles?.length ? structuredClone(toRaw(draft.articles)) : [emptyArticle()],
})
/** 服务端最近一次返回的草稿；新建成功后即有 id，之后的保存与同步都针对它 */
const current = shallowRef<WxoaDraftVo | null>(draft)
const snapshot = () => JSON.stringify(model.articles)
/** 最近一次保存（或打开）时的内容，用来判断“打开后又改过” */
let saved = snapshot()
const changed = () => snapshot() !== saved

const can = computed(() => ({
  save: perm.has(current.value ? wxoaPerms.draft.modify : wxoaPerms.draft.create),
  sync: perm.has(wxoaPerms.draft.sync),
}))
const active = ref(0)
const preview = ref(false)
const saving = ref(false)
const syncing = ref(false)
const busy = () => saving.value || syncing.value
const unsyncedImages = ref<Array<{ src: string; reason: string }>>([])
/** 已同步过的草稿：服务端标记有未同步修改，或本次打开后又改过，就提示先同步 */
const hasUnsyncedChange = computed(
  () => current.value?.mediaId != null && (current.value.dirty || changed()),
)
/** 本次选过的封面素材，用来显示缩略图（素材列表不能按 media_id 查，打开时已有的封面只显示 id） */
const covers = ref<Record<string, WxoaMaterialVo>>({})

function emptyArticle(): WxoaDraftArticle {
  return {
    title: '',
    author: '',
    digest: '',
    content: '',
    contentSourceUrl: '',
    thumbMediaId: '',
    needOpenComment: true,
    onlyFansCanComment: false,
  }
}
/** 与共享校验一致按字符串长度计，服务端清洗后再按同一上限复核 */
const count = (s: string) => s.length
/** 预览不带 Referer，远程图片才不会因防盗链显示失败，也不把后台地址泄露给图片主机 */
const previewHtml = (article: WxoaDraftArticle) =>
  `<meta name="referrer" content="no-referrer">${article.content}`

/** 在微信允许的篇数内追加一篇文章，并把编辑器切到新文章。 */
function addArticle() {
  if (model.articles.length >= WXOA_ARTICLE_MAX) return
  model.articles.push(emptyArticle())
  active.value = model.articles.length - 1
}
/** 删除一篇（至少保留一篇）。 */
function removeArticle(index: number) {
  if (model.articles.length <= 1) return
  model.articles.splice(index, 1)
  active.value = Math.min(active.value, model.articles.length - 1)
}
/** 调整文章顺序；首篇标题即草稿标题。 */
function move(index: number, delta: number) {
  const next = index + delta
  if (next < 0 || next >= model.articles.length) return
  const [row] = model.articles.splice(index, 1)
  model.articles.splice(next, 0, row!)
  active.value = next
}
/** 从本账号的永久图片素材里选封面。 */
async function chooseCover(article: WxoaDraftArticle) {
  const selected = await openDialog<WxoaMaterialVo>(
    MaterialPicker,
    { accountId, mediaKind: 'thumb' },
    { title: () => t('wxoa.draft.coverPicker') },
  )
  if (!selected) return
  covers.value[selected.mediaId] = selected
  article.thumbMediaId = selected.mediaId
}

// 表单项的校验都走共享的 wxoaDraftCreate：每项只显示整份草稿在自己路径上的问题
const formRef = ref<FormInstance>()
const LABELS: Record<string, string> = {
  title: 'wxoa.draft.articleTitle',
  author: 'wxoa.draft.author',
  digest: 'wxoa.draft.digest',
  content: 'wxoa.draft.content',
  contentSourceUrl: 'wxoa.draft.sourceUrl',
  thumbMediaId: 'wxoa.draft.cover',
}
const rule: FormItemRule = {
  trigger: 'blur',
  validator: (r, _value, callback) => {
    const issue = wxoaDraftCreate
      .safeParse({ accountId, articles: model.articles })
      .error?.issues.find((i) => i.path.join('.') === r.field)
    if (!issue) return callback()
    const { key, params } = validationMessage(issue)
    const prop = String(issue.path.at(-1))
    callback(new Error(t(key, { ...params, field: LABELS[prop] ? t(LABELS[prop]) : prop })))
  },
}
const propOf = (i: number, field: keyof WxoaDraftArticle) => `articles.${i}.${field}`

/** 校验全部文章；不通过时切到第一篇有错的文章。 */
async function validate() {
  const result = await formRef.value?.validate().catch((fields: Record<string, unknown>) => fields)
  if (result === true) return true
  const first = Object.keys(result ?? {})
    .map((prop) => Number(prop.split('.')[1]))
    .filter(Number.isInteger)
    .sort((a, b) => a - b)[0]
  if (first != null) active.value = first
  return false
}
/** 写入本地：还没有 id 时新建，否则只在内容改过时更新；返回服务端的草稿。 */
async function persist(): Promise<WxoaDraftVo> {
  const row = current.value
  const next = !row
    ? await wxoaDraftApi.create({ accountId, articles: model.articles })
    : changed()
      ? await wxoaDraftApi.update(row.id, { articles: model.articles })
      : row
  current.value = next
  saved = snapshot()
  return next
}
async function save() {
  if (busy() || !(await validate())) return
  saving.value = true
  try {
    emit('done', await persist())
  } catch (e) {
    toastRest(e)
  } finally {
    saving.value = false
  }
}
/** 先保存再推到草稿箱；推送失败时已建的草稿留在 `current`，再点只会重试同步。 */
async function sync() {
  if (busy() || !(await validate())) return
  syncing.value = true
  try {
    const row = await persist()
    const result = await wxoaDraftApi.sync(row.id)
    current.value = result.draft
    unsyncedImages.value = result.unsyncedImages
    ElMessage.success(t('wxoa.draft.sync.done'))
    if (!result.unsyncedImages.length) emit('done', result.draft)
  } catch (e) {
    toastRest(e)
  } finally {
    syncing.value = false
  }
}
/** 关闭时若已新建过草稿，按完成返回，列表才会刷新出它。 */
function close() {
  if (current.value && current.value.id !== draft?.id) emit('done', current.value)
  else emit('cancel')
}
</script>

<template>
  <div class="wxoa-draft-form">
    <el-alert
      v-if="draft?.origin === 'pulled'"
      type="warning"
      :closable="false"
      show-icon
      :title="t('wxoa.draft.pulledLayout')"
      class="wxoa-draft-form__alert"
    />
    <div class="wxoa-draft-form__toolbar">
      <el-button
        v-if="model.articles.length < WXOA_ARTICLE_MAX"
        type="primary"
        plain
        @click="addArticle"
      >
        {{ t('wxoa.draft.addArticle') }}
      </el-button>
    </div>
    <el-form ref="formRef" :model="model" label-position="top" @submit.prevent="save">
      <el-tabs v-model="active" type="card" class="wxoa-draft-form__tabs">
        <el-tab-pane v-for="(article, i) in model.articles" :key="i" :name="i">
          <template #label>{{ i + 1 }}. {{ article.title || t('wxoa.draft.untitled') }}</template>
          <div class="wxoa-draft-form__article-actions">
            <el-button link :disabled="i === 0" @click="move(i, -1)">{{
              t('wxoa.draft.moveUp')
            }}</el-button>
            <el-button link :disabled="i === model.articles.length - 1" @click="move(i, 1)">{{
              t('wxoa.draft.moveDown')
            }}</el-button>
            <el-button
              link
              type="danger"
              :disabled="model.articles.length <= 1"
              @click="removeArticle(i)"
              >{{ t('wxoa.draft.removeArticle') }}</el-button
            >
          </div>
          <el-form-item
            :label="t('wxoa.draft.articleTitle')"
            :prop="propOf(i, 'title')"
            :rules="rule"
            required
          >
            <el-input v-model="article.title" maxlength="64" />
          </el-form-item>
          <el-row :gutter="12">
            <el-col :span="12"
              ><el-form-item
                :label="t('wxoa.draft.author')"
                :prop="propOf(i, 'author')"
                :rules="rule"
                ><el-input v-model="article.author" maxlength="64" /></el-form-item
            ></el-col>
            <el-col :span="12"
              ><el-form-item
                :label="t('wxoa.draft.sourceUrl')"
                :prop="propOf(i, 'contentSourceUrl')"
                :rules="rule"
                ><el-input
                  v-model="article.contentSourceUrl"
                  placeholder="https://" /></el-form-item
            ></el-col>
          </el-row>
          <el-form-item :label="t('wxoa.draft.digest')" :prop="propOf(i, 'digest')" :rules="rule"
            ><el-input
              v-model="article.digest"
              type="textarea"
              :rows="2"
              maxlength="120"
              show-word-limit
          /></el-form-item>
          <el-form-item
            :label="t('wxoa.draft.cover')"
            :prop="propOf(i, 'thumbMediaId')"
            :rules="rule"
            required
          >
            <div class="wxoa-draft-form__cover">
              <WxoaMediaImage
                v-if="covers[article.thumbMediaId]"
                :object-id="covers[article.thumbMediaId]!.objectId"
                :url="covers[article.thumbMediaId]!.wxUrl"
                :alt="t('wxoa.draft.cover')"
                preview
              />
              <el-tag v-if="article.thumbMediaId" closable @close="article.thumbMediaId = ''">{{
                article.thumbMediaId
              }}</el-tag>
              <el-button type="primary" plain @click="chooseCover(article)">{{
                t('wxoa.draft.chooseCover')
              }}</el-button>
            </div>
          </el-form-item>
          <el-form-item :label="t('wxoa.draft.content')" :prop="propOf(i, 'content')" :rules="rule">
            <RichEditor
              v-model="article.content"
              :height="320"
              :image-types="['image/jpeg', 'image/png']"
              :image-max-bytes="1024 * 1024"
            />
            <div
              class="wxoa-draft-form__counter"
              :class="{ 'is-over': count(article.content) > WXOA_CONTENT_MAX }"
            >
              {{ count(article.content) }}/{{ WXOA_CONTENT_MAX }}
            </div>
          </el-form-item>
          <el-space wrap>
            <el-checkbox v-model="article.needOpenComment">{{
              t('wxoa.draft.openComment')
            }}</el-checkbox>
            <el-checkbox v-model="article.onlyFansCanComment">{{
              t('wxoa.draft.fansCommentOnly')
            }}</el-checkbox>
          </el-space>
          <div v-if="preview" class="wxoa-draft-form__preview">
            <HtmlFrame :title="article.title" :html="previewHtml(article)" :height="300" />
          </div>
        </el-tab-pane>
      </el-tabs>
    </el-form>
    <el-alert
      v-if="hasUnsyncedChange"
      type="warning"
      :closable="false"
      show-icon
      :title="t('wxoa.draft.unsynced')"
      class="wxoa-draft-form__alert"
    />
    <el-alert
      v-if="unsyncedImages.length"
      type="warning"
      :closable="false"
      show-icon
      :title="t('wxoa.draft.unsyncedImages')"
      class="wxoa-draft-form__alert"
    >
      <ul>
        <li v-for="item in unsyncedImages" :key="item.src">{{ item.src }} — {{ item.reason }}</li>
      </ul>
    </el-alert>
    <div class="qw-dialog-footer">
      <el-button @click="close">{{ t('common.action.cancel') }}</el-button>
      <el-button @click="preview = !preview">{{
        preview ? t('wxoa.draft.hidePreview') : t('wxoa.draft.preview')
      }}</el-button>
      <el-button
        v-if="can.sync && can.save"
        :loading="syncing"
        :disabled="saving"
        type="primary"
        plain
        @click="sync"
        >{{ t('wxoa.draft.sync.action') }}</el-button
      >
      <el-button
        v-if="can.save"
        :loading="saving"
        :disabled="syncing"
        type="primary"
        @click="save"
        >{{ t('crud.action.save') }}</el-button
      >
    </div>
  </div>
</template>

<style scoped>
.wxoa-draft-form__article-actions {
  display: flex;
  justify-content: flex-end;
  gap: 4px;
  margin-bottom: 8px;
}
.wxoa-draft-form__toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}
.wxoa-draft-form__alert {
  margin-top: 8px;
}
.wxoa-draft-form__cover {
  display: flex;
  gap: 8px;
  align-items: center;
}
.wxoa-draft-form__counter {
  margin-top: 4px;
  color: var(--qw-text-3);
  font-size: 12px;
  text-align: right;
  width: 100%;
}
.wxoa-draft-form__counter.is-over {
  color: var(--qw-danger);
}
.wxoa-draft-form__preview {
  margin-top: 12px;
}
</style>
