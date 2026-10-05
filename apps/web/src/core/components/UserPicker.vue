<script setup lang="ts">
import { computed, reactive, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { createReusableTemplate, watchDebounced } from '@vueuse/core'
import { PAGE_SIZE_MAX, type DeptTreeNode, type WfUserOption } from '@qiwu/shared'
import { deptApi } from '@/api/platform/iam/dept'
import { userApi } from '@/api/platform/iam/user'
import { wfCenterApi } from '@/api/workflow/center'
import { tx } from '@/core/i18n'
import { Icon } from '@/core/icons'
import EmptyState from './EmptyState.vue'
import TreePanel from './TreePanel.vue'

/**
 * Pick users, a dialog content component (see docs/design-notes.md#layering): departments on the left (one shows its whole
 * subtree), a keyword over username and display name, and on the right the matching enabled users in the
 * caller's data scope (GET /api/iam/users/options, the first PAGE_SIZE_MAX). `source: 'wf'` (process
 * dialogs: transfer, add-sign, cc, the initiator's picks) lists every enabled user instead (GET
 * /api/wf/users/options: id, display name and dept, a keyword over the display name, no department tree), so
 * a staff user (own_rows) can pick a colleague. `multiple` keeps the picks across searches (tags below);
 * single: a click picks, a double click picks and confirms. `selected` = the users picked when it opens.
 * Resolves with the picked users (single: one; `username` only from the iam source):
 * `const users = await openDialog<UserOption[]>(UserPicker, { multiple: true }, { title: () => t('picker.user.title'), width: 880 })`
 */
defineOptions({ name: 'UserPicker' })
type Picked = WfUserOption & { username?: string }
const {
  multiple = false,
  selected = [],
  source = 'iam',
} = defineProps<{
  multiple?: boolean
  selected?: Picked[]
  source?: 'iam' | 'wf'
}>()
const emit = defineEmits<{ done: [users: Picked[]]; cancel: [] }>()
const { t } = useI18n()
const [DefineBody, ReuseBody] = createReusableTemplate()

const depts = shallowRef<DeptTreeNode[]>([])
const deptsLoading = ref(source === 'iam')
if (source === 'iam')
  deptApi
    .tree()
    .then((d) => (depts.value = d))
    .catch(() => undefined) // the request layer showed it; users can still be searched
    .finally(() => (deptsLoading.value = false))
const deptLabel = (d: DeptTreeNode) => tx(d.name)

const deptId = ref<number | null>(null)
const keyword = ref('')
const rows = shallowRef<Picked[]>([])
const loading = ref(false)
let seq = 0
async function load() {
  const mine = ++seq
  loading.value = true
  try {
    const kw = keyword.value.trim() || undefined
    const list: Picked[] =
      source === 'wf'
        ? await wfCenterApi.userOptions({ keyword: kw })
        : await userApi.options({ deptId: deptId.value ?? undefined, keyword: kw })
    if (mine === seq) rows.value = list
  } catch {
    if (mine === seq) rows.value = [] // the request layer showed why
  } finally {
    if (mine === seq) loading.value = false
  }
}
void load()
watch(deptId, load)
watchDebounced(keyword, load, { debounce: 300 })

/** picked users by id, in picking order */
const picked = reactive(new Map<number, Picked>(selected.map((u) => [u.id, u])))
function choose(u: Picked) {
  if (multiple && picked.has(u.id)) picked.delete(u.id)
  else {
    if (!multiple) picked.clear()
    picked.set(u.id, u)
  }
}
const allPicked = computed(() => rows.value.length > 0 && rows.value.every((r) => picked.has(r.id)))
const somePicked = computed(() => !allPicked.value && rows.value.some((r) => picked.has(r.id)))
function pickAll(on: boolean) {
  for (const r of rows.value) {
    if (on) picked.set(r.id, r)
    else picked.delete(r.id)
  }
}

function confirm() {
  if (picked.size) emit('done', [...picked.values()])
}
function chooseAndConfirm(u: Picked) {
  if (multiple) return
  choose(u)
  confirm()
}
</script>

<template>
  <!-- the keyword and the users: beside the department tree, or alone (source wf) -->
  <DefineBody>
    <el-input
      v-model="keyword"
      name="keyword"
      clearable
      :placeholder="t(source === 'wf' ? 'picker.user.nameKeyword' : 'picker.user.keyword')"
      :aria-label="t('field.iam.user.keyword')"
    >
      <template #prefix><Icon icon="lucide:search" /></template>
    </el-input>
    <el-table
      v-loading="loading"
      :data="rows"
      row-key="id"
      height="360"
      :highlight-current-row="!multiple"
      :current-row-key="multiple ? undefined : [...picked.keys()][0]"
      @row-click="choose"
      @row-dblclick="chooseAndConfirm"
    >
      <el-table-column width="48">
        <template v-if="multiple" #header>
          <el-checkbox
            :model-value="allPicked"
            :indeterminate="somePicked"
            :disabled="!rows.length"
            :aria-label="t('picker.user.pickAll')"
            @change="pickAll(!!$event)"
          />
        </template>
        <template #default="{ row }">
          <el-checkbox
            v-if="multiple"
            :model-value="picked.has(row.id)"
            :aria-label="row.displayName"
            @click.stop
            @change="choose(row)"
          />
          <el-radio
            v-else
            :model-value="picked.has(row.id)"
            :value="true"
            @click.stop
            @change="choose(row)"
          >
            <span class="user-picker__radio-name">{{ row.displayName }}</span>
          </el-radio>
        </template>
      </el-table-column>
      <el-table-column
        prop="displayName"
        :label="t('field.iam.user.displayName')"
        min-width="120"
        show-overflow-tooltip
      />
      <el-table-column
        v-if="source === 'iam'"
        prop="username"
        :label="t('field.iam.user.username')"
        min-width="120"
        show-overflow-tooltip
      />
      <el-table-column :label="t('field.iam.user.deptName')" min-width="120" show-overflow-tooltip>
        <template #default="{ row }">{{ row.deptName ? tx(row.deptName) : '' }}</template>
      </el-table-column>
      <template #empty>
        <EmptyState
          v-if="keyword.trim() || deptId"
          :title="t('common.empty.noMatch')"
          :description="t('common.empty.noMatchHint')"
        />
        <EmptyState v-else />
      </template>
    </el-table>
    <p v-if="rows.length >= PAGE_SIZE_MAX" class="user-picker__hint">
      {{ t('picker.user.truncated', { count: PAGE_SIZE_MAX }) }}
    </p>
  </DefineBody>
  <TreePanel
    v-if="source === 'iam'"
    v-model="deptId"
    class="user-picker"
    :data="depts"
    :label="deptLabel"
    :title="t('picker.dept.title')"
    storage-key="user-picker"
    :loading="deptsLoading"
  >
    <ReuseBody />
  </TreePanel>
  <div v-else class="user-picker user-picker--flat"><ReuseBody /></div>
  <div class="user-picker__picked" aria-live="polite">
    <span class="user-picker__count">{{ t('picker.user.picked', picked.size) }}</span>
    <el-tag
      v-for="u in picked.values()"
      :key="u.id"
      closable
      disable-transitions
      :title="u.username"
      @close="picked.delete(u.id)"
    >
      {{ u.displayName }}
    </el-tag>
    <el-button v-if="multiple && picked.size > 1" link type="primary" @click="picked.clear()">
      {{ t('picker.user.clear') }}
    </el-button>
  </div>
  <div class="qw-dialog-footer">
    <el-button @click="emit('cancel')">{{ t('common.action.cancel') }}</el-button>
    <el-button type="primary" :disabled="!picked.size" @click="confirm">
      {{ t('picker.user.confirm') }}
    </el-button>
  </div>
</template>

<style scoped>
/* no department tree: the keyword above the users, as in TreePanel's main column */
.user-picker--flat {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.user-picker__hint {
  margin: 0;
  font-size: 12px;
  color: var(--qw-text-3);
}
.user-picker__picked {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  min-height: 32px;
  margin-top: 16px;
}
.user-picker__count {
  font-size: 13px;
  color: var(--qw-text-2);
}
/* the radio's name is for screen readers; the row shows it */
.user-picker__radio-name {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
