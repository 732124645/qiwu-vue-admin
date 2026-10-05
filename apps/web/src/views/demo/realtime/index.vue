<script setup lang="ts">
import { reactive, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import { ElMessage, type FormInstance } from 'element-plus'
import {
  type DemoRealtimeTarget,
  demoRealtimePerms,
  demoRealtimeSendBody,
  RT,
  type RealtimePayloads,
  type RoleOption,
  type UserOption,
} from '@qiwu/shared'
import { demoRealtimeApi } from '@/api/demo/realtime'
import { roleApi } from '@/api/platform/iam/role'
import EmptyState from '@/core/components/EmptyState.vue'
import UserPicker from '@/core/components/UserPicker.vue'
import { openDialog } from '@/core/dialog'
import { revalidateOnLocale, zodRules } from '@/core/form/zod-rules'
import { tx } from '@/core/i18n'
import { Icon } from '@/core/icons'
import { usePerm } from '@/core/permission'
import { onRealtime, realtimeStatus } from '@/core/realtime/socket'

/**
 * Realtime push demo: the socket's state, a form that pushes plain text to users, roles or
 * everyone (POST /api/demo/realtime/send) and the `demo:message` pushes received here, newest first.
 * The menu keeps the page alive, so the log survives switching tabs; the subscription ends with the page.
 */
defineOptions({ name: 'DemoRealtime' })
const LOG_MAX = 100
const STATUS_TAG = { up: 'success', reconnecting: 'warning', down: 'danger' } as const

const i18n = useI18n()
const { t } = i18n
const perm = usePerm()

const model = reactive({
  target: 'user' as DemoRealtimeTarget,
  userIds: [] as number[],
  roleIds: [] as number[],
  text: '',
})
const rules = zodRules(demoRealtimeSendBody, i18n, model)
const formRef = ref<FormInstance>()
revalidateOnLocale(formRef)

const users = shallowRef<UserOption[]>([])
function setUsers(list: UserOption[]) {
  users.value = list
  model.userIds = list.map((u) => u.id)
  // the tags have no input to blur: re-check here so a picked user clears "required" at once
  void formRef.value?.validateField('userIds').catch(() => undefined)
}
async function pickUsers() {
  const picked = await openDialog<UserOption[]>(
    UserPicker,
    { multiple: true, selected: users.value },
    { title: () => t('picker.user.title'), width: 880 },
  )
  if (picked) setUsers(picked)
}

const roles = shallowRef<RoleOption[]>([])
// only for the form; the request layer shows a failure, the select then stays empty
if (perm.has(demoRealtimePerms.send))
  roleApi.options().then(
    (r) => (roles.value = r),
    () => undefined,
  )

const sending = ref(false)
async function send() {
  if (sending.value || !(await formRef.value?.validate().catch(() => false))) return
  sending.value = true
  try {
    const { target, text } = model
    // only the chosen target's list: the server refuses the other one
    const { delivered } = await demoRealtimeApi.send({
      target,
      userIds: target === 'user' ? model.userIds : undefined,
      roleIds: target === 'role' ? model.roleIds : undefined,
      text,
    })
    ElMessage.success(t('demo.realtime.send.done', delivered))
    model.text = ''
  } catch {
    // the request layer toasted 403/422/429; the text stays for another try
  } finally {
    sending.value = false
  }
}

type Received = RealtimePayloads['demo:message'] & { key: number }
const log = shallowRef<Received[]>([])
let seq = 0
onRealtime(RT.demoMessage, (m) => {
  log.value = [{ ...m, key: ++seq }, ...log.value].slice(0, LOG_MAX)
})
</script>

<template>
  <div class="qw-page demo-realtime">
    <div class="qw-page-bar">
      <span class="qw-page-bar__context demo-realtime__status">
        {{ t('demo.realtime.status.label') }}
        <el-tag
          :type="STATUS_TAG[realtimeStatus]"
          class="qw-dict-tag"
          role="status"
          disable-transitions
        >
          {{ t(`demo.realtime.status.${realtimeStatus}`) }}
        </el-tag>
      </span>
    </div>

    <div class="demo-realtime__panels">
      <el-card v-if="perm.has(demoRealtimePerms.send)" class="demo-realtime__send">
        <h2 class="demo-realtime__title">{{ t('demo.realtime.send.title') }}</h2>
        <el-form
          ref="formRef"
          :model="model"
          :rules="rules"
          label-position="top"
          @submit.prevent="send"
        >
          <el-form-item :label="t('field.demo.realtime.target')" prop="target">
            <el-radio-group v-model="model.target">
              <el-radio value="user">{{ t('demo.realtime.send.target.user') }}</el-radio>
              <el-radio value="role">{{ t('demo.realtime.send.target.role') }}</el-radio>
              <el-radio v-if="perm.has(demoRealtimePerms.broadcast)" value="all">
                {{ t('demo.realtime.send.target.all') }}
              </el-radio>
            </el-radio-group>
          </el-form-item>
          <el-form-item
            v-if="model.target === 'user'"
            :label="t('field.demo.realtime.userIds')"
            prop="userIds"
          >
            <div class="demo-realtime__users">
              <el-tag
                v-for="u in users"
                :key="u.id"
                closable
                disable-transitions
                :title="u.username"
                @close="setUsers(users.filter((x) => x.id !== u.id))"
              >
                {{ u.displayName }}
              </el-tag>
              <el-button @click="pickUsers">
                <el-icon class="el-icon--left"><Icon icon="lucide:user-search" /></el-icon>
                {{ t('picker.user.title') }}
              </el-button>
            </div>
          </el-form-item>
          <el-form-item
            v-else-if="model.target === 'role'"
            :label="t('field.demo.realtime.roleIds')"
            prop="roleIds"
          >
            <el-select
              v-model="model.roleIds"
              multiple
              filterable
              :placeholder="t('demo.realtime.send.rolePlaceholder')"
            >
              <el-option v-for="r in roles" :key="r.id" :label="tx(r.name)" :value="r.id" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('field.demo.realtime.text')" prop="text">
            <el-input
              v-model="model.text"
              type="textarea"
              :rows="5"
              maxlength="500"
              show-word-limit
              :placeholder="t('demo.realtime.send.textPlaceholder')"
            />
          </el-form-item>
          <div class="demo-realtime__actions">
            <el-button type="primary" native-type="submit" :loading="sending">
              {{ t('demo.realtime.send.submit') }}
            </el-button>
          </div>
        </el-form>
      </el-card>

      <el-card class="demo-realtime__log">
        <div class="demo-realtime__log-head">
          <h2 class="demo-realtime__title">{{ t('demo.realtime.log.title') }}</h2>
          <span class="demo-realtime__hint">{{
            t('demo.realtime.log.hint', { max: LOG_MAX })
          }}</span>
          <el-button text :disabled="!log.length" @click="log = []">
            {{ t('demo.realtime.log.clear') }}
          </el-button>
        </div>
        <!-- always rendered, so screen readers announce the first message too -->
        <div aria-live="polite">
          <!-- plain text only: the pushed text is interpolated, never rendered as HTML -->
          <ol v-if="log.length" class="demo-realtime__list">
            <li v-for="m in log" :key="m.key" class="demo-realtime__item">
              <div class="demo-realtime__meta">
                <span class="demo-realtime__from">{{ m.from.name }}</span>
                <time :datetime="m.at">{{ dayjs(m.at).format('YYYY-MM-DD HH:mm:ss') }}</time>
              </div>
              <p class="demo-realtime__text">{{ m.text }}</p>
            </li>
          </ol>
          <EmptyState
            v-else
            :title="t('demo.realtime.log.empty')"
            :description="t('demo.realtime.log.emptyHint')"
          />
        </div>
      </el-card>
    </div>
  </div>
</template>

<style scoped>
.demo-realtime__status {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  font-size: 13px;
  color: var(--qw-text-2);
}
.demo-realtime__panels {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 400px), 1fr));
  gap: 16px;
  align-items: start;
}
.demo-realtime__title {
  margin: 0 0 16px;
  font-size: 15px;
  font-weight: 600;
  color: var(--qw-text);
}
.demo-realtime__users {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.demo-realtime__actions {
  display: flex;
  justify-content: flex-end;
}
.demo-realtime__log-head {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  align-items: baseline;
  margin-bottom: 12px;
}
.demo-realtime__log-head .demo-realtime__title {
  margin: 0;
}
.demo-realtime__hint {
  margin-right: auto;
  font-size: 12px;
  color: var(--qw-text-3);
}
.demo-realtime__list {
  max-height: 560px;
  padding: 0;
  margin: 0;
  overflow-y: auto;
  list-style: none;
}
.demo-realtime__item {
  padding: 12px 0;
  border-top: 1px solid var(--qw-border);
}
.demo-realtime__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  align-items: baseline;
  font-size: 12px;
  color: var(--qw-text-3);
  font-variant-numeric: tabular-nums;
}
.demo-realtime__from {
  font-size: 13px;
  font-weight: 600;
  color: var(--qw-text);
}
.demo-realtime__text {
  margin: 4px 0 0;
  color: var(--qw-text-2);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
