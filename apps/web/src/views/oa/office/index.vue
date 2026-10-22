<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import {
  leavePerms,
  oaExpensePerms,
  oaSealPerms,
  oaTripPerms,
  type WfStartableVo,
  type WfStartVo,
} from '@qiwu/shared'
import { wfCenterApi } from '@/api/workflow/center'
import { toastRest } from '@/core/composables/use-crud'
import { openDialog } from '@/core/dialog'
import { useAuthStore } from '@/core/stores/auth'
import { Icon } from '@/core/icons'
import WfStartForm from '@/views/workflow/center/WfStartForm.vue'
import WfMine from '@/views/workflow/center/mine.vue'
import WfTodo from '@/views/workflow/center/todo.vue'
import WfDone from '@/views/workflow/center/done.vue'
import WfCc from '@/views/workflow/center/cc.vue'
import { officeWorkflowAvailable } from '../components/access'

defineOptions({ name: 'OaOffice' })
const { t } = useI18n()
const router = useRouter()
const auth = useAuthStore()
const hasWorkflow = computed(() => officeWorkflowAvailable(auth.me))
const models = shallowRef<WfStartableVo[]>([])
const loading = ref(false)
const opening = ref(false)
const tab = ref('todo')
const modelKey = ref('')
const types = [
  {
    kind: 'leave',
    key: 'leave',
    perm: leavePerms.create,
    route: '/biz/leave/new',
    icon: 'lucide:calendar-days',
  },
  {
    kind: 'trip',
    key: 'oa-trip',
    perm: oaTripPerms.create,
    route: '/oa/trip/new',
    icon: 'lucide:plane',
  },
  {
    kind: 'expense',
    key: 'oa-expense',
    perm: oaExpensePerms.create,
    route: '/oa/expense/new',
    icon: 'lucide:receipt',
  },
  {
    kind: 'seal',
    key: 'oa-seal',
    perm: oaSealPerms.create,
    route: '/oa/seal/new',
    icon: 'lucide:stamp',
  },
  { kind: 'generic', key: 'oa-generic', perm: null, route: '', icon: 'lucide:file-check' },
]
const tabs = { mine: WfMine, todo: WfTodo, done: WfDone, cc: WfCc }
const mayStart = (item: (typeof types)[number]) =>
  hasWorkflow.value && (!item.perm || auth.hasPerm(item.perm))
const enabled = (item: (typeof types)[number]) =>
  mayStart(item) && models.value.some((model) => model.modelKey === item.key)
/** 只展示当前用户可发起的发布模型，不凭静态卡片绕过发起范围。 */
onMounted(async () => {
  if (!hasWorkflow.value) return
  loading.value = true
  try {
    models.value = await wfCenterApi.startable()
  } catch (e) {
    toastRest(e)
  } finally {
    loading.value = false
  }
})
async function start(item: (typeof types)[number]) {
  if (!enabled(item) || opening.value) return
  if (item.route) {
    await router.push(item.route)
    return
  }
  opening.value = true
  try {
    const started = await openDialog<WfStartVo>(
      WfStartForm,
      { modelKey: item.key },
      { title: () => t('oa.generic.entity') },
    )
    if (started) await router.push(`/workflow/instances/${started.id}`)
  } finally {
    opening.value = false
  }
}
</script>
<template>
  <div class="qw-page oa-office">
    <div class="oa-office__heading">
      <h1>{{ t('oa.title') }}</h1>
      <p>{{ t('oa.subtitle') }}</p>
    </div>
    <el-alert
      v-if="!hasWorkflow"
      :title="t('oa.workflowUnavailable')"
      type="info"
      :closable="false"
    />
    <div v-loading="loading" class="oa-office__cards">
      <el-card v-for="item in types" :key="item.key" class="oa-office__card" :data-model="item.key">
        <div class="oa-office__card-title">
          <Icon :icon="item.icon" /><strong>{{ t(`oa.${item.kind}.entity`) }}</strong>
        </div>
        <p v-if="mayStart(item) && !enabled(item)">{{ t('oa.unavailable') }}</p>
        <el-button
          v-if="mayStart(item)"
          type="primary"
          :disabled="loading || opening || !enabled(item)"
          @click="start(item)"
          >{{ t('oa.apply') }}</el-button
        >
      </el-card>
    </div>
    <el-card v-if="hasWorkflow" class="oa-office__approvals">
      <div class="oa-office__filter">
        <el-select v-model="modelKey" :aria-label="t('wf.center.list.model')" clearable
          ><el-option :label="t('oa.allTypes')" value="" /><el-option
            v-for="item in types"
            :key="item.key"
            :label="t(`oa.${item.kind}.entity`)"
            :value="item.key"
        /></el-select>
      </div>
      <el-tabs v-model="tab"
        ><el-tab-pane
          v-for="(_, key) in tabs"
          :key="key"
          :name="key"
          :label="
            t(
              `oa.${key === 'mine' ? 'myRequests' : key === 'todo' ? 'myTodo' : key === 'done' ? 'myDone' : 'myCc'}`,
            )
          "
          lazy
          ><component :is="tabs[key]" :model-key="modelKey || undefined" /></el-tab-pane
      ></el-tabs>
    </el-card>
  </div>
</template>
<style scoped>
.oa-office__heading h1 {
  margin: 0;
  font-size: 24px;
  color: var(--qw-text);
}
.oa-office__heading p {
  color: var(--qw-text-2);
  margin: 8px 0 20px;
}
.oa-office__cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 16px;
}
.oa-office__card-title {
  display: flex;
  gap: 10px;
  align-items: center;
  font-size: 16px;
  color: var(--qw-text);
  margin-bottom: 16px;
}
.oa-office__card-title > :first-child {
  color: var(--qw-brand-text);
  font-size: 24px;
}
.oa-office__card p {
  color: var(--qw-text-3);
  font-size: 13px;
}
.oa-office__filter {
  max-width: 260px;
}
.oa-office__approvals {
  margin-top: 20px;
}
.oa-office__approvals :deep(.qw-page) {
  padding: 0;
}
</style>
