<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { SocialBindingVo } from '@qiwu/shared'
import { profileApi } from '@/api/platform/iam/profile'
import { toastRest } from '@/core/composables/use-crud'

/**
 * The personal center's sign-in bindings: the WeChat mini program account bound to this user,
 * and its unbinding. Binding itself happens in the mini program (sign in there with WeChat).
 */
const { t } = useI18n()
const items = ref<SocialBindingVo[]>([])
const loading = ref(true)
const busy = ref(false)
const wxMp = computed(() => items.value.find((b) => b.provider === 'wx-mp'))

function load() {
  loading.value = true
  profileApi
    .socials()
    .then(
      (list) => (items.value = list),
      () => undefined,
    ) // the request layer showed it
    .finally(() => (loading.value = false))
}
load()

async function unbind() {
  try {
    await ElMessageBox.confirm(t('profile.socials.unbindConfirm'), t('profile.socials.wxMp'), {
      type: 'warning',
      confirmButtonText: t('profile.socials.unbind'),
      cancelButtonText: t('common.action.cancel'),
    })
  } catch {
    return
  }
  busy.value = true
  try {
    await profileApi.unbindWxMp()
    ElMessage.success(t('profile.socials.unbound'))
    load()
  } catch (e) {
    toastRest(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-loading="loading" class="socials">
    <div class="socials__row">
      <div class="socials__text">
        <div class="socials__name">{{ t('profile.socials.wxMp') }}</div>
        <div class="socials__state">
          <template v-if="wxMp">
            {{ t('profile.socials.boundAt') }}
            <time :datetime="wxMp.boundAt">{{
              dayjs(wxMp.boundAt).format('YYYY-MM-DD HH:mm')
            }}</time>
          </template>
          <template v-else>{{ t('profile.socials.unboundHint') }}</template>
        </div>
      </div>
      <el-button v-if="wxMp" :loading="busy" :disabled="busy" @click="unbind">
        {{ t('profile.socials.unbind') }}
      </el-button>
    </div>
  </div>
</template>

<style scoped>
.socials {
  max-width: 560px;
  padding-top: 8px;
}
.socials__row {
  display: flex;
  gap: 16px;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius);
}
.socials__name {
  font-size: 14px;
  font-weight: 600;
  color: var(--qw-text);
}
.socials__state {
  margin-top: 4px;
  font-size: 13px;
  color: var(--qw-text-3);
}
</style>
