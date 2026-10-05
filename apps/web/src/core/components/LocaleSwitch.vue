<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { Locale } from '@qiwu/shared'
import { Icon } from '@/core/icons'
import { useLocaleStore } from '@/core/stores/locale'
import IconButton from './IconButton.vue'

/** Language menu: the current language as text, or only an icon (`icon`, header toolbar). */
const { icon = false } = defineProps<{ icon?: boolean }>()
const { t } = useI18n()
const locale = useLocaleStore()

const LANGUAGE: Record<Locale, string> = {
  'zh-CN': 'common.language.zhCN',
  'en-US': 'common.language.enUS',
}
</script>

<template>
  <el-dropdown trigger="click" @command="locale.set">
    <IconButton v-if="icon" icon="lucide:languages" :label="t('common.layout.language')" />
    <el-button v-else text :aria-label="t('common.layout.language')">
      <el-icon class="el-icon--left"><Icon icon="lucide:languages" /></el-icon>
      {{ t(LANGUAGE[locale.locale]) }}
      <el-icon class="el-icon--right"><Icon icon="lucide:chevron-down" /></el-icon>
    </el-button>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item
          v-for="l in locale.locales"
          :key="l"
          :command="l"
          :disabled="l === locale.locale"
          :lang="l"
        >
          {{ t(LANGUAGE[l]) }}
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>
