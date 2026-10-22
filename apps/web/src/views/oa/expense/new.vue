<script setup lang="ts">
import OaRequestNew from '../components/OaRequestNew.vue'
import Form from './form.vue'
defineOptions({ name: 'OaExpenseNew' })
</script>
<template><OaRequestNew kind="expense" :form="Form" /></template>
