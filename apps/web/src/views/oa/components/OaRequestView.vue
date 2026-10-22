<script setup lang="ts">
import { computed, ref, shallowRef, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { ExpenseItemVo, WfInstanceDetailVo } from '@qiwu/shared'
import { wfCenterApi } from '@/api/workflow/center'
import DictTag from '@/core/components/DictTag.vue'
import { toastRest } from '@/core/composables/use-crud'
import { openDialog } from '@/core/dialog'
import { useAuthStore } from '@/core/stores/auth'
import WfTimeline from '@/views/workflow/center/WfTimeline.vue'
import { at } from '@/views/workflow/center/use-center-list'
import { officeWorkflowAvailable } from './access'
import OaAttachments from './OaAttachments.vue'
import { officeResources, type OfficeDocument, type OfficeResource } from './resources'

const props = defineProps<{
  kind: OfficeResource['kind']
  form: Component
  businessKey?: string
  readonly?: boolean
}>()
const resource = officeResources[props.kind]
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const row = shallowRef<OfficeDocument>()
const instance = shallowRef<WfInstanceDetailVo>()
const loading = ref(false)
const resubmitting = ref(false)
const id = Number(props.businessKey ?? route.params.id)
const begin = computed(() => instance.value?.myTasks.find((task) => task.type === 'begin'))
const canEdit = computed(() => {
  const current = row.value
  return (
    !!current &&
    officeWorkflowAvailable(auth.me) &&
    !props.readonly &&
    current.userId === auth.me?.user.id &&
    auth.hasPerm(resource.perms.modify) &&
    (current.state === 'draft' || !!begin.value)
  )
})
const items = computed(
  () => (row.value as OfficeDocument & { items?: ExpenseItemVo[] })?.items ?? [],
)
const valueOf = (key: string) => (row.value as unknown as Record<string, unknown>)?.[key]
const display = (key: string) => (valueOf(key) == null ? '—' : String(valueOf(key)))
/** 内嵌在流程详情时只加载业务单，避免再套一层流程详情与编辑动作。 */
async function load() {
  if (!officeWorkflowAvailable(auth.me)) return
  loading.value = true
  row.value = undefined
  instance.value = undefined
  try {
    row.value = await resource.api.get(id)
    if (!props.readonly && row.value.instanceId)
      instance.value = await wfCenterApi.detail(row.value.instanceId)
  } catch (e) {
    toastRest(e)
  } finally {
    loading.value = false
  }
}
async function edit() {
  if (!canEdit.value) return
  if (
    await openDialog(
      props.form,
      { id },
      { title: () => t('crud.title.edit', { name: t(`oa.${props.kind}.entity`) }) },
    )
  )
    await load()
}
async function resubmit() {
  if (!begin.value || resubmitting.value || !canEdit.value) return
  try {
    await ElMessageBox.confirm(t('oa.resubmitConfirm'), t('oa.resubmit'))
  } catch {
    return
  }
  resubmitting.value = true
  try {
    await wfCenterApi.resubmit(begin.value.id)
    ElMessage.success(t('oa.resubmitted'))
    await load()
  } catch (e) {
    toastRest(e)
  } finally {
    resubmitting.value = false
  }
}
void load()
</script>
<template>
  <div v-loading="loading" :class="readonly ? 'oa-document' : 'qw-page'">
    <div v-if="!readonly" class="qw-page-bar">
      <el-button @click="router.push(resource.path)">{{ t('oa.returnToList') }}</el-button
      ><el-button v-if="canEdit" @click="edit">{{ t('crud.action.edit') }}</el-button
      ><el-button
        v-if="canEdit && begin"
        type="primary"
        :loading="resubmitting"
        :disabled="resubmitting"
        @click="resubmit"
        >{{ t('oa.resubmit') }}</el-button
      >
    </div>
    <el-card v-if="row" :shadow="readonly ? 'never' : undefined"
      ><el-descriptions :title="t(`oa.${kind}.entity`)" :column="readonly ? 1 : 2" border
        ><template #extra><DictTag code="oa.request_state" :value="row.state" /></template
        ><el-descriptions-item
          v-for="field in resource.fields"
          :key="field.prop"
          :label="t(field.label)"
          ><DictTag
            v-if="field.kind === 'dict'"
            :code="field.dict!"
            :value="display(field.prop)"
          /><span v-else-if="field.kind === 'time'">{{ at(display(field.prop)) }}</span
          ><span v-else class="qw-detail__text">{{
            display(field.prop)
          }}</span></el-descriptions-item
        ></el-descriptions
      >
      <OaAttachments :model-value="row.attachmentIds ?? []" readonly />
      <el-table v-if="items.length" :data="items"
        ><el-table-column
          prop="expenseDate"
          :label="t('field.oa.expense.expenseDate')" /><el-table-column
          :label="t('field.oa.expense.expenseKind')"
          ><template #default="{ row: item }"
            ><DictTag
              code="oa.expense_kind"
              :value="item.expenseKind" /></template></el-table-column
        ><el-table-column :label="t('field.oa.expense.attachmentIds')">
          <template #default="{ row: item }"
            ><OaAttachments :model-value="item.attachmentIds ?? []" readonly
          /></template> </el-table-column
        ><el-table-column prop="amount" :label="t('field.oa.expense.amount')" /><el-table-column
          prop="description"
          :label="t('field.oa.expense.description')"
      /></el-table>
    </el-card>
    <el-card v-if="instance" class="oa-document__flow"
      ><template #header
        ><span>{{ t('oa.approvalPanel') }}</span
        ><el-button
          link
          type="primary"
          @click="router.push(`/workflow/instances/${instance.id}`)"
          >{{ t('oa.viewProcess') }}</el-button
        ></template
      ><WfTimeline :events="instance.timeline"
    /></el-card>
  </div>
</template>
<style scoped>
.oa-document {
  min-height: 160px;
}
.oa-document__flow {
  margin-top: 16px;
}
</style>
