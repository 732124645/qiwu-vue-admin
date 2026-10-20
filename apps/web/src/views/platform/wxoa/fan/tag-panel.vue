<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import { WXOA_TAGS_MAX, wxoaPerms, wxoaTagUpdate, type WxoaTagVo } from '@qiwu/shared'
import { wxoaTagApi } from '@/api/platform/wxoa/tag'
import IconButton from '@/core/components/IconButton.vue'
import { toastRest } from '@/core/composables/use-crud'
import { openDialog } from '@/core/dialog'
import { usePerm } from '@/core/permission'
import WxoaTextForm from './text-form.vue'

/**
 * The account's fan tags beside the fan list: `v-model` = the WeChat tag id the list is filtered by
 * (`null` = all fans; picking the chosen tag again clears it). Adds, renames, deletes and syncs tags on
 * WeChat, then emits `changed` (the page reloads the tags and the fans).
 */
defineOptions({ name: 'WxoaTagPanel' })
const { accountId, tags, loading } = defineProps<{
  accountId: number
  tags: WxoaTagVo[]
  loading: boolean
}>()
const model = defineModel<number | null>({ default: null })
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const perm = usePerm()
const perms = wxoaPerms.tag
const can = computed(() => ({
  create: perm.has(perms.create),
  modify: perm.has(perms.modify),
  remove: perm.has(perms.remove),
  sync: perm.has(wxoaPerms.fan.sync),
}))
const full = computed(() => tags.length >= WXOA_TAGS_MAX)

const pick = (tagId: number | null) => (model.value = model.value === tagId ? null : tagId)

async function openForm(tag?: WxoaTagVo) {
  const saved = await openDialog(
    WxoaTextForm,
    {
      schema: wxoaTagUpdate,
      prop: 'name',
      value: tag?.name,
      maxlength: 30,
      save: (body: { name: string }) =>
        tag ? wxoaTagApi.update(tag.id, body) : wxoaTagApi.create({ accountId, ...body }),
    },
    {
      title: () =>
        t(tag ? 'crud.title.edit' : 'crud.title.create', { name: t('wxoa.fan.tags.entity') }),
    },
  )
  if (!saved) return
  ElMessage.success(t(tag ? 'crud.msg.updated' : 'crud.msg.created'))
  emit('changed')
}

async function remove(tag: WxoaTagVo) {
  try {
    await ElMessageBox.confirm(
      t('wxoa.fan.tags.removeConfirm', { name: tag.name }),
      t('crud.confirm.title'),
      {
        type: 'warning',
        confirmButtonText: t('crud.action.delete'),
        cancelButtonText: t('common.action.cancel'),
      },
    )
  } catch {
    return
  }
  try {
    await wxoaTagApi.remove(tag.id)
  } catch (e) {
    toastRest(e)
    return
  }
  ElMessage.success(t('crud.msg.deleted'))
  if (model.value === tag.tagId) model.value = null
  emit('changed')
}

const syncing = ref(false)
async function sync() {
  if (syncing.value) return
  syncing.value = true
  try {
    await wxoaTagApi.sync(accountId)
    ElMessage.success(t('wxoa.fan.tags.synced'))
    emit('changed')
  } catch (e) {
    toastRest(e)
  } finally {
    syncing.value = false
  }
}
</script>

<template>
  <aside class="wxoa-tags" :aria-label="t('wxoa.fan.tags.title')">
    <div class="wxoa-tags__head">
      <span class="wxoa-tags__title">{{ t('wxoa.fan.tags.title') }}</span>
      <IconButton
        v-if="can.sync"
        icon="lucide:refresh-cw"
        :label="t('wxoa.fan.tags.sync')"
        :disabled="syncing"
        @click="sync"
      />
      <IconButton
        v-if="can.create"
        icon="lucide:plus"
        :label="full ? t('wxoa.fan.tags.full', { max: WXOA_TAGS_MAX }) : t('wxoa.fan.tags.add')"
        :disabled="full"
        @click="openForm()"
      />
    </div>
    <ul v-loading="loading || syncing" class="wxoa-tags__list">
      <li class="wxoa-tags__item" :class="{ 'is-active': model == null }">
        <button
          type="button"
          class="wxoa-tags__pick"
          :aria-pressed="model == null"
          @click="model = null"
        >
          <span class="wxoa-tags__name">{{ t('wxoa.fan.tags.all') }}</span>
        </button>
      </li>
      <li
        v-for="tag in tags"
        :key="tag.id"
        class="wxoa-tags__item"
        :class="{ 'is-active': model === tag.tagId }"
      >
        <button
          type="button"
          class="wxoa-tags__pick"
          :aria-pressed="model === tag.tagId"
          @click="pick(tag.tagId)"
        >
          <span class="wxoa-tags__name">{{ tag.name }}</span>
          <span class="wxoa-tags__count">{{ tag.fanCount }}</span>
        </button>
        <IconButton
          v-if="can.modify"
          icon="lucide:pencil"
          :label="`${t('crud.action.edit')} ${tag.name}`"
          @click="openForm(tag)"
        />
        <IconButton
          v-if="can.remove"
          icon="lucide:trash-2"
          :label="`${t('crud.action.delete')} ${tag.name}`"
          @click="remove(tag)"
        />
      </li>
    </ul>
  </aside>
</template>

<style scoped>
.wxoa-tags {
  box-sizing: border-box;
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 8px;
  width: 240px;
  padding: 12px 8px;
  background: var(--qw-surface);
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius);
  box-shadow: var(--qw-shadow-1);
}
.wxoa-tags__head {
  display: flex;
  gap: 4px;
  align-items: center;
  min-height: 32px;
  padding-left: 8px;
}
.wxoa-tags__title {
  flex: 1;
  font-size: 14px;
  font-weight: 600;
  color: var(--qw-text);
}
.wxoa-tags__list {
  min-height: 120px;
  padding: 0;
  margin: 0;
  overflow: auto;
  list-style: none;
}
.wxoa-tags__item {
  display: flex;
  align-items: center;
  border-radius: var(--qw-radius-sm);
}
.wxoa-tags__item:hover {
  background: var(--qw-surface-2);
}
.wxoa-tags__item.is-active {
  color: var(--qw-brand-text);
  background: var(--qw-brand-weak);
}
.wxoa-tags__pick {
  display: flex;
  flex: 1;
  gap: 8px;
  align-items: center;
  min-width: 0;
  height: 32px;
  padding: 0 8px;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 0;
}
.wxoa-tags__name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wxoa-tags__count {
  font-size: 12px;
  color: var(--qw-text-3);
}
</style>
