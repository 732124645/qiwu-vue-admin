<template>
  <slot v-if="hasPerm(perm)" />
</template>

<script setup lang="ts">
import { hasPerm } from '@/core/stores/auth'

// `<QwPerm perm="iam.user.browse">…</QwPerm>` (an array = any of) instead of the web's v-perm: mp-weixin has
// no custom directives. Follows the perms as they reload. Display only: the server enforces every permission.
defineOptions({ options: { virtualHost: true } })
defineProps<{ perm: string | string[] }>()
</script>
