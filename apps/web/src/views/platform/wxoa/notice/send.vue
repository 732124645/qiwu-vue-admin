<script setup lang="ts">
import { computed, reactive, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FormInstance, FormItemRule } from 'element-plus'
import {
  validationMessage,
  wxoaNoticeSend,
  wxoaPerms,
  type WxoaFanVo,
  type WxoaNoticeSend,
  type WxoaNoticeTemplateVo,
} from '@qiwu/shared'
import { wxoaFanApi } from '@/api/platform/wxoa/fan'
import { wxoaNoticeApi } from '@/api/platform/wxoa/notice'
import { toastRest } from '@/core/composables/use-crud'
import { usePerm } from '@/core/permission'
import { wxoaTemplateFields } from '../template/template-fields'

/**
 * 把订阅通知模板发给本账号的粉丝（一次最多 20 个，与共享校验一致）：按备注或 OpenID 远程搜索粉丝，
 * 模板里每个数据键一个必填项，可带跳转链接。服务端排队后 `done(数量)`；选粉丝需要粉丝浏览权限。
 */
defineOptions({ name: 'WxoaNoticeSend' })
const { accountId, template } = defineProps<{ accountId: number; template: WxoaNoticeTemplateVo }>()
const emit = defineEmits<{ done: [count: number]; cancel: [] }>()
const { t } = useI18n()
const perm = usePerm()
const FANS_MAX = 20

const fields = wxoaTemplateFields(template.content)
const model = reactive({
  fanIds: [] as number[],
  data: Object.fromEntries(fields.map((f) => [f.key, ''])) as Record<string, string>,
  url: '',
})
const payload = (): WxoaNoticeSend => ({
  accountId,
  fanIds: model.fanIds,
  data: { ...model.data },
  url: model.url.trim() || null,
})

// 每个表单项显示整条消息在自己路径上的问题；模板数据另要求非空（微信不接受空值）
const formRef = ref<FormInstance>()
const propOf = (path: readonly PropertyKey[]) =>
  path[0] === 'data' ? `data.${String(path[1] ?? '')}` : String(path[0] ?? '')
function labelOf(prop: string) {
  if (prop.startsWith('data.'))
    return fields.find((f) => `data.${f.key}` === prop)?.label ?? prop.slice(5)
  return prop === 'url' ? t('wxoa.notice.send.url') : t('wxoa.notice.send.fans')
}
const rules = Object.fromEntries(
  ['fanIds', 'url', ...fields.map((f) => `data.${f.key}`)].map((prop) => [
    prop,
    [
      {
        required: prop !== 'url',
        trigger: prop === 'fanIds' ? 'change' : 'blur',
        validator: (_rule, _value, callback) => {
          const field = labelOf(prop)
          if (prop.startsWith('data.') && !model.data[prop.slice(5)]?.trim())
            return callback(new Error(t('validation.required', { field })))
          const issue = wxoaNoticeSend
            .safeParse(payload())
            .error?.issues.find((i) => propOf(i.path) === prop)
          if (!issue) return callback()
          const { key, params } = validationMessage(issue)
          callback(new Error(t(key, { ...params, field })))
        },
      } satisfies FormItemRule,
    ],
  ]),
)

// 粉丝：本账号已关注的粉丝，按备注搜索，输入像 OpenID 时按 OpenID 搜索
const canPickFans = perm.has(wxoaPerms.fan.browse)
const OPEN_ID = /^[\w-]{20,64}$/
const found = shallowRef<WxoaFanVo[]>([])
/** 见过的粉丝，后来的搜索结果里没有时，已选的仍显示名字 */
const known = new Map<number, WxoaFanVo>()
const searching = ref(false)
let seq = 0
/** 远程搜索粉丝；只认最后一次搜索的结果。 */
async function searchFans(text = '') {
  const mine = ++seq
  const q = text.trim()
  searching.value = true
  try {
    const page = await wxoaFanApi.page({
      accountId,
      subscribed: true,
      pageSize: 50,
      sort: '-lastInboundAt',
      ...(q ? { [OPEN_ID.test(q) ? 'openId' : 'remark']: q } : {}),
    })
    if (mine !== seq) return
    for (const f of page.items) known.set(f.id, f)
    found.value = page.items
  } catch (e) {
    if (mine === seq) toastRest(e)
  } finally {
    if (mine === seq) searching.value = false
  }
}
const fanOptions = computed(() => {
  const listed = new Set(found.value.map((f) => f.id))
  const chosen = model.fanIds.flatMap((id) => (listed.has(id) ? [] : (known.get(id) ?? [])))
  return [...chosen, ...found.value]
})
const fanLabel = (f: WxoaFanVo) => (f.remark ? `${f.remark} (${f.openId})` : f.openId)
if (canPickFans) void searchFans()

const submitting = ref(false)
/** 校验通过后提交，服务端为每个粉丝建一条待发记录。 */
async function submit() {
  if (submitting.value) return
  if (!(await formRef.value?.validate().catch(() => false))) return
  submitting.value = true
  try {
    const rows = await wxoaNoticeApi.send(template.priTmplId, payload())
    emit('done', Array.isArray(rows) ? rows.length : model.fanIds.length)
  } catch (e) {
    toastRest(e)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-form ref="formRef" :model="model" :rules="rules" label-position="top">
    <el-form-item :label="t('wxoa.notice.send.template')">
      <div class="wxoa-notice-send__template">
        <strong>{{ template.title }}</strong>
        <p>{{ template.content }}</p>
      </div>
    </el-form-item>
    <el-form-item :label="t('wxoa.notice.send.fans')" prop="fanIds">
      <el-select
        v-model="model.fanIds"
        multiple
        filterable
        remote
        :remote-method="searchFans"
        :loading="searching"
        :multiple-limit="FANS_MAX"
        :disabled="!canPickFans"
        :placeholder="t('wxoa.notice.send.fansPlaceholder')"
        :aria-label="t('wxoa.notice.send.fans')"
      >
        <el-option v-for="f in fanOptions" :key="f.id" :value="f.id" :label="fanLabel(f)" />
      </el-select>
      <div class="wxoa-notice-send__hint">
        {{
          canPickFans
            ? t('wxoa.notice.send.fansLimit', { count: model.fanIds.length, max: FANS_MAX })
            : t('wxoa.notice.send.needFanBrowse')
        }}
      </div>
    </el-form-item>
    <el-form-item v-for="f in fields" :key="f.key" :label="f.label" :prop="`data.${f.key}`">
      <el-input v-model="model.data[f.key]" :name="`data.${f.key}`" />
    </el-form-item>
    <el-form-item :label="t('wxoa.notice.send.url')" prop="url">
      <el-input v-model="model.url" name="url" placeholder="https://" />
    </el-form-item>
  </el-form>
  <div class="qw-dialog-footer">
    <el-button @click="emit('cancel')">{{ t('common.action.cancel') }}</el-button
    ><el-button type="primary" :loading="submitting" :disabled="!canPickFans" @click="submit">{{
      t('wxoa.notice.send.action')
    }}</el-button>
  </div>
</template>

<style scoped>
.wxoa-notice-send__template p {
  margin: 6px 0 0;
  color: var(--qw-text-2);
  white-space: pre-wrap;
}
.wxoa-notice-send__hint {
  width: 100%;
  font-size: 12px;
  color: var(--qw-text-3);
}
</style>
