<template><OfficeDocument kind="expense" :business-key="key" /></template>
<script setup lang="ts">
import { ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { t } from '@/core/i18n'
import OfficeDocument from '../office/OfficeDocument.vue'
const key = ref('')
onLoad((query) => {
  key.value = String(query?.id ?? '')
  uni.setNavigationBarTitle({ title: t('oa.expense') })
})
</script>
