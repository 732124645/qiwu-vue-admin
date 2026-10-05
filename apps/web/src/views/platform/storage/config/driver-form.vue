<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, type FormItemRule } from 'element-plus'
import {
  fieldLabelKeys,
  STORAGE_DRIVERS,
  STORAGE_SECRET_MASK,
  storageLocalCreate,
  storageS3Create,
  storageS3Update,
  type StorageConfigCreate,
  type StorageDriver,
} from '@qiwu/shared'
import { storageConfigApi } from '@/api/platform/storage/storage-config'
import { useCrudForm } from '@/core/composables/use-crud'
import { zodRules } from '@/core/form/zod-rules'
import { ApiError } from '@/core/request/http'

/**
 * Add / edit form of a storage (see docs/design-notes.md#storage), the dialog content of the generated config list
 * (`openDialog(StorageDriverForm, { id }, { title })`). The driver, chosen when adding, decides the fields:
 * local has only the public URL prefix (its files live under the server's `STORAGE_LOCAL_ROOT`, never set
 * here); S3 has the bucket settings. The secret key never comes back: editing shows it blank as
 * "unchanged" and a blank one is left out of the save, so the stored key stays unless the connection
 * target changes, in which case a new secret is required. "Test connection" tries the
 * saved settings and only says whether it worked (nothing of the remote answer; see docs/design-notes.md#security).
 */
defineOptions({ name: 'StorageConfigDriverForm' })
const { id } = defineProps<{ id?: number }>()
const emit = defineEmits<{ done: [saved: { id: number }]; cancel: [] }>()
const i18n = useI18n()
const { t, te } = i18n

const emptyModel = () => ({
  name: '',
  driver: 'local' as StorageDriver,
  enabled: true,
  note: null as string | null,
  publicPrefix: null as string | null,
  endpoint: '',
  region: '',
  bucket: '',
  accessKey: '',
  secretKey: '',
  forcePathStyle: false,
  publicDomain: null as string | null,
})
type Model = ReturnType<typeof emptyModel>

const FIELDS: Record<StorageDriver, string[]> = {
  local: Object.keys(storageLocalCreate.shape),
  s3: Object.keys(storageS3Create.shape),
}
/** the driver's own fields only; a blank secret is left out (edit: the stored one stays) */
function bodyOf(m: Model) {
  const body = Object.fromEntries(FIELDS[m.driver].map((k) => [k, m[k as keyof Model]]))
  if (m.driver === 's3' && !m.secretKey) delete body.secretKey
  return body as StorageConfigCreate
}

const { model, row, formRef, loading, submitting, submit } = useCrudForm({
  api: {
    // the masked secret is not shown: the field starts blank, meaning "unchanged"
    get: async (id: number) => ({ ...(await storageConfigApi.get(id)), secretKey: '' }),
    create: (m: Model) => storageConfigApi.create(bodyOf(m)),
    update: (id: number, m: Model) => storageConfigApi.update(id, bodyOf(m)),
  },
  schema: storageLocalCreate,
  emptyModel,
  id,
  emit,
})

const editing = id != null
const secretRequired = computed(() => {
  const loaded = row.value
  return (
    editing &&
    loaded?.driver === 's3' &&
    (['endpoint', 'bucket', 'accessKey'] as const).some((key) => model[key].trim() !== loaded[key])
  )
})
const rules = computed(() => {
  const schema =
    model.driver === 'local' ? storageLocalCreate : editing ? storageS3Update : storageS3Create
  const all = zodRules(schema, i18n, model)
  // A blank or masked secret keeps the stored one only for an unchanged connection target.
  if (editing && all.secretKey)
    all.secretKey = all.secretKey.map((rule): FormItemRule => ({
      ...rule,
      required: secretRequired.value,
      validator: (...args: Parameters<NonNullable<FormItemRule['validator']>>) => {
        const secret = (args[1] as string | undefined)?.trim()
        if (secretRequired.value && (!secret || secret === STORAGE_SECRET_MASK))
          return args[2](new Error(t('storage.config.secretRequired')))
        return args[1] ? rule.validator?.(...args) : args[2]()
      },
    }))
  return all
})

/** `field.storage.config.<prop>`, else `field.common.<prop>` (name / driver / note / enabled come with the generated module) */
const label = (prop: string) => {
  const key = fieldLabelKeys('storage.config', [prop]).find((k) => te(k))
  return key ? t(key) : prop
}

