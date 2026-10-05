<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'

defineOptions({ name: 'RedirectView' })

// /redirect/<path>?<query> → /<path>?<query>: re-enters a page to refresh it (tags "refresh")
const route = useRoute()
void useRouter().replace({
  path: `/${String(route.params.path).replace(/^\/+/, '')}`,
  query: route.query,
})
</script>

<template>
  <div />
</template>
