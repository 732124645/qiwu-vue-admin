<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FormInstance } from 'element-plus'
import { wxoaMenuTryMatchBody } from '@qiwu/shared'
import { wxoaMenuApi } from '@/api/platform/wxoa/menu'
import { toastRest } from '@/core/composables/use-crud'
import EmptyState from '@/core/components/EmptyState.vue'
import { zodRules } from '@/core/form/zod-rules'
import MenuPhone from './MenuPhone.vue'
import { toDraft, type DraftButton, type Slot } from './menu-layout'

/** Which live menu a fan sees (WeChat's own matching), `openDialog(WxoaMenuTryMatch, { accountId })`. */
defineOptions({ name: 'WxoaMenuTryMatch' })
const { accountId } = defineProps<{ accountId: number }>()
const emit = defineEmits<{ cancel: [] }>()
const i18n = useI18n()
const { t } = i18n

const model = reactive({ accountId, userId: '' })
const rules = zodRules(wxoaMenuTryMatchBody, i18n, model)
const formRef = ref<FormInstance>()
const running = ref(false)
const result = ref<DraftButton[] | null>(null)
const slot = ref<Slot | null>(null)

async function run() {
  if (running.value || !(await formRef.value?.validate().catch(() => false))) return
  running.value = true
  try {
    const { buttons } = await wxoaMenuApi.tryMatch(wxoaMenuTryMatchBody.parse(model))
    result.value = toDraft(buttons)
    slot.value = null
  } catch (e) {
    toastRest(e)
  } finally {
    running.value = false
  }
}
</script>

<template>
  <el-form ref="formRef" :model="model" :rules="rules" @submit.prevent="run">
    <el-form-item :label="t('field.wxoa.menu.userId')" prop="userId">
      <div class="try-match__row">
        <el-input v-model="model.userId" maxlength="64" />
        <el-button type="primary" native-type="submit" :loading="running" :disabled="running">
          {{ t('wxoa.menu.tryMatch.run') }}
        </el-button>
      </div>
    </el-form-item>
    <div class="try-match__hint">{{ t('wxoa.menu.tryMatch.hint') }}</div>
  </el-form>
  <div v-if="result" class="try-match__result">
    <MenuPhone v-if="result.length" :buttons="result" :selected="slot" @select="slot = $event" />
    <EmptyState v-else :title="t('wxoa.menu.tryMatch.none')" />
  </div>
  <div class="qw-dialog-footer">
    <el-button @click="emit('cancel')">{{ t('wxoa.menu.close') }}</el-button>
  </div>
</template>

<style scoped>
.try-match__row {
  display: flex;
  gap: 8px;
  width: 100%;
}
.try-match__hint {
  font-size: 12px;
  color: var(--qw-text-3);
}
.try-match__result {
  display: flex;
  justify-content: center;
  margin-top: 16px;
}
</style>