const testing = ref(false)
/** the last test's answer; null = not tested (or the request itself failed: the request layer said why) */
const tested = ref<boolean | null>(null)
async function test() {
  if (!editing || testing.value) return
  testing.value = true
  tested.value = null
  try {
    tested.value = (await storageConfigApi.test(id)).ok
  } catch (e) {
    // 403/429/5xx are toasted by the request layer
    if (e instanceof ApiError && e.status === 404) ElMessage.error(e.message)
  } finally {
    testing.value = false
  }
}
</script>

<template>
  <!-- the rules follow the driver: switching it must not flag the new driver's blank fields at once -->
  <el-form
    ref="formRef"
    v-loading="loading"
    :model="model"
    :rules="rules"
    :validate-on-rule-change="false"
    label-position="left"
  >
    <el-form-item :label="label('name')" prop="name">
      <el-input v-model="model.name" maxlength="64" />
    </el-form-item>
    <el-form-item :label="label('driver')" prop="driver">
      <el-radio-group v-model="model.driver" :disabled="editing">
        <el-radio v-for="d in STORAGE_DRIVERS" :key="d" :value="d">
          {{ t(`storage.driver.${d}`) }}
        </el-radio>
      </el-radio-group>
    </el-form-item>

    <template v-if="model.driver === 'local'">
      <el-form-item :label="label('publicPrefix')" prop="publicPrefix">
        <el-input v-model="model.publicPrefix" maxlength="255" placeholder="/files" />
        <div class="storage-form__hint">{{ t('storage.driver.localHint') }}</div>
      </el-form-item>
    </template>
    <template v-else>
      <el-form-item :label="label('endpoint')" prop="endpoint">
        <el-input
          v-model="model.endpoint"
          maxlength="255"
          placeholder="https://s3.example.com"
          autocomplete="off"
        />
      </el-form-item>
      <el-form-item :label="label('region')" prop="region">
        <el-input v-model="model.region" maxlength="64" placeholder="us-east-1" />
      </el-form-item>
      <el-form-item :label="label('bucket')" prop="bucket">
        <el-input v-model="model.bucket" maxlength="63" />
      </el-form-item>
      <el-form-item :label="label('accessKey')" prop="accessKey">
        <el-input v-model="model.accessKey" maxlength="128" autocomplete="off" />
      </el-form-item>
      <el-form-item :label="label('secretKey')" prop="secretKey">
        <el-input
          v-model="model.secretKey"
          type="password"
          show-password
          maxlength="256"
          autocomplete="new-password"
          :placeholder="
            secretRequired
              ? t('storage.config.secretRequired')
              : editing
                ? t('storage.driver.secretUnchanged')
                : ''
          "
        />
      </el-form-item>
      <el-form-item :label="label('forcePathStyle')" prop="forcePathStyle">
        <el-switch v-model="model.forcePathStyle" />
      </el-form-item>
      <el-form-item :label="label('publicDomain')" prop="publicDomain">
        <el-input
          v-model="model.publicDomain"
          maxlength="255"
          placeholder="https://cdn.example.com"
        />
      </el-form-item>
    </template>

    <el-form-item :label="label('enabled')" prop="enabled">
      <el-switch v-model="model.enabled" />
    </el-form-item>
    <el-form-item :label="label('note')" prop="note">
      <el-input v-model="model.note" type="textarea" :rows="2" maxlength="500" show-word-limit />
    </el-form-item>
  </el-form>
  <el-alert
    v-if="tested !== null"
    class="storage-form__result"
    :type="tested ? 'success' : 'error'"
    :title="t(tested ? 'storage.driver.testOk' : 'storage.driver.testFailed')"
    :closable="false"
    show-icon
  />
  <div class="qw-dialog-footer">
    <el-button
      v-if="editing"
      class="storage-form__test"
      :loading="testing"
      :title="t('storage.driver.testHint')"
      @click="test"
    >
      {{ t('storage.driver.test') }}
    </el-button>
    <el-button @click="emit('cancel')">{{ t('common.action.cancel') }}</el-button>
    <el-button type="primary" :loading="submitting" @click="submit">
      {{ t('crud.action.save') }}
    </el-button>
  </div>
</template>

<style scoped>
.storage-form__hint {
  margin-top: 4px;
  font-size: 12px;
  line-height: 18px;
  color: var(--qw-text-3);
}
.storage-form__result {
  margin-top: 8px;
}
/* the test sits apart from the dialog's own buttons, at the start of the footer */
.storage-form__test {
  margin-right: auto;
}
</style>
