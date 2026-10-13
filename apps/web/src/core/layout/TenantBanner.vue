<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { tenantApi } from '@/api/platform/iam/tenant'
import { tx } from '@/core/i18n'
import { Icon } from '@/core/icons'
import { useAuthStore } from '@/core/stores/auth'
import { useTagsStore } from '@/core/stores/tags'

/**
 * Shown while a platform user works inside another tenant (`/me.tenant.acting`): says so and offers the way
 * back, the only one (the tenant's own menus hold no tenant management). Leaving reloads the whole page,
 * which drops that tenant's dict cache, kept-alive pages and socket rooms; the tags are persisted, so they
 * are reset first.
 */
const { t } = useI18n()
const auth = useAuthStore()
const tags = useTagsStore()
const acting = computed(() => (auth.tenant?.acting ? auth.tenant : null))
const text = computed(() => t('layout.tenant.banner', { name: tx(acting.value?.name ?? '') }))

const leaving = ref(false)
async function leave() {
  leaving.value = true
  try {
    await tenantApi.leave()
  } catch {
    // toasted by the request layer
    leaving.value = false
    return
  }
  tags.reset()
  location.replace('/')
}
</script>

<template>
  <div v-if="acting" class="tenant-banner" role="status">
    <Icon icon="lucide:shield-alert" class="tenant-banner__icon" />
    <span class="tenant-banner__text" :title="text">{{ text }}</span>
    <el-button size="small" type="warning" :loading="leaving" @click="leave">
      {{ t('layout.tenant.leave') }}
    </el-button>
  </div>
</template>

<style scoped>
.tenant-banner {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  flex: none;
  gap: 8px;
  align-items: center;
  height: 36px;
  padding: 0 16px;
  font-size: 13px;
  color: var(--qw-warning);
  /* the weak tint is see-through in the dark theme: laid over the surface, nothing scrolls through it */
  background: linear-gradient(var(--qw-warning-weak), var(--qw-warning-weak)), var(--qw-surface);
  border-bottom: 1px solid color-mix(in srgb, var(--qw-warning) 30%, transparent);
}
.tenant-banner__icon {
  flex: none;
  font-size: 16px;
}
.tenant-banner__text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
