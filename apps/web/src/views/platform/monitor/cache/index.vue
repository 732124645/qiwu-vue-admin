<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  CACHE_SCAN_MAX,
  monitorPerms,
  type CacheKeysVo,
  type CacheNamespaceVo,
  type CacheValueVo,
} from '@qiwu/shared'
import { monitorApi } from '@/api/platform/monitor'
import CodeViewer from '@/core/components/CodeViewer.vue'
import EmptyState from '@/core/components/EmptyState.vue'
import IconButton from '@/core/components/IconButton.vue'
import { Icon } from '@/core/icons'
import { usePerm } from '@/core/permission'
import { ApiError } from '@/core/request/http'
import { count } from '../format'

// keep-alive name = the seeded menu's component_name
defineOptions({ name: 'MonitorCache' })

const { t, te } = useI18n()
const perm = usePerm()
const canClear = computed(() => perm.has(monitorPerms.cacheClear))
/** a namespace's page label; a namespace the page has no words for yet shows its registry name */
const nsLabel = (name: string) =>
  te(`monitor.cache.ns.${name}`) ? t(`monitor.cache.ns.${name}`) : name

/** 400/404 (a key gone meanwhile) are left to the caller by the request layer; the rest is toasted. */
function showRest(e: unknown) {
  if (e instanceof ApiError && (e.status === 400 || e.status === 404)) ElMessage.error(e.message)
}

const namespaces = shallowRef<CacheNamespaceVo[]>([])
const nsLoading = ref(false)
async function loadNamespaces() {
  nsLoading.value = true
  try {
    namespaces.value = await monitorApi.cacheNamespaces()
  } catch (e) {
    showRest(e)
  } finally {
    nsLoading.value = false
  }
}

const ns = shallowRef<CacheNamespaceVo>()
const keys = shallowRef<CacheKeysVo>()
const keysLoading = ref(false)
const keyword = ref('')
const shownKeys = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  return (keys.value?.keys ?? [])
    .filter((key) => !k || key.toLowerCase().includes(k))
    .map((key) => ({ key }))
})
async function loadKeys() {
  if (!ns.value) return
  const name = ns.value.name
  keysLoading.value = true
  try {
    const next = await monitorApi.cacheKeys(name)
    if (ns.value?.name === name) keys.value = next
  } catch (e) {
    showRest(e)
  } finally {
    keysLoading.value = false
  }
}
function pickNs(row: CacheNamespaceVo) {
  if (ns.value?.name === row.name) return
  ns.value = row
  keys.value = undefined
  value.value = undefined
  keyword.value = ''
  void loadKeys()
}

const value = shallowRef<CacheValueVo>()
const valueLoading = ref(false)
let picked = ''
async function pickKey({ key }: { key: string }) {
  // quick clicks: only the last key picked is shown
  picked = key
  valueLoading.value = true
  try {
    const next = await monitorApi.cacheValue(key)
    if (picked === key) value.value = next
  } catch (e) {
    showRest(e)
  } finally {
    if (picked === key) valueLoading.value = false
  }
}
/** strings that hold JSON (most cached values) and structured values, pretty-printed */
const pretty = computed(() => {
  const v = value.value?.value
  if (typeof v === 'string') {
    try {
      return JSON.stringify(JSON.parse(v), null, 2)
    } catch {
      return v
    }
  }
  return JSON.stringify(v, null, 2) ?? ''
})
const valueFiles = computed(() => [{ path: 'value.json', content: pretty.value, language: 'json' }])

const clearing = ref(false)
/** Confirms, deletes, reports how many keys went, then reloads the keys shown. */
async function clear(message: string, del: () => Promise<{ deleted: number }>) {
  try {
    await ElMessageBox.confirm(message, t('crud.confirm.title'), {
      type: 'warning',
      confirmButtonText: t('crud.action.delete'),
      cancelButtonText: t('common.action.cancel'),
    })
  } catch {
    return
  }
  clearing.value = true
  try {
    const { deleted } = await del()
    ElMessage.success(t('monitor.cache.cleared', { count: deleted }))
    value.value = undefined
  } catch (e) {
    showRest(e)
  } finally {
    await loadKeys()
    clearing.value = false
  }
}
const clearNs = (row: CacheNamespaceVo) =>
  clear(t('monitor.cache.clearNsConfirm', { name: nsLabel(row.name) }), () =>
    monitorApi.cacheClear({ ns: row.name }),
  )
const clearKey = (key: string) =>
  clear(t('monitor.cache.clearKeyConfirm', { key }), () => monitorApi.cacheClear({ key }))
const clearAll = () => clear(t('monitor.cache.clearAllConfirm'), monitorApi.cacheClearAll)

function refresh() {
  void loadNamespaces()
  void loadKeys()
}
void loadNamespaces()
</script>

