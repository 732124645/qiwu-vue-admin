<script setup lang="ts">
import { computed, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  DEFAULT_PASSWORD_POLICY,
  userCreate,
  type PositionOption,
  type RoleOption,
  type UserCreate,
} from '@qiwu/shared'
import { positionApi } from '@/api/platform/iam/position'
import { roleApi } from '@/api/platform/iam/role'
import { userApi } from '@/api/platform/iam/user'
import DeptTreeSelect from '@/core/components/DeptTreeSelect.vue'
import PasswordToggle from '@/core/components/PasswordToggle.vue'
import { useCrudForm } from '@/core/composables/use-crud'
import { useDict } from '@/core/composables/use-dict'
import { tx } from '@/core/i18n'
import { useAuthStore } from '@/core/stores/auth'

/**
 * Add / edit form of the user list, opened with `openDialog(UserForm, { id })`. The password only when
 * adding (empty = the initial password param; either way it must be changed at the first sign-in); the
 * roles pass the server's grant policy (403 `grant_exceeds_own`).
 */
defineOptions({ name: 'IamUserForm' })
const { id } = defineProps<{ id?: number }>()
const emit = defineEmits<{ done: [saved: UserCreate & { id: number }]; cancel: [] }>()
const { t } = useI18n()
const { options: genders } = useDict('iam.gender')

const { model, formRef, rules, loading, submitting, submit, row } = useCrudForm({
  api: userApi,
  // the server's own schema under the runtime password policy (from /me); edits send no password
  schema: userCreate(useAuthStore().me?.policy ?? DEFAULT_PASSWORD_POLICY),
  emptyModel: (): UserCreate => ({
    username: '',
    displayName: '',
    ...(id == null && { password: '' }),
    deptId: null,
    mobile: '',
    email: '',
    gender: 'unknown',
    enabled: true,
    roleIds: [],
    positionIds: [],
    note: '',
  }),
  id,
  emit,
})

const roles = shallowRef<RoleOption[]>([])
const positions = shallowRef<PositionOption[]>([])
// the request layer shows a failure; the select then stays empty
roleApi.options().then(
  (r) => (roles.value = r),
  () => undefined,
)
positionApi.options().then(
  (p) => (positions.value = p),
  () => undefined,
)
/** the options plus held roles they leave out (disabled, root for a non-root caller): shown by name */
const roleChoices = computed(() => {
  const offered = new Set(roles.value.map((r) => r.id))
  const held = row.value?.roles ?? []
  return [...roles.value, ...held.filter((r) => !offered.has(r.id))]
})
</script>

<template>
  <el-form ref="formRef" v-loading="loading" :model="model" :rules="rules" label-position="left">
    <el-form-item :label="t('field.iam.user.username')" prop="username">
      <el-input v-model="model.username" maxlength="64" autocomplete="off" />
    </el-form-item>
    <el-form-item :label="t('field.iam.user.displayName')" prop="displayName">
      <el-input v-model="model.displayName" maxlength="64" />
    </el-form-item>
    <el-form-item v-if="id == null" :label="t('field.iam.user.password')" prop="password">
      <el-input
        v-model="model.password"
        type="password"
        autocomplete="new-password"
        show-password
        :placeholder="t('iam.user.passwordHint')"
      >
        <template #password-icon="{ visible }"><PasswordToggle :visible /></template>
      </el-input>
    </el-form-item>
    <el-form-item :label="t('field.iam.user.deptId')" prop="deptId">
      <DeptTreeSelect v-model="model.deptId" />
    </el-form-item>
    <el-form-item :label="t('field.iam.user.mobile')" prop="mobile">
      <el-input v-model="model.mobile" maxlength="32" />
    </el-form-item>
    <el-form-item :label="t('field.iam.user.email')" prop="email">
      <el-input v-model="model.email" maxlength="128" />
    </el-form-item>
    <el-form-item :label="t('field.iam.user.gender')" prop="gender">
      <el-radio-group v-model="model.gender">
        <el-radio v-for="g in genders" :key="g.value" :value="g.value">{{ g.label }}</el-radio>
      </el-radio-group>
    </el-form-item>
    <el-form-item :label="t('field.iam.user.roleIds')" prop="roleIds">
      <el-select v-model="model.roleIds" multiple filterable>
        <el-option v-for="r in roleChoices" :key="r.id" :label="tx(r.name)" :value="r.id" />
      </el-select>
    </el-form-item>
    <el-form-item :label="t('field.iam.user.positionIds')" prop="positionIds">
      <el-select v-model="model.positionIds" multiple filterable>
        <el-option v-for="p in positions" :key="p.id" :label="tx(p.name)" :value="p.id" />
      </el-select>
    </el-form-item>
    <el-form-item :label="t('field.iam.user.enabled')" prop="enabled">
      <el-switch v-model="model.enabled" />
    </el-form-item>
    <el-form-item :label="t('field.iam.user.note')" prop="note">
      <el-input v-model="model.note" type="textarea" :rows="3" maxlength="500" show-word-limit />
    </el-form-item>
  </el-form>
  <div class="qw-dialog-footer">
    <el-button @click="emit('cancel')">{{ t('common.action.cancel') }}</el-button>
    <el-button type="primary" :loading="submitting" @click="submit">
      {{ t('crud.action.save') }}
    </el-button>
  </div>
</template>
