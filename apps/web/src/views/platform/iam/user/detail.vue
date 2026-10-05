<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import type { PositionOption, UserDetailVo } from '@qiwu/shared'
import { positionApi } from '@/api/platform/iam/position'
import { userApi } from '@/api/platform/iam/user'
import DictTag from '@/core/components/DictTag.vue'
import { tx } from '@/core/i18n'

/**
 * One user in the list's detail drawer: GET /:id (contacts masked unless the caller may modify, the held
 * roles named), position names from their options (a disabled position is not listed there and is left out).
 */
defineOptions({ name: 'IamUserDetail' })
const { id } = defineProps<{ id: number }>()
const { t } = useI18n()

const user = shallowRef<UserDetailVo>()
const positions = shallowRef<PositionOption[]>([])
const loading = ref(true)
// failures are toasted by the request layer (404 out of scope included)
Promise.all([
  userApi.get(id).then((u) => (user.value = u)),
  positionApi.options().then((p) => (positions.value = p)),
])
  .catch(() => undefined)
  .finally(() => (loading.value = false))

const names = <T extends { id: number; name: string }>(all: T[], ids: number[] = []) =>
  all.filter((o) => ids.includes(o.id)).map((o) => tx(o.name))
const roleNames = computed(() => user.value?.roles.map((r) => tx(r.name)) ?? [])
const positionNames = computed(() => names(positions.value, user.value?.positionIds))
const time = (iso: string | null | undefined) => (iso ? dayjs(iso).format('YYYY-MM-DD HH:mm') : '')
</script>

<template>
  <div v-loading="loading" class="user-detail">
    <template v-if="user">
      <div class="user-detail__head">
        <span class="user-detail__avatar">
          <img v-if="user.avatarUrl" :src="user.avatarUrl" alt="" />
          <template v-else>{{ [...user.displayName][0]?.toUpperCase() }}</template>
        </span>
        <div>
          <div class="user-detail__name">{{ user.displayName }}</div>
          <div class="user-detail__sub">{{ user.username }}</div>
        </div>
        <DictTag class="user-detail__status" code="core.enabled" :value="user.enabled" />
      </div>
      <el-descriptions :column="1" border>
        <el-descriptions-item :label="t('field.iam.user.deptName')">
          {{ user.deptName ? tx(user.deptName) : '' }}
        </el-descriptions-item>
        <el-descriptions-item :label="t('field.iam.user.mobile')">
          {{ user.mobile }}
        </el-descriptions-item>
        <el-descriptions-item :label="t('field.iam.user.email')">
          {{ user.email }}
        </el-descriptions-item>
        <el-descriptions-item :label="t('field.iam.user.gender')">
          <DictTag code="iam.gender" :value="user.gender" />
        </el-descriptions-item>
        <el-descriptions-item :label="t('field.iam.user.roleNames')">
          <span v-if="!roleNames.length" class="user-detail__none">{{
            t('iam.user.noRoles')
          }}</span>
          <el-tag v-for="n in roleNames" :key="n" class="user-detail__tag" disable-transitions>
            {{ n }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item :label="t('field.iam.user.positionNames')">
          <span v-if="!positionNames.length" class="user-detail__none">
            {{ t('iam.user.noPositions') }}
          </span>
          <el-tag
            v-for="n in positionNames"
            :key="n"
            type="info"
            class="user-detail__tag"
            disable-transitions
          >
            {{ n }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item :label="t('field.iam.user.lastLoginAt')">
          {{ time(user.lastLoginAt) }}
        </el-descriptions-item>
        <el-descriptions-item :label="t('field.common.createdAt')">
          {{ time(user.createdAt) }}
        </el-descriptions-item>
        <el-descriptions-item :label="t('field.iam.user.note')">
          <span class="user-detail__note">{{ user.note }}</span>
        </el-descriptions-item>
      </el-descriptions>
    </template>
  </div>
</template>

<style scoped>
.user-detail {
  min-height: 200px;
}
.user-detail__head {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 20px;
}
.user-detail__avatar {
  display: grid;
  flex: none;
  place-items: center;
  width: 48px;
  height: 48px;
  overflow: hidden;
  font-size: 18px;
  font-weight: 650;
  color: var(--qw-brand-text);
  background: var(--qw-brand-weak);
  border-radius: 50%;
}
.user-detail__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.user-detail__name {
  font-size: 16px;
  font-weight: 650;
  color: var(--qw-text);
}
.user-detail__sub {
  font-size: 13px;
  color: var(--qw-text-3);
}
.user-detail__status {
  margin-left: auto;
}
.user-detail__tag {
  margin: 2px 6px 2px 0;
}
.user-detail__none {
  color: var(--qw-text-3);
}
.user-detail__note {
  white-space: pre-line;
}
</style>
