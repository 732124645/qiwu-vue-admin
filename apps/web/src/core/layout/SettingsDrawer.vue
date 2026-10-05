<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { THEME_PRESETS, useAppStore, type LayoutMode, type SideTheme } from '@/core/stores/app'
import { useTagsStore } from '@/core/stores/tags'

/** Page settings (see docs/design-notes.md#layering), saved in this browser: layout, colors, header parts, tab bar. */
const open = defineModel<boolean>({ required: true })

const { t } = useI18n()
const app = useAppStore()
const tags = useTagsStore()

const LAYOUTS: LayoutMode[] = ['side', 'top', 'mix']
const SIDE_THEMES: SideTheme[] = ['dark', 'light']
const SWITCHES = [
  'grey',
  'watermark',
  'fixedHeader',
  'showLogo',
  'showFooter',
  'dynamicTitle',
] as const
</script>

<template>
  <el-drawer
    v-model="open"
    :title="t('layout.settings.title')"
    size="300px"
    class="settings-drawer"
  >
    <el-form label-position="top">
      <el-form-item :label="t('layout.settings.layout')">
        <el-radio-group v-model="app.settings.layout">
          <el-radio-button v-for="l in LAYOUTS" :key="l" :value="l">
            {{ t(`layout.settings.layouts.${l}`) }}
          </el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item :label="t('layout.settings.sideTheme')">
        <el-radio-group
          v-model="app.settings.sideTheme"
          :aria-label="t('layout.settings.sideTheme')"
        >
          <el-radio-button v-for="theme in SIDE_THEMES" :key="theme" :value="theme">
            {{ t(`layout.settings.sideThemes.${theme}`) }}
          </el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item :label="t('layout.settings.primary')">
        <el-color-picker
          v-model="app.settings.primary"
          :predefine="THEME_PRESETS"
          :clearable="false"
          :aria-label="t('layout.settings.primary')"
        />
      </el-form-item>
      <el-form-item :label="t('layout.settings.interface')" class="settings-drawer__switches">
        <el-switch
          v-model="app.dark"
          :active-text="t('layout.settings.dark')"
          :aria-label="t('layout.settings.dark')"
        />
        <el-switch
          v-for="s in SWITCHES"
          :key="s"
          v-model="app.settings[s]"
          :active-text="t(`layout.settings.${s}`)"
          :aria-label="t(`layout.settings.${s}`)"
        />
      </el-form-item>
      <el-form-item :label="t('common.tags.settings')" class="settings-drawer__switches">
        <el-radio-group v-model="tags.style" :aria-label="t('common.tags.style')">
          <el-radio-button value="card">{{ t('common.tags.styleCard') }}</el-radio-button>
          <el-radio-button value="chrome">{{ t('common.tags.styleChrome') }}</el-radio-button>
        </el-radio-group>
        <el-switch
          v-model="tags.persist"
          :active-text="t('common.tags.persist')"
          :aria-label="t('common.tags.persist')"
        />
      </el-form-item>
    </el-form>
  </el-drawer>
</template>
