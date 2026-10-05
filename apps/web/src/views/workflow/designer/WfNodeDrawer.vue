<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { WfFields } from '@qiwu/shared'
import type { Target } from './tree'
import WfNodeSettings from './WfNodeSettings.vue'

/** WfDesigner's settings drawer for one node or fork path; the form (WfNodeSettings) edits it in place. */
defineOptions({ name: 'WfNodeDrawer' })
const open = defineModel<boolean>({ required: true })
const { target, fields } = defineProps<{ target: Target; fields: WfFields }>()
const { t } = useI18n()
const title = computed(() =>
  t(`wf.designer.drawer.${'node' in target ? target.node.type : 'path'}`),
)
</script>

<template>
  <el-drawer v-model="open" :title size="560px" class="wf-node-drawer">
    <WfNodeSettings :target :fields />
  </el-drawer>
</template>
