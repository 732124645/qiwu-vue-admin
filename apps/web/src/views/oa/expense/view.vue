<script setup lang="ts">
import OaRequestView from '../components/OaRequestView.vue'
import Form from './form.vue'
defineOptions({ name: 'OaExpenseView' })
defineProps<{ businessKey?: string; readonly?: boolean }>()
</script>
<template>
  <OaRequestView kind="expense" :form="Form" :business-key="businessKey" :readonly="readonly" />
</template>
