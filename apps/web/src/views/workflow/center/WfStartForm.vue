<script setup lang="ts">
import { reactive, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FormSchema, WfStartInfoVo, WfStartVo } from '@qiwu/shared'
import { wfCenterApi } from '@/api/workflow/center'
import { toastRest } from '@/core/composables/use-crud'
import { formLocale, tx } from '@/core/i18n'
import WfUserIds from '../designer/WfUserIds.vue'
import { installFormCreate } from '@/views/platform/formkit/widgets'
import { FormCreate, processForm, type ProcessFormApi } from './process-form'

/**
 * Starts a dynamic-form model (发起; see docs/design-notes.md#workflow), a dialog content component:
 * `await openDialog<WfStartVo>(WfStartForm, { modelKey }, { title })`. The model's form (its current version's,
 * GET start-info) renders through form-create once `sanitizeFormSchema` passed it again, its own checks
 * run before starting; attachments go up as private `wf.attachment` objects (qw-upload), bound to the instance
 * on start. The steps whose users the initiator picks (`initiatorPicks`) each take users from UserPicker
 * (every enabled user), every one at least one; with neither it only confirms. Resolves with the started
 * instance.
 */
defineOptions({ name: 'WfStartForm' })
// the Element Plus components form-create renders by name (el-form, el-input, …) on this app
installFormCreate()
const { modelKey } = defineProps<{ modelKey: string }>()
const emit = defineEmits<{ done: [started: WfStartVo]; cancel: [] }>()
const { t } = useI18n()

type PickStep = WfStartInfoVo['picks'][number]
const picks = shallowRef<PickStep[]>([])
/** step id → the picked user ids */
const picked = reactive<Record<string, number[]>>({})
/** the form as rendered; `broken`: one the sanitizer refuses (nothing to start with) */
const form = shallowRef<FormSchema | null>(null)
const broken = ref(false)
const values = ref<Record<string, unknown>>({})
const formApi = shallowRef<ProcessFormApi>()
const loading = ref(true)
wfCenterApi
  .startInfo(modelKey)
  .then((info) => {
    for (const p of info.picks) picked[p.id] = []
    picks.value = info.picks
    form.value = info.schema && processForm(info.schema)
    broken.value = !!info.schema && !form.value
  })
  .catch((e: unknown) => {
    toastRest(e)
    emit('cancel')
  })
  .finally(() => (loading.value = false))

/** a step's "pick someone" error, once a start was tried */
const tried = ref(false)
const errorOf = (p: PickStep) =>
  tried.value && !picked[p.id]?.length ? t('validation.wf.picks_missing', { node: tx(p.name) }) : ''

const submitting = ref(false)
async function submit() {
  tried.value = true
  const filled = await (formApi.value?.validate().then(
    () => true,
    () => false,
  ) ?? true)
  if (!filled || picks.value.some((p) => errorOf(p))) return
  submitting.value = true
  try {
    emit(
      'done',
      await wfCenterApi.start({
        modelKey,
        formValues: { ...values.value },
        initiatorPicks: { ...picked },
      }),
    )
  } catch (e) {
    toastRest(e) // 400: a value or a file the server refuses, a picked user disabled meanwhile; 404: the model is gone
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div v-loading="loading" class="wf-start-form">
    <p v-if="broken" class="wf-start-form__broken" role="alert">
      {{ t('wf.center.start.badForm') }}
    </p>
    <component
      :is="FormCreate"
      v-if="form"
      v-model="values"
      v-model:api="formApi"
      class="wf-start-form__form"
      :rule="form.rule"
      :option="form.option"
      :locale="formLocale"
    />
    <el-form v-if="picks.length" label-position="left" @submit.prevent>
      <p class="wf-start-form__hint">{{ t('wf.center.start.picksHint') }}</p>
      <el-form-item v-for="p in picks" :key="p.id" :error="errorOf(p)">
        <template #label>
          {{ tx(p.name) }}
          <span class="wf-start-form__kind">{{ t(`wf.designer.type.${p.type}`) }}</span>
        </template>
        <WfUserIds v-model="picked[p.id]!" source="wf" />
      </el-form-item>
    </el-form>
    <p v-else-if="!loading && !form && !broken" class="wf-start-form__hint">
      {{ t('wf.center.start.confirm') }}
    </p>
  </div>
  <div class="qw-dialog-footer">
    <el-button @click="emit('cancel')">{{ t('common.action.cancel') }}</el-button>
    <el-button type="primary" :loading="submitting" :disabled="loading || broken" @click="submit">
      {{ t('wf.center.start.submit') }}
    </el-button>
  </div>
</template>

<style scoped>
.wf-start-form {
  min-height: 48px;
}
.wf-start-form__hint {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 20px;
  color: var(--qw-text-2);
}
.wf-start-form__broken {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 20px;
  color: var(--qw-danger);
}
.wf-start-form__form {
  margin-bottom: 8px;
}
.wf-start-form__kind {
  margin-left: 6px;
  font-size: 12px;
  color: var(--qw-text-3);
}
</style>