<template>
  <div class="qw-page">
    <div class="qw-page-bar">
      <el-button
        v-perm="monitorPerms.cacheClear"
        type="danger"
        plain
        :loading="clearing"
        @click="clearAll"
      >
        <el-icon class="el-icon--left"><Icon icon="lucide:trash-2" /></el-icon>
        {{ t('monitor.cache.clearAll') }}
      </el-button>
      <IconButton icon="lucide:refresh-cw" :label="t('crud.action.refresh')" @click="refresh" />
    </div>

    <div class="cache-monitor">
      <el-card class="qw-table-panel cache-monitor__ns">
        <h2 class="cache-monitor__title">{{ t('field.monitor.cache.ns') }}</h2>
        <el-table
          v-loading="nsLoading"
          :data="namespaces"
          row-key="name"
          :show-header="false"
          highlight-current-row
          class="cache-monitor__ns-table"
          @row-click="pickNs"
        >
          <el-table-column :label="t('field.monitor.cache.name')" min-width="150">
            <template #default="{ row }">
              <span class="cache-monitor__ns-name">
                {{ nsLabel(row.name) }}
                <Icon
                  v-if="row.masked"
                  icon="lucide:eye-off"
                  class="cache-monitor__muted"
                  role="img"
                  :aria-label="t('field.monitor.cache.masked')"
                />
              </span>
              <span class="cache-monitor__mono cache-monitor__muted">{{ row.prefix }}</span>
            </template>
          </el-table-column>
          <el-table-column
            v-if="canClear"
            :label="t('crud.action.operations')"
            width="96"
            align="right"
          >
            <template #default="{ row }">
              <el-button
                v-if="row.clearable"
                link
                type="danger"
                :disabled="clearing"
                @click.stop="clearNs(row)"
              >
                {{ t('monitor.cache.clear') }}
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <el-card class="qw-table-panel cache-monitor__keys">
        <h2 class="cache-monitor__title">
          {{
            ns
              ? t('monitor.cache.keysOf', { name: nsLabel(ns.name) })
              : t('field.monitor.cache.keys')
          }}
          <span v-if="keys" class="cache-monitor__muted">{{ count(keys.keys.length) }}</span>
        </h2>
        <template v-if="ns">
          <div class="cache-monitor__filter">
            <el-input
              v-model="keyword"
              name="keyword"
              clearable
              :placeholder="t('monitor.cache.filter')"
              :aria-label="t('monitor.cache.filter')"
            >
              <template #prefix><Icon icon="lucide:search" /></template>
            </el-input>
            <el-alert
              v-if="keys?.truncated"
              type="warning"
              :closable="false"
              show-icon
              :title="t('monitor.cache.truncated', { max: count(CACHE_SCAN_MAX) })"
            />
          </div>
          <el-table
            v-loading="keysLoading"
            :data="shownKeys"
            row-key="key"
            highlight-current-row
            max-height="560"
            @row-click="pickKey"
          >
            <el-table-column :label="t('field.monitor.cache.key')" show-overflow-tooltip>
              <template #default="{ row }">
                <span class="cache-monitor__mono">{{ row.key }}</span>
              </template>
            </el-table-column>
            <el-table-column
              v-if="ns.clearable && canClear"
              :label="t('crud.action.operations')"
              width="96"
              align="right"
            >
              <template #default="{ row }">
                <el-button link type="danger" :disabled="clearing" @click.stop="clearKey(row.key)">
                  {{ t('crud.action.delete') }}
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </template>
        <EmptyState v-else :title="t('monitor.cache.pickNs')" />
      </el-card>

      <el-card v-loading="valueLoading" class="cache-monitor__value">
        <h2 class="cache-monitor__title">{{ t('field.monitor.cache.value') }}</h2>
        <template v-if="value">
          <el-descriptions :column="1" border>
            <el-descriptions-item :label="t('field.monitor.cache.key')">
              <span class="cache-monitor__mono">{{ value.key }}</span>
            </el-descriptions-item>
            <el-descriptions-item :label="t('field.monitor.cache.type')">
              {{ value.type }}
            </el-descriptions-item>
            <el-descriptions-item :label="t('field.monitor.cache.ttl')">
              {{ value.ttl < 0 ? t('monitor.cache.noExpiry') : count(value.ttl) }}
            </el-descriptions-item>
          </el-descriptions>
          <p v-if="value.masked" class="cache-monitor__masked">
            <Icon icon="lucide:eye-off" /> {{ t('monitor.cache.maskedHint') }}
          </p>
          <CodeViewer
            v-else
            class="cache-monitor__json"
            :files="valueFiles"
            height="min(320px, 50vh)"
          />
        </template>
        <EmptyState v-else :title="t('monitor.cache.pickKey')" />
      </el-card>
    </div>
  </div>
</template>

<style scoped>
.cache-monitor {
  display: grid;
  grid-template-columns: minmax(260px, 320px) minmax(300px, 1fr) minmax(320px, 1.2fr);
  gap: 16px;
  align-items: start;
}
.cache-monitor__title {
  display: flex;
  gap: 8px;
  align-items: baseline;
  margin: 0 0 12px;
  font-size: 15px;
  font-weight: 600;
  color: var(--qw-text);
}
.qw-table-panel .cache-monitor__title {
  padding: 16px 16px 0;
}
.cache-monitor__ns-table :deep(.el-table__row) {
  cursor: pointer;
}
.cache-monitor__keys :deep(.el-table__row) {
  cursor: pointer;
}
.cache-monitor__ns-name {
  display: flex;
  gap: 6px;
  align-items: center;
  color: var(--qw-text);
}
.cache-monitor__mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.cache-monitor__muted {
  font-size: 12px;
  font-weight: 400;
  color: var(--qw-text-3);
}
.cache-monitor__filter {
  display: grid;
  gap: 8px;
  padding: 0 16px 12px;
}
.cache-monitor__masked {
  display: flex;
  gap: 6px;
  align-items: center;
  margin: 12px 0 0;
  color: var(--qw-text-3);
}
.cache-monitor__json {
  margin: 12px 0 0;
}
</style>
