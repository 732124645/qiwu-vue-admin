<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import dayjs from 'dayjs'
import { leavePerms, type LeaveVo, type WfInstanceDetailVo } from '@qiwu/shared'
import { leaveApi } from '@/api/biz/leave'
import { wfCenterApi } from '@/api/workflow/center'
import DictTag from '@/core/components/DictTag.vue'
import { toastRest } from '@/core/composables/use-crud'
import { openDialog } from '@/core/dialog'
import { Icon } from '@/core/icons'
import { useTagsStore } from '@/core/stores/tags'
import WfTimeline from '@/views/workflow/center/WfTimeline.vue'
import LeaveForm from './form.vue'

/**
 * One leave request (see docs/design-notes.md#workflow): the hidden page /biz/leave/:id and model leave's
 * `view_component`. As a page: the request, its approval panel (process state and timeline) and, while it is
 * sent back to its owner (they hold the process's `begin` task), edit and resubmit. The instance detail
 * embeds it with `{ businessKey, readonly: true }`: the request alone.
 */
defineOptions({ name: 'BizLeaveView' })
const props = defineProps<{ businessKey?: string; readonly?: boolean }>()
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const tags = useTagsStore()
const id = Number(props.businessKey ?? route.params.id)

const row = shallowRef<LeaveVo>()
const inst = shallowRef<WfInstanceDetailVo>()
const loading = ref(true)
const resubmitting = ref(false)
/** sent back to its owner: their pending task on the process's begin step */
const beginTask = computed(() => inst.value?.myTasks.find((task) => task.type === 'begin'))
const time = (iso: string) => dayjs(iso).format('YYYY-MM-DD HH:mm')

async function load() {
  loading.value = true
  try {
    row.value = await leaveApi.get(id)
    if (!props.readonly && row.value.instanceId)
      inst.value = await wfCenterApi.detail(row.value.instanceId)
  } catch (e) {
    toastRest(e)
  } finally {
    loading.value = false
  }
}
void load()

async function edit() {
  const saved = await openDialog(
    LeaveForm,
    { id },
    { title: () => t('crud.title.edit', { name: t('biz.leave.entity') }) },
  )
  if (saved) await load()
}

async function resubmit() {
  const task = beginTask.value
  if (!task || resubmitting.value) return
  try {
    await ElMessageBox.confirm(t('biz.leave.resubmitConfirm'), t('biz.leave.resubmit'), {
      type: 'info',
      confirmButtonText: t('biz.leave.resubmit'),
      cancelButtonText: t('common.action.cancel'),
    })
  } catch {
    return // declined
  }
  resubmitting.value = true
  try {
    await wfCenterApi.resubmit(task.id)
    ElMessage.success(t('biz.leave.resubmitted'))
    await load()
  } catch (e) {
    toastRest(e)
  } finally {
    resubmitting.value = false
  }
}

function back() {
  tags.close((tag) => tag.path === route.path)
  return router.push('/biz/leave')
}
</script>

<template>
  <div v-loading="loading" :class="readonly ? 'leave-view' : 'qw-page leave-view'">
    <div v-if="!readonly" class="qw-page-bar">
      <el-button @click="back">
        <el-icon class="el-icon--left"><Icon icon="lucide:arrow-left" /></el-icon>
        {{ t('biz.leave.backToList') }}
      </el-button>
      <template v-if="beginTask">
        <el-button v-perm="leavePerms.modify" @click="edit">
          <el-icon class="el-icon--left"><Icon icon="lucide:pencil" /></el-icon>
          {{ t('crud.action.edit') }}
        </el-button>
        <el-button type="primary" :loading="resubmitting" @click="resubmit">
          <el-icon class="el-icon--left"><Icon icon="lucide:send" /></el-icon>
          {{ t('biz.leave.resubmit') }}
        </el-button>
      </template>
    </div>
    <el-alert
      v-if="!readonly && beginTask"
      type="warning"
      :title="t('biz.leave.sentBack')"
      :closable="false"
      show-icon
    />

    <el-card v-if="row" :shadow="readonly ? 'never' : undefined">
      <el-descriptions :title="t('biz.leave.title')" :column="readonly ? 1 : 2" border>
        <template #extra><DictTag code="biz.leave_state" :value="row.state" /></template>
        <el-descriptions-item :label="t('field.biz.leave.leaveKind')">
          <DictTag code="biz.leave_kind" :value="row.leaveKind" />
        </el-descriptions-item>
        <el-descriptions-item :label="t('field.biz.leave.days')">
          {{ row.days.toFixed(1) }}
        </el-descriptions-item>
        <el-descriptions-item :label="t('field.biz.leave.startAt')">
          {{ time(row.startAt) }}
        </el-descriptions-item>
        <el-descriptions-item :label="t('field.biz.leave.endAt')">
          {{ time(row.endAt) }}
        </el-descriptions-item>
        <el-descriptions-item :label="t('field.biz.leave.reason')" :span="readonly ? 1 : 2">
          <span class="qw-detail__text">{{ row.reason }}</span>
        </el-descriptions-item>
        <el-descriptions-item :label="t('field.common.createdAt')" :span="readonly ? 1 : 2">
          {{ time(row.createdAt) }}
        </el-descriptions-item>
      </el-descriptions>
    </el-card>

    <el-card v-if="inst" class="leave-view__flow">
      <template #header>
        <div class="leave-view__flow-head">
          <span>{{ t('biz.leave.approval') }}</span>
          <DictTag code="wf.instance_state" :value="inst.state" />
        </div>
      </template>
      <WfTimeline :events="inst.timeline" />
    </el-card>
  </div>
</template>

<style scoped>
.leave-view {
  min-height: 200px;
}
.leave-view__flow-head {
  display: flex;
  gap: 12px;
  align-items: center;
  font-weight: 600;
}
</style>
