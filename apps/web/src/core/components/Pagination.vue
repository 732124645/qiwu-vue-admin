<script setup lang="ts">
import { computed, nextTick } from 'vue'
import { useMediaQuery } from '@vueuse/core'

/**
 * el-pagination bound to a list query: `<Pagination v-model:page="query.page"
 * v-model:page-size="query.pageSize" :total="total" @change="refresh" />`. One `change` per user action
 * (a page-size change that also moves the page emits once); texts follow the Element Plus locale.
 * The total sits left, the controls right; nothing without rows, only the total while one page of the
 * smallest size holds them all, the jumper only past 7 pages.
 */
defineOptions({ name: 'QwPagination' })
const { total } = defineProps<{ total: number }>()
const page = defineModel<number>('page', { required: true })
const pageSize = defineModel<number>('pageSize', { required: true })
const emit = defineEmits<{ change: [] }>()
const narrow = useMediaQuery('(max-width: 767px)')
const SIZES = [10, 20, 50, 100]
const layout = computed(() => {
  if (total <= SIZES[0]!) return 'total'
  if (narrow.value) return 'total, ->, prev, pager, next'
  const jumper = Math.ceil(total / pageSize.value) > 7 ? ', jumper' : ''
  return `total, ->, sizes, prev, pager, next${jumper}`
})

let queued = false
function changed() {
  if (queued) return
  queued = true
  void nextTick(() => {
    queued = false
    emit('change')
  })
}
</script>

<template>
  <el-pagination
    v-if="total > 0"
    v-model:current-page="page"
    v-model:page-size="pageSize"
    class="qw-pagination"
    :total="total"
    :page-sizes="SIZES"
    :layout
    :pager-count="narrow ? 5 : 7"
    background
    @current-change="changed"
    @size-change="changed"
  />
</template>

<style scoped>
.qw-pagination {
  flex-wrap: wrap;
  row-gap: 8px;
  padding: 12px 16px;
}
</style>
