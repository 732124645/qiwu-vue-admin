<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  DEFAULT_TENANT_ID,
  TENANT_DOMAINS_MAX,
  tenantAdminBody,
  tenantCreate,
  tenantUpdate,
  type FsObjectVo,
  type TenantCreate,
  type TenantCreatedVo,
  type TenantPackageOption,
} from '@qiwu/shared'
import { tenantApi } from '@/api/platform/iam/tenant'
import { tenantPackageApi } from '@/api/platform/iam/tenant-package'
import ImageUpload from '@/core/components/ImageUpload.vue'
import { useCrudForm } from '@/core/composables/use-crud'
import { zodRules } from '@/core/form/zod-rules'
import { tx } from '@/core/i18n'

/**
 * Open (no id) or edit form of the tenant list, opened with `openDialog(TenantForm, { id })`. Opening also
 * creates the tenant's administrator; its initial password comes back once in `done` and the list shows
 * it. The code and the administrator are fixed once opened (the API client never sends them on an edit).
 * An edit sends only the fields changed: the server acts on every field sent (a package bumps every
 * session, an end not in the future disables the tenant), so an untouched past end is not sent again.
 */
defineOptions({ name: 'IamTenantForm' })
const { id } = defineProps<{ id?: number }>()
const emit = defineEmits<{
  done: [saved: TenantCreate & Partial<Pick<TenantCreatedVo, 'initialPassword'>> & { id: number }]
  cancel: []
}>()
const i18n = useI18n()
const { t } = i18n
/** the default tenant keeps no package and no end (422): those fields are not shown */
const isDefault = id === DEFAULT_TENANT_ID

const { model, row, formRef, rules, loading, submitting, submit } = useCrudForm({
  api: {
    get: tenantApi.get,
    create: tenantApi.create,
    update: (tid: number, dto: TenantCreate) => tenantApi.update(tid, changed(dto)),
  },
  schema: id == null ? tenantCreate : tenantUpdate,
  emptyModel: () => ({
    code: '',
    name: '',
    packageId: null,
    expiresAt: null,
    userQuota: null,
    domains: [],
    brandName: '',
    logoObjectId: null,
    note: '',
    // only an add shows and sends it
    admin: { username: '', displayName: '', mobile: '', email: '' },
  }),
  id,
  emit,
})

/** the edit body: the fields that differ from the loaded row */
function changed(dto: TenantCreate): TenantCreate {
  const loaded = (row.value ?? {}) as Record<string, unknown>
  return Object.fromEntries(
    Object.entries(dto).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(loaded[k])),
  ) as TenantCreate
}

// the administrator's fields: rules of their own schema under `admin.<prop>`
const formRules = {
  ...rules,
  ...Object.fromEntries(
    Object.entries(zodRules(tenantAdminBody, i18n, model.admin)).map(([k, r]) => [`admin.${k}`, r]),
  ),
}

const packages = shallowRef<TenantPackageOption[]>([])
// the request layer shows a failure; the select then stays empty
tenantPackageApi.options().then(
  (o) => (packages.value = o),
  () => undefined,
)
/** the enabled packages, plus the tenant's own when it is disabled (shown by name, not chosen anew) */
const packageOptions = computed(() => {
  const own = row.value
  const list = packages.value.map((p) => ({ ...p, disabled: false }))
  if (own?.packageId != null && !list.some((p) => p.id === own.packageId))
    list.push({ id: own.packageId, name: own.packageName ?? String(own.packageId), disabled: true })
  return list
})

// the logo is an object id; the upload field shows it by the URL the row answered
const logoUrl = ref<string | null>(null)
watch(row, (r) => (logoUrl.value = r?.logoUrl ?? null))
const logo = computed<FsObjectVo[]>({
  get: () =>
    model.logoObjectId
      ? [
          {
            id: model.logoObjectId,
            originalName: t('field.iam.tenant.logoObjectId'),
            mime: '',
            size: 0,
            url: logoUrl.value,
            isPublic: true,
            bizTag: 'cover',
            createdAt: '',
          },
        ]
      : [],
  set: (list) => {
    model.logoObjectId = list[0]?.id ?? null
    logoUrl.value = list[0]?.url ?? null
  },
})
</script>

