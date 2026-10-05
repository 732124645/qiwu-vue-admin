<script setup lang="ts">
import WfWizard from './index.vue'

/**
 * `/wf/wizard/:id` (模型管理's 向导): the wizard over one model under a name of its own, so keep-alive (which
 * matches the route component's name) never keeps it as the cached 新建审批 page, nor it as this one.
 */
defineOptions({ name: 'WfWizardEdit' })
</script>

<template>
  <WfWizard />
</template>
