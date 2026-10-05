<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { WfNodeProgress } from '@qiwu/shared'
import { Icon } from '@/core/icons'
import { PROGRESS_ICON } from './tree'

/**
 * A read-only designer card's progress (styles in WfDesigner): its icon, named for screen readers and on
 * hover.
 */
const { of } = defineProps<{ of?: WfNodeProgress }>()
const { t } = useI18n()
const label = computed(() => of && t(`wf.designer.progress.${of}`))
</script>

<template>
  <span v-if="of" class="wf-progress" role="img" :aria-label="label" :title="label">
    <Icon :icon="PROGRESS_ICON[of]" />
  </span>
</template>
