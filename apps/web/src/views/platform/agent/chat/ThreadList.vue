<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDebounceFn } from '@vueuse/core'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { AgentThreadVo } from '@qiwu/shared'
import { agentApi } from '@/api/platform/agent'
import IconButton from '@/core/components/IconButton.vue'
import { toastRest } from '@/core/composables/use-crud'
import { Icon } from '@/core/icons'
import { groupThreads } from './thread-state'

/**
 * 左侧会话列表：新建、全文搜索（标题与消息）、视图（全部 / 进行中 / 未读 / 置顶）、未读数、置顶、
 * 行内改名、归档 / 恢复、确认后删除、全部标为已读，置顶的在最前，其余按今天 / 最近 7 天 / 更早分组，分页加载更多。
 * 列表数据归它自己，页面通过 `upsert` / `patch` 告诉它新建、分叉或状态变化的会话，`has` 判断是否已列出，
 * `refresh` 防抖地重读第 1 页（推送来未列出的会话、轮次状态变化、断线重连后）；临时会话从不列出。
 */
defineOptions({ name: 'AgentThreadList' })
const { activeId = null } = defineProps<{ activeId?: number | null }>()
const emit = defineEmits<{ open: [thread: AgentThreadVo]; create: []; gone: [id: number] }>()
const { t } = useI18n()

const PAGE_SIZE = 30
const threads = shallowRef<AgentThreadVo[]>([])
const total = ref(0)
const page = ref(1)
const keyword = ref('')
const archived = ref(false)
const VIEWS = ['all', 'active', 'unread', 'pinned'] as const
const view = ref<(typeof VIEWS)[number]>('all')
const loading = ref(false)
let seq = 0

/** 读第 `page` 页；第 1 页替换列表，之后的页接在后面。 */
async function load(next = 1) {
  const mine = ++seq
  loading.value = true
  try {
    const res = await agentApi.threads({
      page: next,
      pageSize: PAGE_SIZE,
      sort: '-lastActiveAt',
      status: archived.value ? 'archived' : 'active',
      view: view.value,
      ...(keyword.value.trim() ? { keyword: keyword.value.trim() } : {}),
    })
    if (mine !== seq) return
    const known =
      next === 1 ? [] : threads.value.filter((x) => !res.items.some((y) => y.id === x.id))
    threads.value = [...known, ...res.items]
    total.value = res.total
    page.value = next
  } catch (e) {
    if (mine === seq) toastRest(e)
  } finally {
    if (mine === seq) loading.value = false
  }
}
const search = useDebounceFn(() => load(1), 300)
// 卸载后不再补发延迟的重读
let alive = true
onBeforeUnmount(() => (alive = false))
const refresh = useDebounceFn(() => alive && load(1), 1000)
const groups = computed(() => groupThreads(threads.value))

/** 新建、分叉或推送更新的会话：已在列表里的替换，属于当前视图的新会话放到最前面。 */
function upsert(th: AgentThreadVo) {
  const at = threads.value.findIndex((x) => x.id === th.id)
  const fits =
    !th.temporary &&
    th.status === (archived.value ? 'archived' : 'active') &&
    (view.value !== 'pinned' || th.pinned)
  if (at >= 0) {
    const next = threads.value.slice()
    if (fits) next[at] = th
    else next.splice(at, 1)
    threads.value = next
  } else if (fits) {
    threads.value = [th, ...threads.value]
    total.value++
  }
}
/** 只改列表里某个会话的几个字段（例如推送来的轮次状态）。 */
function patch(id: number, p: Partial<AgentThreadVo>) {
  const th = threads.value.find((x) => x.id === id)
  if (th) upsert({ ...th, ...p })
}

// 行内改名
const editing = ref<number | null>(null)
const title = ref('')
const saving = ref(false)
async function startRename(th: AgentThreadVo) {
  editing.value = th.id
  title.value = th.title
  await nextTick()
  document.querySelector<HTMLInputElement>('.agent-threads__rename input')?.focus()
}
/** 保存新标题；空标题或未改动直接退出编辑。 */
async function saveRename(th: AgentThreadVo) {
  const text = title.value.trim()
  if (saving.value || editing.value !== th.id) return
  if (!text || text === th.title) {
    editing.value = null
    return
  }
  saving.value = true
  try {
    upsert(await agentApi.updateThread(th.id, { title: text }))
    editing.value = null
  } catch (e) {
    toastRest(e)
  } finally {
    saving.value = false
  }
}

/** 置顶或取消置顶。 */
async function togglePin(th: AgentThreadVo) {
  try {
    upsert(await agentApi.updateThread(th.id, { pinned: !th.pinned }))
  } catch (e) {
    toastRest(e)
  }
}

/** 归档或恢复：离开当前视图，打开着的会话由页面关掉。 */
async function toggleArchive(th: AgentThreadVo) {
  try {
    const next = await agentApi.updateThread(th.id, {
      status: th.status === 'archived' ? 'active' : 'archived',
    })
    upsert(next)
    ElMessage.success(
      t(`agent.chat.thread.${next.status === 'archived' ? 'archived' : 'restored'}`),
    )
    emit('gone', th.id)
  } catch (e) {
    toastRest(e)
  }
}

