<script setup lang="ts">
import OaRequestNew from '../components/OaRequestNew.vue'
import Form from './form.vue'
defineOptions({ name: 'OaSealNew' })
</script>
<template><OaRequestNew kind="seal" :form="Form" /></template>
