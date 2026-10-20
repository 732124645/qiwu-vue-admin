<script setup lang="ts">
import { computed, reactive, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FormInstance, FormItemRule } from 'element-plus'
import {
  fieldLabelKeys,
  validationMessage,
  WXOA_TEMPLATE_FANS_MAX,
  wxoaPerms,
  wxoaTemplateSendBody,
  wxoaTemplateValueMax,
  type WxoaFanVo,
  type WxoaTemplateSendBody,
  type WxoaTemplateVo,
} from '@qiwu/shared'
import { wxoaFanApi } from '@/api/platform/wxoa/fan'
import { wxoaTemplateApi } from '@/api/platform/wxoa/template'
import { toastRest } from '@/core/composables/use-crud'
import { usePerm } from '@/core/permission'
import { wxoaTemplateFields } from './template-fields'

/**
 * Sends `template` of account `accountId` to at most 100 followed fans of it: one field per data key of
 * the template's text, each within the length WeChat takes for its key (the shared schema's check), and
 * an optional link. `done(count)` once the server queued the messages (it sends them after answering).
 * Picking fans searches the fan list, so it needs `wxoa.fan.browse` as well.
 */
defineOptions({ name: 'WxoaTemplateSend' })
const { accountId, template } = defineProps<{ accountId: number; template: WxoaTemplateVo }>()
const emit = defineEmits<{ done: [count: number]; cancel: [] }>()
const { t, te } = useI18n()
const perm = usePerm()

const fields = wxoaTemplateFields(template.content)
const model = reactive({
  fanIds: [] as number[],
  data: Object.fromEntries(fields.map((f) => [f.key, ''])) as Record<string, string>,
  url: '',
})
const payload = (): WxoaTemplateSendBody => ({
  accountId,
  fanIds: model.fanIds,
  data: { ...model.data },
  url: model.url.trim() || null,
})

/** characters as WeChat counts them (code points) */
const length = (s: string) => [...s].length
const maxOf = (key: string) => wxoaTemplateValueMax(key, model.data[key])

const formRef = ref<FormInstance>()
const propOf = (path: readonly PropertyKey[]) =>
  path[0] === 'data' ? `data.${String(path[1] ?? '')}` : String(path[0] ?? '')
function labelOf(path: readonly PropertyKey[]) {
  if (path[0] === 'data') return fields.find((f) => f.key === path[1])?.label ?? String(path[1])
  const key = fieldLabelKeys('wxoa.template', path).find((k) => te(k))
  return key ? t(key) : ''
}
// each item shows the issue the whole message has at its path
const rules = Object.fromEntries(
  ['fanIds', 'url', ...fields.map((f) => `data.${f.key}`)].map((prop) => [
    prop,
    [
      {
        required: prop === 'fanIds',
        trigger: prop === 'fanIds' ? 'change' : 'blur',
        validator: (_rule, _value, callback) => {
          const issue = wxoaTemplateSendBody
            .safeParse(payload())
            .error?.issues.find((i) => propOf(i.path) === prop)
          if (!issue) return callback()
          const { key, params } = validationMessage(issue)
          callback(new Error(t(key, { ...params, field: labelOf(issue.path) })))
        },
      } satisfies FormItemRule,
    ],
  ]),
)

// fans: the account's followed fans, by remark, or by OpenID once the text looks like one
const canPickFans = perm.has(wxoaPerms.fan.browse)
const OPEN_ID = /^[\w-]{20,64}$/
const found = shallowRef<WxoaFanVo[]>([])
/** every fan seen here, so a chosen one keeps its name when a later search does not list it */
const known = new Map<number, WxoaFanVo>()
const searching = ref(false)
let seq = 0
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
async function submit() {
  if (submitting.value) return
  if (!(await formRef.value?.validate().catch(() => false))) return
  submitting.value = true
  try {
    const rows = await wxoaTemplateApi.send(template.templateId, payload())
    emit('done', rows.length)
  } catch (e) {
    toastRest(e)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-form ref="formRef" :model="model" :rules="rules" label-position="top">
    <el-form-item :label="t('wxoa.template.send.template')">
      <div class="wxoa-template-send__template">
        <strong>{{ template.title }}</strong>
        <p class="wxoa-template-send__content">{{ template.content }}</p>
      </div>
    </el-form-item>
    <el-form-item :label="t('field.wxoa.template.fanIds')" prop="fanIds">
      <el-select
        v-model="model.fanIds"
        multiple
        filterable
        remote
        :remote-method="searchFans"
        :loading="searching"
        :multiple-limit="WXOA_TEMPLATE_FANS_MAX"
        :disabled="!canPickFans"
        :placeholder="t('wxoa.template.send.fansPlaceholder')"
        :aria-label="t('field.wxoa.template.fanIds')"
      >
        <el-option v-for="f in fanOptions" :key="f.id" :value="f.id" :label="fanLabel(f)" />
      </el-select>
      <div class="wxoa-template-send__hint">
        {{
          canPickFans
            ? t('wxoa.template.send.fansLimit', {
                count: model.fanIds.length,
                max: WXOA_TEMPLATE_FANS_MAX,
              })
            : t('wxoa.template.send.needFanBrowse')
        }}
      </div>
    </el-form-item>
    <el-form-item
      v-for="f in fields"
      :key="f.key"
      :label="f.label"
      :prop="`data.${f.key}`"
      class="wxoa-template-send__field"
    >
      <el-input v-model="model.data[f.key]" :name="`data.${f.key}`">
        <template #suffix>
          <span class="wxoa-template-send__count">
            {{ length(model.data[f.key] ?? '') }}/{{ maxOf(f.key) }}
          </span>
        </template>
      </el-input>
    </el-form-item>
    <el-form-item v-if="!fields.length">
      <span class="wxoa-template-send__hint">{{ t('wxoa.template.send.noFields') }}</span>
    </el-form-item>
    <el-form-item :label="t('field.wxoa.template.url')" prop="url">
      <el-input v-model="model.url" name="url" placeholder="https://" />
    </el-form-item>
  </el-form>
  <div class="qw-dialog-footer">
    <el-button @click="emit('cancel')">{{ t('common.action.cancel') }}</el-button>
    <el-button type="primary" :loading="submitting" :disabled="!canPickFans" @click="submit">
      {{ t('wxoa.template.send.action') }}
    </el-button>
  </div>
</template>

<style scoped>
.wxoa-template-send__template {
  min-width: 0;
}
.wxoa-template-send__content {
  margin: 4px 0 0;
  line-height: 1.6;
  color: var(--qw-text-2);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.wxoa-template-send__hint {
  width: 100%;
  font-size: 12px;
  color: var(--qw-text-3);
}
.wxoa-template-send__count {
  font-size: 12px;
  color: var(--qw-text-3);
}
</style>