/** 确认后删除会话（连同其中的全部消息）。 */
async function remove(th: AgentThreadVo) {
  try {
    await ElMessageBox.confirm(
      t('agent.chat.thread.removeConfirm', { title: th.title }),
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
    await agentApi.removeThread(th.id)
    threads.value = threads.value.filter((x) => x.id !== th.id)
    total.value--
    ElMessage.success(t('crud.msg.deleted'))
    emit('gone', th.id)
  } catch (e) {
    toastRest(e)
  }
}

type Command = 'rename' | 'pin' | 'archive' | 'remove'
function onCommand(th: AgentThreadVo, cmd: Command) {
  if (cmd === 'rename') void startRename(th)
  else if (cmd === 'pin') void togglePin(th)
  else if (cmd === 'archive') void toggleArchive(th)
  else void remove(th)
}

/** 全部标为已读：请求进行中按钮加载并禁用；成功后列表里的未读数清零。 */
const readingAll = ref(false)
async function readAll() {
  if (readingAll.value) return
  readingAll.value = true
  try {
    await agentApi.readAll()
    threads.value = threads.value.map((x) => (x.unread ? { ...x, unread: 0 } : x))
    if (view.value === 'unread') void load(1)
  } catch (e) {
    toastRest(e)
  } finally {
    readingAll.value = false
  }
}

const has = (id: number) => threads.value.some((x) => x.id === id)
/** 某个会话里的未读数（推送来的新条目）加 1；不在列表里的忽略。 */
function bumpUnread(id: number) {
  const th = threads.value.find((x) => x.id === id)
  if (th) upsert({ ...th, unread: th.unread + 1 })
}
void load(1)
defineExpose({ load, refresh, upsert, patch, has, bumpUnread })
</script>

<template>
  <aside class="agent-threads" :aria-label="t('agent.chat.thread.list')">
    <el-button type="primary" class="agent-threads__new" @click="emit('create')">
      {{ t('agent.chat.thread.new') }}
    </el-button>
    <el-input
      v-model="keyword"
      clearable
      :aria-label="t('agent.chat.thread.search')"
      :placeholder="t('agent.chat.thread.searchHint')"
      @input="search"
      @clear="load(1)"
    />
    <el-radio-group
      v-model="view"
      size="small"
      class="agent-threads__views"
      :aria-label="t('agent.chat.thread.view.label')"
      @change="load(1)"
    >
      <el-radio-button v-for="v in VIEWS" :key="v" :value="v">{{
        t(`agent.chat.thread.view.${v}`)
      }}</el-radio-button>
    </el-radio-group>
    <div class="agent-threads__filters">
      <el-checkbox v-model="archived" @change="load(1)">{{
        t('agent.chat.thread.showArchived')
      }}</el-checkbox>
      <el-button
        link
        type="primary"
        class="agent-threads__read-all"
        :loading="readingAll"
        :disabled="readingAll"
        @click="readAll"
      >
        {{ t('agent.chat.thread.readAll') }}
      </el-button>
    </div>
    <div v-loading="loading" class="agent-threads__scroll">
      <section v-for="g in groups" :key="g.key" class="agent-threads__group">
        <h3 class="agent-threads__label">{{ t(`agent.chat.thread.group.${g.key}`) }}</h3>
        <ul class="agent-threads__list">
          <li
            v-for="th in g.threads"
            :key="th.id"
            class="agent-threads__row"
            :class="{ 'is-active': th.id === activeId }"
          >
            <el-input
              v-if="editing === th.id"
              v-model="title"
              class="agent-threads__rename"
              maxlength="200"
              :disabled="saving"
              :aria-label="t('agent.chat.thread.rename')"
              @keydown.enter.prevent="saveRename(th)"
              @keydown.esc.prevent="editing = null"
              @blur="saveRename(th)"
            />
            <button
              v-else
              type="button"
              class="agent-threads__open"
              :aria-current="th.id === activeId ? 'true' : undefined"
              @click="emit('open', th)"
            >
              <Icon
                v-if="th.pinned"
                icon="lucide:pin"
                class="agent-threads__pin"
                :aria-label="t('agent.chat.thread.pinned')"
              />
              <span class="agent-threads__title">{{
                th.title || t('agent.chat.thread.untitled')
              }}</span>
              <span
                v-if="th.unread > 0 && th.id !== activeId"
                class="agent-threads__unread"
                :aria-label="t('agent.chat.thread.unread', { n: th.unread })"
              >
                {{ th.unread > 99 ? '99+' : th.unread }}
              </span>
              <span
                v-if="th.turnStatus === 'running' || th.turnStatus === 'waiting'"
                class="agent-threads__status"
              >
                {{ t(`agent.chat.turn.${th.turnStatus}`) }}
              </span>
            </button>
            <el-dropdown trigger="click" @command="(c: Command) => onCommand(th, c)">
              <IconButton
                icon="lucide:ellipsis"
                :label="t('agent.chat.thread.actions', { title: th.title })"
              />
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="rename">{{
                    t('agent.chat.thread.rename')
                  }}</el-dropdown-item>
                  <el-dropdown-item command="pin">
                    {{ t(`agent.chat.thread.${th.pinned ? 'unpin' : 'pin'}`) }}
                  </el-dropdown-item>
                  <el-dropdown-item command="archive">
                    {{ t(`agent.chat.thread.${th.status === 'archived' ? 'restore' : 'archive'}`) }}
                  </el-dropdown-item>
                  <el-dropdown-item command="remove">{{
                    t('crud.action.delete')
                  }}</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </li>
        </ul>
      </section>
      <p v-if="!loading && !threads.length" class="agent-card__meta">
        {{ t('agent.chat.thread.empty') }}
      </p>
      <el-button v-if="threads.length < total" link type="primary" @click="load(page + 1)">
        {{ t('agent.chat.thread.more') }}
      </el-button>
    </div>
  </aside>
</template>
