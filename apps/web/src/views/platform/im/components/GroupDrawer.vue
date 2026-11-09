<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessageBox } from 'element-plus'
import { imLabelChange, type ImMember, type ImRoomDetail } from '@qiwu/shared'
import type { ImRoomRecord } from '@qiwu/shared/im-client'
import { imApi } from '@/api/platform/im'
import { useImStore } from '@/core/im/im-store'
import { useAuthStore } from '@/core/stores/auth'
import { boxButtons } from './im-view'

/**
 * 群设置：成员与角色、改名、加人/移人、设管理员、转让、解散、退群。按钮按本人当前角色显示（群主全部；管理员
 * 改名、加人、移出普通成员；成员只能退群），服务端仍按角色矩阵裁决，拒绝时显示它的说明。
 */
defineOptions({ name: 'ImGroupDrawer' })
const props = defineProps<{ room: ImRoomRecord }>()
const open = defineModel<boolean>({ required: true })
const emit = defineEmits<{ left: [] }>()
const { t } = useI18n()
const im = useImStore()
const auth = useAuthStore()
const members = shallowRef<ImMember[]>([])
const busy = ref(false)
const label = ref('')
const adding = ref<number[]>([])

const roomId = computed(() => props.room.roomId)
const role = computed(() => props.room.detail?.role ?? 'participant')
const closed = computed(() => !!props.room.detail?.closedAt)
const isOwner = computed(() => role.value === 'owner' && !closed.value)
const canManage = computed(
  () => (role.value === 'owner' || role.value === 'moderator') && !closed.value,
)
const me = computed(() => auth.me?.user.id)
const candidates = computed(() => {
  const inside = new Set(members.value.map((m) => m.userId))
  return (im.directory?.users ?? []).filter((u) => !inside.has(u.id))
})
/** 本人能否移出这位成员：群主移任何人，管理员只移普通成员。 */
const canRemove = (m: ImMember) =>
  m.userId !== me.value && canManage.value && (role.value === 'owner' || m.role === 'participant')

async function loadMembers() {
  try {
    members.value = await imApi.members(roomId.value)
  } catch {
    members.value = []
  }
}

watch(open, (shown) => {
  if (!shown) return
  label.value = props.room.detail?.label ?? ''
  adding.value = []
  void loadMembers()
})

/** 跑一个群管理动作：返回的详情直接写进本地，成员列表重读。 */
async function act(run: () => Promise<ImRoomDetail | null>, confirm?: string) {
  if (busy.value) return
  try {
    if (confirm) await ElMessageBox.confirm(confirm, t('im.group.title'), boxButtons())
  } catch {
    return
  }
  busy.value = true
  try {
    const detail = await run()
    if (detail) await im.applyDetail(detail)
    await loadMembers()
  } catch {
    // 接口错误已提示（服务端按角色拒绝时显示它的说明）
  } finally {
    busy.value = false
  }
}

const rename = () =>
  imLabelChange.safeParse({ label: label.value }).success &&
  act(() => imApi.rename(roomId.value, label.value.trim()))
const add = () =>
  adding.value.length &&
  act(async () => {
    const d = await imApi.addMembers(roomId.value, adding.value)
    adding.value = []
    return d
  })
const remove = (m: ImMember) =>
  act(
    () => imApi.removeMember(roomId.value, m.userId),
    t('im.group.confirmRemove', { name: m.displayName }),
  )
const toggleModerator = (m: ImMember) =>
  act(() =>
    imApi.setRole(roomId.value, m.userId, m.role === 'moderator' ? 'participant' : 'moderator'),
  )
const transfer = (m: ImMember) =>
  act(
    () => imApi.transfer(roomId.value, m.userId),
    t('im.group.confirmTransfer', { name: m.displayName }),
  )
const close = () => act(() => imApi.close(roomId.value), t('im.group.confirmClose'))

async function leave() {
  try {
    await ElMessageBox.confirm(t('im.group.confirmLeave'), t('im.group.title'), boxButtons())
  } catch {
    return
  }
  busy.value = true
  try {
    await imApi.leave(roomId.value)
    await im.engine()?.forgetRoom(roomId.value)
    open.value = false
    emit('left')
  } catch {
    // 接口错误已提示（群主有其他成员时须先转让）
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <el-drawer v-model="open" :title="t('im.group.title')" size="380px" append-to-body>
    <div class="im-group">
      <section class="im-group__section">
        <h3 class="im-group__heading">{{ t('im.group.name') }}</h3>
        <div v-if="canManage" class="im-group__row">
          <el-input v-model="label" maxlength="80" :aria-label="t('im.group.name')" />
          <el-button :loading="busy" @click="rename">{{ t('im.group.rename') }}</el-button>
        </div>
        <p v-else class="im-group__label">{{ room.detail?.label }}</p>
      </section>
      <section v-if="canManage" class="im-group__section">
        <h3 class="im-group__heading">{{ t('im.group.add') }}</h3>
        <div class="im-group__row">
          <el-select
            v-model="adding"
            multiple
            filterable
            :placeholder="t('im.group.pickMembers')"
            :aria-label="t('im.group.pickMembers')"
          >
            <el-option v-for="u in candidates" :key="u.id" :label="u.displayName" :value="u.id" />
          </el-select>
          <el-button type="primary" :loading="busy" :disabled="!adding.length" @click="add">{{
            t('im.group.add')
          }}</el-button>
        </div>
      </section>
      <section class="im-group__section">
        <h3 class="im-group__heading">
          {{ t('im.group.memberCount', { count: members.length }) }}
        </h3>
        <ul class="im-group__members" :aria-label="t('im.group.members')">
          <li v-for="m in members" :key="m.userId" class="im-group__member">
            <span class="im-group__member-name">{{ m.displayName }}</span>
            <el-tag v-if="m.role !== 'participant'" size="small">{{
              t(`im.group.role.${m.role}`)
            }}</el-tag>
            <el-tag v-if="!m.enabled" size="small" type="info">{{
              t('im.group.disabledUser')
            }}</el-tag>
            <span class="im-group__actions">
              <el-button
                v-if="isOwner && m.userId !== me && m.enabled"
                link
                size="small"
                @click="toggleModerator(m)"
                >{{
                  t(m.role === 'moderator' ? 'im.group.unsetModerator' : 'im.group.setModerator')
                }}</el-button
              >
              <el-button
                v-if="isOwner && m.userId !== me && m.enabled"
                link
                size="small"
                @click="transfer(m)"
                >{{ t('im.group.transfer') }}</el-button
              >
              <el-button v-if="canRemove(m)" link size="small" type="danger" @click="remove(m)">{{
                t('im.group.remove')
              }}</el-button>
            </span>
          </li>
        </ul>
      </section>
      <section class="im-group__section im-group__danger">
        <el-button v-if="isOwner" type="danger" plain :loading="busy" @click="close">{{
          t('im.group.close')
        }}</el-button>
        <el-button type="danger" :loading="busy" @click="leave">{{
          t('im.group.leave')
        }}</el-button>
      </section>
    </div>
  </el-drawer>
</template>

<style scoped>
.im-group {
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.im-group__heading {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--qw-text-2);
}
.im-group__row {
  display: flex;
  gap: 8px;
}
.im-group__label {
  margin: 0;
}
.im-group__members {
  padding: 0;
  margin: 0;
  list-style: none;
}
.im-group__member {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  padding: 6px 0;
  border-bottom: 1px solid var(--qw-border);
}
.im-group__member-name {
  font-weight: 600;
}
.im-group__actions {
  margin-left: auto;
}
.im-group__danger {
  display: flex;
  gap: 8px;
}
</style>