<template>
  <el-form
    ref="formRef"
    v-loading="loading"
    :model="model"
    :rules="formRules"
    label-position="left"
    class="qw-form-cols-2 tenant-form"
  >
    <el-divider content-position="left">{{ t('iam.tenant.sections.basic') }}</el-divider>
    <el-form-item :label="t('field.iam.tenant.code')" prop="code">
      <el-input v-model="model.code" maxlength="32" :disabled="id != null" />
      <div v-if="id == null" class="field-hint">{{ t('iam.tenant.hints.code') }}</div>
    </el-form-item>
    <el-form-item :label="t('field.iam.tenant.name')" prop="name">
      <el-input v-model="model.name" maxlength="64" />
    </el-form-item>
    <template v-if="!isDefault">
      <el-form-item :label="t('field.iam.tenant.packageId')" prop="packageId">
        <el-select v-model="model.packageId" filterable>
          <el-option
            v-for="p in packageOptions"
            :key="p.id"
            :label="tx(p.name)"
            :value="p.id"
            :disabled="p.disabled"
          />
        </el-select>
        <div class="field-hint">{{ t('iam.tenant.hints.package') }}</div>
      </el-form-item>
      <el-form-item :label="t('field.iam.tenant.expiresAt')" prop="expiresAt">
        <!-- sent as an instant with the browser's offset (the API takes ISO-8601 with an offset) -->
        <el-date-picker
          v-model="model.expiresAt"
          type="datetime"
          value-format="YYYY-MM-DD[T]HH:mm:ss.SSSZ"
          :placeholder="t('iam.tenant.permanent')"
        />
        <div class="field-hint">{{ t('iam.tenant.hints.expiresAt') }}</div>
      </el-form-item>
    </template>
    <el-alert
      v-else
      type="info"
      :title="t('iam.tenant.hints.defaultFixed')"
      :closable="false"
      show-icon
      class="tenant-form__row"
    />
    <el-form-item :label="t('field.iam.tenant.userQuota')" prop="userQuota">
      <el-input-number
        v-model="model.userQuota"
        :min="1"
        :max="1_000_000"
        :placeholder="t('iam.tenant.unlimited')"
        controls-position="right"
      />
      <div class="field-hint">{{ t('iam.tenant.hints.userQuota') }}</div>
    </el-form-item>
    <el-form-item :label="t('field.iam.tenant.domains')" prop="domains" class="qw-form-wide">
      <el-input-tag v-model="model.domains" :max="TENANT_DOMAINS_MAX" />
      <div class="field-hint">{{ t('iam.tenant.hints.domains') }}</div>
    </el-form-item>
    <el-form-item :label="t('field.iam.tenant.note')" prop="note" class="qw-form-wide">
      <el-input v-model="model.note" type="textarea" :rows="2" maxlength="500" show-word-limit />
    </el-form-item>

    <el-divider content-position="left">{{ t('iam.tenant.sections.brand') }}</el-divider>
    <el-form-item :label="t('field.iam.tenant.brandName')" prop="brandName" class="qw-form-wide">
      <el-input v-model="model.brandName" maxlength="64" />
      <div class="field-hint">{{ t('iam.tenant.hints.brandName') }}</div>
    </el-form-item>
    <el-form-item
      :label="t('field.iam.tenant.logoObjectId')"
      prop="logoObjectId"
      class="qw-form-wide"
    >
      <ImageUpload v-model="logo" biz-tag="cover" />
      <div class="field-hint">{{ t('iam.tenant.hints.logo') }}</div>
    </el-form-item>

    <template v-if="id == null">
      <el-divider content-position="left">{{ t('iam.tenant.sections.admin') }}</el-divider>
      <p class="field-hint tenant-form__row">{{ t('iam.tenant.hints.admin') }}</p>
      <el-form-item :label="t('field.iam.tenant.username')" prop="admin.username">
        <el-input v-model="model.admin.username" maxlength="64" />
      </el-form-item>
      <el-form-item :label="t('field.iam.tenant.displayName')" prop="admin.displayName">
        <el-input v-model="model.admin.displayName" maxlength="64" />
      </el-form-item>
      <el-form-item :label="t('field.iam.tenant.mobile')" prop="admin.mobile">
        <el-input v-model="model.admin.mobile" maxlength="32" />
      </el-form-item>
      <el-form-item :label="t('field.iam.tenant.email')" prop="admin.email">
        <el-input v-model="model.admin.email" maxlength="128" />
      </el-form-item>
    </template>
  </el-form>
  <div class="qw-dialog-footer">
    <el-button @click="emit('cancel')">{{ t('common.action.cancel') }}</el-button>
    <el-button type="primary" :loading="submitting" @click="submit">
      {{ t('crud.action.save') }}
    </el-button>
  </div>
</template>

<style scoped>
/* sections, notes and hints take the whole row of the two-column form */
.tenant-form > .el-divider,
.tenant-form__row {
  grid-column: 1 / -1;
}
.tenant-form > .el-alert {
  margin-bottom: 18px;
}
.tenant-form > p.tenant-form__row {
  margin: 0 0 12px;
}
.field-hint {
  font-size: 12px;
  line-height: 1.5;
  color: var(--qw-text-3);
}
</style>
