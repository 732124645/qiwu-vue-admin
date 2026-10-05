<script setup lang="ts">
import { ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import type { GeoAreaNode } from '@qiwu/shared'
import { geoApi } from '@/api/platform/geo'

/**
 * Area picker (see docs/design-notes.md#layering) over GET /api/geo/areas/tree (province → city → county, loaded once per page
 * load): `v-model` = the picked path of 6-digit codes, e.g. `['110000', '110100', '110101']`, null once
 * cleared. Names are Chinese only (the data set has no other language). Other attributes (`clearable`,
 * `filterable`, `disabled`, `placeholder`, …) go to the el-cascader.
 */
defineOptions({ name: 'AreaCascader' })
const model = defineModel<string[] | null>()
const { t } = useI18n()

const options = shallowRef<GeoAreaNode[]>([])
const loading = ref(true)
geoApi
  .tree()
  .then((tree) => (options.value = tree))
  .catch(() => undefined) // the request layer showed it; the picker stays empty
  .finally(() => (loading.value = false))

const fields = { value: 'code', label: 'name', children: 'children' }
</script>

<template>
  <el-cascader
    v-model="model"
    :options
    :props="fields"
    :placeholder="loading ? t('picker.area.loading') : t('picker.area.placeholder')"
  />
</template>
