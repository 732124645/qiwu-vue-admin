<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { deptCreate, type DeptCreate } from '@qiwu/shared'
import { deptApi } from '@/api/platform/iam/dept'
import DeptTreeSelect from '@/core/components/DeptTreeSelect.vue'
import UserSelect from '@/core/components/UserSelect.vue'
import { useCrudForm } from '@/core/composables/use-crud'

/**
 * Add / edit form of the dept tree, opened with `openDialog(DeptForm, { id })` or, to add below a dept,
 * `{ parentId }`. The parent picker leaves out the dept itself and its subtree (the server refuses them
 * too: 422); cleared = top level. The head is picked with `UserPicker` (users of the caller's scope).
 */
defineOptions({ name: 'IamDeptForm' })
const { id, parentId = 0 } = defineProps<{ id?: number; parentId?: number }>()
const emit = defineEmits<{ done: [saved: { id: number }]; cancel: [] }>()
const { t } = useI18n()
const { model, row, formRef, rules, loading, submitting, submit } = useCrudForm({
  api: deptApi,
  schema: deptCreate,
  emptyModel: (): DeptCreate => ({
    parentId,
    name: '',
    sortNo: 0,
    headUserId: null,
    phone: '',
    email: '',
    enabled: true,
  }),
  id,
  emit,
})
// 0 (top level) shows as the empty select
const parent = computed({
  get: () => model.parentId || null,
  set: (v: number | null | undefined) => (model.parentId = v ?? 0),
})
</script>

<template>
  <el-form ref="formRef" v-loading="loading" :model="model" :rules="rules" label-position="left">
    <el-form-item :label="t('field.iam.dept.parentId')" prop="parentId">
      <DeptTreeSelect v-model="parent" :exclude="id" :placeholder="t('crud.tree.topLevel')" />
    </el-form-item>
    <el-form-item :label="t('field.iam.dept.name')" prop="name">
      <el-input v-model="model.name" maxlength="64" />
    </el-form-item>
    <el-form-item :label="t('field.iam.dept.sortNo')" prop="sortNo">
      <el-input-number v-model="model.sortNo" :min="0" :max="999999" controls-position="right" />
    </el-form-item>
    <el-form-item :label="t('field.iam.dept.headUserId')" prop="headUserId">
      <UserSelect v-model="model.headUserId" :label="row?.headUserName" />
    </el-form-item>
    <el-form-item :label="t('field.iam.dept.phone')" prop="phone">
      <el-input v-model="model.phone" maxlength="32" />
    </el-form-item>
    <el-form-item :label="t('field.iam.dept.email')" prop="email">
      <el-input v-model="model.email" maxlength="128" />
    </el-form-item>
    <el-form-item :label="t('field.iam.dept.enabled')" prop="enabled">
      <el-switch v-model="model.enabled" />
    </el-form-item>
  </el-form>
  <div class="qw-dialog-footer">
    <el-button @click="emit('cancel')">{{ t('common.action.cancel') }}</el-button>
    <el-button type="primary" :loading="submitting" @click="submit">
      {{ t('crud.action.save') }}
    </el-button>
  </div>
</template>
