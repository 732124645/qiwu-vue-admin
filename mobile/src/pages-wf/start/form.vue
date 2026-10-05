<template>
  <view class="qw-detail qw-stack">
    <view v-if="form" class="qw-card qw-form qw-start-form">
      <QwProcessForm v-model="values" :form="form" :errors="errors" />
      <view v-for="p in picks" :key="p.id" class="qw-decide__user qw-start__pick">
        <QwUserPicker
          v-model="picked[p.id]"
          multiple
          :label="`${tx(p.name)} · ${t(`approval.start.pick.${p.type}`)}`"
          required
        />
        <text v-if="pickErrors[p.id]" class="qw-field__error">{{ pickErrors[p.id] }}</text>
      </view>
      <text v-if="error" class="qw-form__error" role="alert">{{ error }}</text>
      <wd-button
        custom-class="qw-btn qw-btn--primary qw-start-form__submit"
        type="primary"
        block
        :loading="submitting"
        :disabled="submitting"
        @click="submit"
      >
        {{ t('approval.start.submit') }}
      </wd-button>
    </view>
    <QwEmpty v-else-if="!loading" :title="error || t('approval.dynamic.badForm')" />
  </view>
</template>

<script setup lang="ts">
import { computed, reactive, ref, shallowRef, watch } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { applyFormCalc, fieldsFromFormSchema, type FormSchema, type WfStartInfoVo } from '@qiwu/shared'
import { loadStartInfo, picksMissing, startModel, type Picked } from '@/core/approvals'
import QwEmpty from '@/core/components/QwEmpty.vue'
import QwUserPicker from '@/core/components/QwUserPicker.vue'
import { t, tx } from '@/core/i18n'
import { ApiError, errorText } from '@/core/request'
import QwProcessForm from '../form/QwProcessForm.vue'
import {
  checkValues,
  defaultValues,
  formDicts,
  formText,
  formTitles,
  processForm,
} from '../form/process-form'

/**
 * 发起 a dynamic model with a form (subpackage pages-wf; a page, the start page's sheet keeps the
 * models without one): `?key=<model>&name=<its name>`. Its form (start-info's schema through processForm,
 * the rules' defaults filled in; one failing the whitelist: 请在电脑端发起) and the users of its
 * initiatorPicks steps; the submit checks both as the server will (nothing is posted until they pass), posts
 * the values with the calc results (the server recomputes them) and opens the started instance. A 400's
 * `formValues.<field>` messages show at their fields. The button shows loading and is disabled while
 * pending.
 */
const key = ref('')
const loading = ref(true)
const form = shallowRef<FormSchema | null>(null)
const values = ref<Record<string, unknown>>({})
const picks = shallowRef<WfStartInfoVo['picks']>([])
const picked = reactive<Picked>({})
const error = ref('')
const submitting = ref(false)
const tried = ref(false)
const errors = shallowRef<Record<string, string>>({})
const pickErrors = computed(() => (tried.value ? picksMissing(picks.value, picked) : {}))
let dicts: Awaited<ReturnType<typeof formDicts>> = new Map()

const decode = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

onLoad(async (query) => {
  key.value = decode(String(query?.key ?? ''))
  uni.setNavigationBarTitle({ title: tx(decode(String(query?.name ?? ''))) })
  try {
    const info = await loadStartInfo(key.value)
    form.value = processForm(info.schema)
    if (form.value) values.value = defaultValues(form.value)
    for (const p of info.picks) picked[p.id] = []
    picks.value = info.picks
  } catch (e) {
    error.value = errorText(e)
  } finally {
    loading.value = false
  }
})

/** the values to post: the calc results as the server will store them */
const sent = () => applyFormCalc(form.value!, values.value)
function check() {
  const f = form.value!
  const r = fieldsFromFormSchema(f)
  errors.value = checkValues(r.ok ? r.fields : {}, f, sent(), dicts, formTitles(f, formText(f)))
}
// once shown, the messages follow the input
watch(values, () => {
  if (Object.keys(errors.value).length) check()
})

async function submit() {
  if (submitting.value || !form.value) return
  submitting.value = true
  tried.value = true
  error.value = ''
  try {
    dicts = await formDicts(form.value)
    check()
    if (Object.keys(errors.value).length || Object.keys(pickErrors.value).length) return
    const started = await startModel(key.value, picked, sent())
    uni.showToast({ title: t('approval.start.started'), icon: 'none' })
    uni.redirectTo({ url: `/pages-wf/detail/index?id=${started.id}` })
  } catch (e) {
    // a 400 (the values; a picked user disabled meanwhile) or 404 (the model is gone) belongs here
    if (!(e instanceof ApiError && (e.status === 400 || e.status === 404))) return
    const at: Record<string, string> = {}
    for (const x of e.errors ?? [])
      if (x.path.startsWith('formValues.')) at[x.path.slice('formValues.'.length)] ??= x.msg
    errors.value = at
    if (!Object.keys(at).length) error.value = e.message
  } finally {
    submitting.value = false
  }
}
</script>
