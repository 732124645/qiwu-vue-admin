<script setup lang="ts">
import { computed, reactive, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, type FormInstance } from 'element-plus'
import { geoByIpQuery, geoPerms, type GeoAreaNode, type GeoIpVo } from '@qiwu/shared'
import { geoApi } from '@/api/platform/geo'
import AreaCascader from '@/core/components/AreaCascader.vue'
import { revalidateOnLocale, zodRules } from '@/core/form/zod-rules'
import { Icon } from '@/core/icons'
import { ApiError } from '@/core/request/http'

// keep-alive name = the seeded menu's component_name
defineOptions({ name: 'GeoArea' })

const i18n = useI18n()
const { t } = i18n

// ---- division tree: fetched whole once, rendered a level at a time as nodes expand ----
// `children: 'none'`: el-tree never builds child nodes from the data itself, `load` hands them over
const treeProps = {
  label: 'name',
  children: 'none',
  isLeaf: (data: GeoAreaNode) => !data.children?.length,
}
type LoadNode = { level: number; data: GeoAreaNode }
async function loadNode(node: LoadNode, resolve: (nodes: GeoAreaNode[]) => void) {
  if (node.level > 0) return resolve(node.data.children ?? [])
  try {
    resolve(await geoApi.tree())
  } catch {
    resolve([]) // the request layer showed it
  }
}

// ---- IP lookup ----
const form = reactive({ ip: '' })
const rules = zodRules(geoByIpQuery, i18n)
const formRef = ref<FormInstance>()
revalidateOnLocale(formRef)
const result = shallowRef<GeoIpVo>()
const looking = ref(false)
async function lookup() {
  if (looking.value || !(await formRef.value?.validate().catch(() => false))) return
  looking.value = true
  try {
    result.value = await geoApi.byIp(form.ip)
  } catch (e) {
    // 403/429/5xx are toasted by the request layer
    if (e instanceof ApiError && e.status === 400) ElMessage.error(e.message)
  } finally {
    looking.value = false
  }
}
const place = computed(() =>
  [result.value?.country, result.value?.province, result.value?.city].filter(Boolean).join(' / '),
)
const unknown = computed(() => !!result.value && !place.value && !result.value.isp)
const parts = ['country', 'province', 'city', 'isp'] as const

// ---- the picker as forms use it ----
const picked = ref<string[] | null>()
</script>

<template>
  <div class="qw-page">
    <div class="geo-area">
      <el-card class="geo-area__tree-card">
        <h2 class="geo-area__title">{{ t('geo.area.tree') }}</h2>
        <el-tree
          lazy
          :load="loadNode"
          :props="treeProps"
          node-key="code"
          class="geo-area__tree"
          :aria-label="t('geo.area.tree')"
        >
          <template #default="{ data }">
            <span class="geo-area__node">
              <span>{{ data.name }}</span>
              <span class="geo-area__code">{{ data.code }}</span>
            </span>
          </template>
        </el-tree>
      </el-card>

      <div class="geo-area__side">
        <el-card v-perm="geoPerms.browse">
          <h2 class="geo-area__title">{{ t('geo.area.lookup') }}</h2>
          <el-form
            ref="formRef"
            :model="form"
            :rules="rules"
            label-position="top"
            hide-required-asterisk
            class="geo-area__lookup"
            @submit.prevent="lookup"
          >
            <el-form-item prop="ip" :label="t('field.geo.area.ip')">
              <div class="geo-area__lookup-row">
                <el-input
                  v-model.trim="form.ip"
                  name="ip"
                  clearable
                  :placeholder="t('geo.area.ipHint')"
                />
                <el-button type="primary" native-type="submit" :loading="looking">
                  <el-icon class="el-icon--left"><Icon icon="lucide:search" /></el-icon>
                  {{ t('geo.area.query') }}
                </el-button>
              </div>
            </el-form-item>
          </el-form>
          <template v-if="result">
            <p class="geo-area__place" :class="{ 'geo-area__place--unknown': unknown }">
              <Icon icon="lucide:map-pin" aria-hidden="true" />
              {{ unknown ? t('geo.area.unknown') : place || result.isp }}
            </p>
            <el-descriptions :column="1" border>
              <el-descriptions-item :label="t('field.geo.area.ip')">{{
                result.ip
              }}</el-descriptions-item>
              <el-descriptions-item v-for="p in parts" :key="p" :label="t(`field.geo.area.${p}`)">
                {{ result[p] ?? '—' }}
              </el-descriptions-item>
            </el-descriptions>
          </template>
        </el-card>

        <el-card>
          <h2 class="geo-area__title">{{ t('geo.area.picker') }}</h2>
          <p class="geo-area__hint">{{ t('geo.area.pickerHint') }}</p>
          <div class="geo-area__picker">
            <AreaCascader v-model="picked" clearable filterable />
          </div>
          <p class="geo-area__hint geo-area__value">
            <span>{{ t('geo.area.value') }}</span>
            <code class="geo-area__code">{{ picked?.length ? picked.join(', ') : '—' }}</code>
          </p>
        </el-card>
      </div>
    </div>
  </div>
</template>

<style scoped>
.geo-area {
  display: grid;
  grid-template-columns: minmax(320px, 1fr) minmax(360px, 440px);
  gap: 16px;
  align-items: start;
}
.geo-area__side {
  display: grid;
  gap: 16px;
}
.geo-area__title {
  margin: 0 0 12px;
  font-size: 15px;
  font-weight: 600;
  color: var(--qw-text);
}
.geo-area__tree {
  max-height: calc(100vh - 240px);
  overflow: auto;
}
.geo-area__node {
  display: inline-flex;
  gap: 8px;
  align-items: baseline;
}
.geo-area__code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  color: var(--qw-text-3);
}
.geo-area__lookup-row {
  display: flex;
  gap: 8px;
  width: 100%;
}
.geo-area__place {
  display: flex;
  gap: 6px;
  align-items: center;
  margin: 4px 0 12px;
  font-size: 16px;
  font-weight: 600;
  color: var(--qw-text);
}
.geo-area__place--unknown {
  color: var(--qw-text-3);
}
.geo-area__hint {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--qw-text-3);
}
.geo-area__value {
  display: flex;
  gap: 8px;
  align-items: baseline;
  margin: 12px 0 0;
}
.geo-area__picker :deep(.el-cascader) {
  width: 100%;
}
</style>
