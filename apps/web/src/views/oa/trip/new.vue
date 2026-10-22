<script setup lang="ts">
import OaRequestNew from '../components/OaRequestNew.vue'
import Form from './form.vue'
defineOptions({ name: 'OaTripNew' })
</script>
<template><OaRequestNew kind="trip" :form="Form" /></template>
