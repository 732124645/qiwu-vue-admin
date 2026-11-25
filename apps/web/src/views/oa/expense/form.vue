<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { expenseCreate, SUB_ROWS_MAX, type ExpenseCreate } from '@qiwu/shared'
import { expenseApi } from '@/api/oa/expense'
import DictSelect from '@/core/components/DictSelect.vue'
import { useCrudForm } from '@/core/composables/use-crud'
import OaInitiatorPicks from '../components/OaInitiatorPicks.vue'
import OaAttachments from '../components/OaAttachments.vue'
import { expenseTotal } from '../components/money'

defineOptions({ name: 'OaExpenseForm' })
const { id } = defineProps<{ id?: number }>()
const emit = defineEmits<{ done: [value: { id: number }]; cancel: [] }>()
const { t } = useI18n()
const picks = ref<InstanceType<typeof OaInitiatorPicks>>()
const startReady = ref(false)
const attachmentBusy = ref(false)
const itemAttachmentBusy = ref<Record<number, boolean>>({})
const uploadsBusy = computed(
  () => attachmentBusy.value || Object.values(itemAttachmentBusy.value).some(Boolean),
)
const attachmentCount = computed(
  () =>
    new Set([
      ...(model.attachmentIds ?? []),
      ...model.items.flatMap((item) => item.attachmentIds ?? []),
    ]).size,
)
const newItem = () => ({
  expenseDate: '',
  expenseKind: '',
  amount: '',
  description: '',
  attachmentIds: [] as number[],
})
const formApi = {
  ...expenseApi,
  // 明细返回值含归属与排序字段，表单只装入允许写入的列，不能原样回传整行。
  get: async (key: number) => {
    const row = await expenseApi.get(key)
    return {
      ...row,
      items: row.items.map(
        ({ id, expenseDate, expenseKind, amount, description, attachmentIds }) => ({
          id,
          expenseDate,
          expenseKind,
          amount,
          description,
          attachmentIds,
        }),
      ),
    }
  },
}
const {
  model,
  formRef,
  rules,
  loading,
  submitting,
  submit: save,
} = useCrudForm({
  api: formApi,
  schema: expenseCreate,
  id,
  emit,
  emptyModel: (): ExpenseCreate => ({
    reason: '',
    tripId: null,
    attachmentIds: [],
    items: [newItem()],
    initiatorPicks: {},
  }),
})
const total = computed(() => expenseTotal(model.items.map((item) => item.amount)))
/** 金额预览不进入写入体，服务端始终重新汇总有效明细。 */
async function submit() {
  if (uploadsBusy.value || attachmentCount.value > 10 || submitting.value) return
  if (!id && !picks.value?.validate()) return
  await save()
}
defineExpose({ model, total })
</script>
<template>
  <el-form ref="formRef" v-loading="loading" :model="model" :rules="rules" label-position="left">
    <el-form-item :label="t('field.oa.expense.reason')" prop="reason"
      ><el-input v-model="model.reason" type="textarea" :rows="3" maxlength="500"
    /></el-form-item>
    <el-form-item :label="t('field.oa.expense.tripId')" prop="tripId"
      ><el-input-number
        v-model="model.tripId"
        :min="1"
        :precision="0"
        :controls="false"
        @change="model.tripId = $event ?? null"
        clearable
      /><span class="oa-expense__hint">{{ t('oa.expense.tripHint') }}</span></el-form-item
    >
    <el-form-item :label="t('field.oa.expense.items')" prop="items">
      <div class="oa-expense__items">
        <div
          v-for="(item, index) in model.items"
          :key="item.id ?? `new-${index}`"
          class="oa-expense__item"
        >
          <el-form-item
            :label="t('field.oa.expense.expenseDate')"
            :prop="`items.${index}.expenseDate`"
            ><el-date-picker v-model="item.expenseDate" type="date" value-format="YYYY-MM-DD"
          /></el-form-item>
          <el-form-item
            :label="t('field.oa.expense.expenseKind')"
            :prop="`items.${index}.expenseKind`"
            ><DictSelect v-model="item.expenseKind" code="oa.expense_kind"
          /></el-form-item>
          <el-form-item :label="t('field.oa.expense.amount')" :prop="`items.${index}.amount`"
            ><el-input v-model="item.amount" inputmode="decimal"
          /></el-form-item>
          <el-form-item
            :label="t('field.oa.expense.description')"
            :prop="`items.${index}.description`"
            ><el-input v-model="item.description" maxlength="200"
          /></el-form-item>
          <el-form-item
            :label="t('field.oa.expense.attachmentIds')"
            :prop="`items.${index}.attachmentIds`"
          >
            <OaAttachments
              v-model="item.attachmentIds"
              :disabled="submitting"
              @busy="itemAttachmentBusy[index] = $event"
            />
          </el-form-item>
          <el-button
            type="danger"
            plain
            :disabled="submitting || uploadsBusy || model.items.length <= 1"
            @click="model.items.splice(index, 1)"
            >{{ t('oa.expense.removeItem') }}</el-button
          >
        </div>
        <el-button
          :disabled="submitting || uploadsBusy || model.items.length >= SUB_ROWS_MAX"
          @click="model.items.push(newItem())"
          >{{ t('oa.expense.addItem') }}</el-button
        >
      </div>
    </el-form-item>
    <el-form-item :label="t('oa.expense.total')"
      ><output>{{ total ?? t('oa.amountInvalid') }}</output></el-form-item
    >
    <el-alert
      v-if="attachmentCount > 10"
      :title="t('oa.attachmentLimit')"
      type="error"
      :closable="false"
    />
    <el-form-item :label="t('field.oa.expense.attachmentIds')" prop="attachmentIds">
      <OaAttachments
        v-model="model.attachmentIds"
        :disabled="submitting"
        @busy="attachmentBusy = $event"
      />
    </el-form-item>
    <OaInitiatorPicks
      v-if="!id"
      ref="picks"
      v-model="model.initiatorPicks"
      model-key="oa-expense"
      @ready="startReady = $event"
    />
  </el-form>
  <div class="qw-dialog-footer">
    <el-button @click="emit('cancel')">{{ t('common.action.cancel') }}</el-button
    ><el-button
      type="primary"
      :loading="submitting"
      :disabled="
        submitting || loading || uploadsBusy || attachmentCount > 10 || (!id && !startReady)
      "
      @click="submit"
      >{{ t(id ? 'crud.action.save' : 'oa.create') }}</el-button
    >
  </div>
</template>
<style scoped>
.oa-expense__items {
  display: grid;
  gap: 16px;
  width: 100%;
}
.oa-expense__item {
  display: grid;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius);
}
.oa-expense__hint {
  margin-left: 12px;
  color: var(--qw-text-3);
  font-size: 12px;
}
</style>
