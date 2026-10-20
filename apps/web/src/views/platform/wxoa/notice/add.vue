<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  wxoaNoticeApi,
  type WxoaNoticeCategory,
  type WxoaNoticeKeyword,
  type WxoaNoticeTitle,
} from '@/api/platform/wxoa/notice'
import { toastRest } from '@/core/composables/use-crud'

/**
 * 从公共模板库选用订阅通知模板：选类目 → 选模板标题（可加载更多）→ 勾选 2–5 个关键词并写
 * 15 字以内的服务场景，添加成功后 `done(priTmplId)`。打开即加载类目。
 */
defineOptions({ name: 'WxoaNoticeAdd' })
const { accountId } = defineProps<{ accountId: number }>()
const emit = defineEmits<{ done: [priTmplId: string]; cancel: [] }>()
const { t } = useI18n()
const KIDS = { min: 2, max: 5 }
const SCENE_MAX = 15
const categories = shallowRef<WxoaNoticeCategory[]>([])
const titles = shallowRef<WxoaNoticeTitle[]>([])
const titleTotal = ref(0)
const keywords = shallowRef<WxoaNoticeKeyword[]>([])
const categoryId = ref<string | null>(null)
const tid = ref('')
const kidList = ref<number[]>([])
const sceneDesc = ref('')
const loading = ref(false)
let seq = 0

/** 取一份模板库数据；只认最后一次请求的结果。 */
async function fetch<T>(run: () => Promise<T>, apply: (value: T) => void) {
  const mine = ++seq
  loading.value = true
  try {
    const value = await run()
    if (mine === seq) apply(value)
  } catch (e) {
    if (mine === seq) toastRest(e)
  } finally {
    if (mine === seq) loading.value = false
  }
}
void fetch(
  () => wxoaNoticeApi.categories(accountId),
  (v) => (categories.value = v),
)
/** 当前类目的下一页标题，接在已有的后面 */
function moreTitles() {
  const id = categoryId.value
  if (id == null) return
  void fetch(
    () => wxoaNoticeApi.titles(accountId, Number(id), titles.value.length),
    (v) => {
      titles.value = [...titles.value, ...v.titles]
      titleTotal.value = v.total
    },
  )
}
const ready = computed(
  () =>
    !!tid.value &&
    kidList.value.length >= KIDS.min &&
    kidList.value.length <= KIDS.max &&
    !!sceneDesc.value.trim(),
)
const adding = ref(false)
/** 把选中的公共模板与关键词加到本账号的模板里。 */
async function add() {
  if (!ready.value || adding.value) return
  adding.value = true
  try {
    const { priTmplId } = await wxoaNoticeApi.add({
      accountId,
      tid: tid.value,
      kidList: kidList.value,
      sceneDesc: sceneDesc.value.trim(),
    })
    emit('done', priTmplId)
  } catch (e) {
    toastRest(e)
  } finally {
    adding.value = false
  }
}
watch(categoryId, () => {
  titles.value = []
  titleTotal.value = 0
  tid.value = ''
  moreTitles()
})
watch(tid, (id) => {
  keywords.value = []
  kidList.value = []
  if (id)
    void fetch(
      () => wxoaNoticeApi.keywords(accountId, id),
      (v) => (keywords.value = v),
    )
})
</script>

<template>
  <el-form v-loading="loading" label-position="top">
    <el-form-item :label="t('wxoa.notice.add.category')">
      <el-select
        v-model="categoryId"
        filterable
        class="wxoa-notice-add__select"
        :aria-label="t('wxoa.notice.add.category')"
        ><el-option v-for="c in categories" :key="c.id" :value="c.id" :label="c.name"
      /></el-select>
    </el-form-item>
    <el-form-item :label="t('wxoa.notice.add.template')">
      <el-select
        v-model="tid"
        filterable
        :disabled="categoryId == null"
        class="wxoa-notice-add__select"
        :aria-label="t('wxoa.notice.add.template')"
        ><el-option v-for="item in titles" :key="item.tid" :value="item.tid" :label="item.title"
      /></el-select>
      <el-button
        v-if="titles.length < titleTotal"
        link
        type="primary"
        class="wxoa-notice-add__more"
        @click="moreTitles"
        >{{ t('wxoa.notice.add.more', { shown: titles.length, total: titleTotal }) }}</el-button
      >
    </el-form-item>
    <el-form-item
      v-if="tid"
      :label="t('wxoa.notice.add.keywords', { min: KIDS.min, max: KIDS.max })"
    >
      <el-checkbox-group v-model="kidList" :max="KIDS.max" class="wxoa-notice-add__keywords">
        <el-checkbox v-for="k in keywords" :key="k.kid" :value="k.kid"
          >{{ k.name }}<span class="wxoa-notice-add__example">{{ k.example }}</span></el-checkbox
        >
      </el-checkbox-group>
    </el-form-item>
    <el-form-item v-if="tid" :label="t('wxoa.notice.add.scene')">
      <el-input
        v-model="sceneDesc"
        :maxlength="SCENE_MAX"
        show-word-limit
        :placeholder="t('wxoa.notice.add.scenePlaceholder')"
      />
    </el-form-item>
  </el-form>
  <div class="qw-dialog-footer">
    <el-button @click="emit('cancel')">{{ t('common.action.cancel') }}</el-button
    ><el-button type="primary" :disabled="!ready" :loading="adding" @click="add">{{
      t('wxoa.notice.add.action')
    }}</el-button>
  </div>
</template>

<style scoped>
.wxoa-notice-add__select {
  width: 100%;
}
.wxoa-notice-add__more {
  margin-top: 4px;
}
.wxoa-notice-add__keywords {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}
.wxoa-notice-add__example {
  margin-left: 8px;
  font-size: 12px;
  color: var(--qw-text-3);
}
</style>
