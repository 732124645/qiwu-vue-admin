<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import type { AuthorizeRedirectVo, AuthorizeVo } from '@qiwu/shared'
import { tx } from '@/core/i18n'
import { Icon } from '@/core/icons'
import AuthPage from '@/core/layout/AuthPage.vue'
import { api, ApiError } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import { useTagsStore } from '@/core/stores/tags'

/**
 * OAuth2 consent page (see docs/design-notes.md#auth-sessions): a third party's authorization request arrives as this
 * page's query string and goes to `/api/oauth2/authorize` as is (the server is its only parser). Every
 * invalid request is shown here; the browser only ever leaves for the server's `redirectTo`.
 */
defineOptions({ name: 'SsoView' })

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const tags = useTagsStore()

const state = ref<'loading' | 'consent' | 'error' | 'leaving'>('loading')
const info = ref<AuthorizeVo>()
const error = ref('')
/** the answer being sent (its button loads, both are disabled), null when none */
const deciding = ref<boolean | null>(null)
// the route's query string, as is: the one sign-in came back with (the router may re-encode it, same values)
const endpoint = `/oauth2/authorize${new URL(route.fullPath, location.origin).search}`
/** where approving leads (the server checked it is registered): helps the user spot a look-alike app */
const host = computed(() => {
  const uri = route.query.redirect_uri
  return typeof uri === 'string' && URL.canParse(uri) ? new URL(uri).host : ''
})
const scopeText = (s: string) => t(`oauth.scope.${s.replaceAll('.', '_')}`)

function fail(e: unknown) {
  if (e instanceof ApiError && e.status === 401) {
    // the session ended meanwhile: sign in again, then back to this request
    auth.clear()
    return void router.replace({ path: '/login', query: { redirect: route.fullPath } })
  }
  error.value = e instanceof ApiError ? e.message : t('common.error.network')
  state.value = 'error'
}

/** Follows the server's answer only, never the query's `redirect_uri`; http(s) only. */
function leave(to: string) {
  if (!/^https?:\/\//.test(to)) {
    error.value = t('oauth.sso.invalid')
    state.value = 'error'
    return
  }
  state.value = 'leaving'
  location.assign(to)
}

async function decide(approve: boolean) {
  deciding.value = approve
  try {
    leave((await api.post<AuthorizeRedirectVo>(endpoint, { approve }, { silent: true })).redirectTo)
  } catch (e) {
    fail(e)
  } finally {
    deciding.value = null
  }
}

onMounted(async () => {
  try {
    info.value = await api.get<AuthorizeVo>(endpoint, { silent: true })
  } catch (e) {
    return fail(e)
  }
  // nothing left to ask (auto-approved scopes, a remembered consent): approve at once
  if (info.value.pending.length) state.value = 'consent'
  else await decide(true)
})

async function switchAccount() {
  const back = route.fullPath
  await auth.logout()
  tags.reset()
  await router.replace({ path: '/login', query: { redirect: back } })
}
</script>

<template>
  <AuthPage
    :title="t('oauth.sso.title')"
    :subtitle="t('oauth.sso.subtitle', { name: auth.me?.user.displayName ?? '' })"
  >
    <template v-if="state === 'error'">
      <el-alert :title="error" type="error" show-icon :closable="false" />
      <div class="sso__other">
        <el-button link type="primary" @click="router.replace('/')">
          {{ t('common.action.backHome') }}
        </el-button>
      </div>
    </template>
    <template v-else-if="state === 'consent' && info">
      <div class="sso__client">
        <img
          v-if="info.client.logoUrl"
          :src="info.client.logoUrl"
          :alt="tx(info.client.name)"
          class="sso__logo"
        />
        <span v-else class="sso__logo sso__logo--letter" aria-hidden="true">
          {{ tx(info.client.name).charAt(0).toUpperCase() }}
        </span>
        <span>
          <strong class="sso__name">{{ tx(info.client.name) }}</strong>
          <span class="sso__id">{{ info.client.clientId }}</span>
        </span>
      </div>
      <p>{{ t('oauth.sso.wants', { client: tx(info.client.name) }) }}</p>
      <ul class="sso__scopes">
        <li v-for="s in info.scopes" :key="s">
          <Icon icon="lucide:check" class="sso__check" />{{ scopeText(s) }}
        </li>
      </ul>
      <p v-if="host" class="sso__host">{{ t('oauth.sso.redirectHost', { host }) }}</p>
      <div class="sso__actions">
        <el-button
          size="large"
          class="sso__btn"
          :loading="deciding === false"
          :disabled="deciding !== null"
          @click="decide(false)"
        >
          {{ t('oauth.sso.deny') }}
        </el-button>
        <el-button
          type="primary"
          size="large"
          class="sso__btn"
          :loading="deciding === true"
          :disabled="deciding !== null"
          @click="decide(true)"
        >
          {{ t('oauth.sso.approve') }}
        </el-button>
      </div>
      <div class="sso__other">
        <el-button link type="primary" :disabled="deciding !== null" @click="switchAccount">
          {{ t('oauth.sso.switchAccount') }}
        </el-button>
      </div>
    </template>
    <div v-else v-loading="true" class="sso__wait">
      <p v-if="state === 'leaving'">{{ t('oauth.sso.redirecting') }}</p>
    </div>
  </AuthPage>
</template>

<style scoped>
.sso__client {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 16px;
}
.sso__logo {
  flex: none;
  width: 48px;
  height: 48px;
  object-fit: cover;
  border-radius: var(--qw-radius);
}
.sso__logo--letter {
  display: grid;
  place-items: center;
  font-size: 22px;
  font-weight: 600;
  color: var(--qw-brand-text);
  background: var(--qw-brand-weak);
}
.sso__name {
  display: block;
  font-size: 16px;
}
.sso__id,
.sso__host {
  color: var(--qw-text-3);
}
.sso__id {
  font-size: 12px;
}
.sso__scopes {
  padding: 0;
  margin: 0 0 16px;
  list-style: none;
}
.sso__scopes li {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 6px 0;
}
.sso__check {
  flex: none;
  color: var(--qw-success);
}
.sso__actions {
  display: flex;
  margin-top: 16px;
}
/* the buttons' own margin between them is the gap */
.sso__btn {
  flex: 1;
}
.sso__other {
  margin-top: 12px;
  text-align: center;
}
.sso__wait {
  display: grid;
  place-items: end center;
  min-height: 120px;
  color: var(--qw-text-2);
}
</style>
