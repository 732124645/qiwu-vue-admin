<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import LocaleSwitch from '@/core/components/LocaleSwitch.vue'
import { Icon } from '@/core/icons'
import BrandMark from './BrandMark.vue'

/**
 * Full-page frame of the pages outside the layout (sign-in, lock, forced password change), §6: a navy brand
 * panel drawn in CSS beside the form (≥ 992px); narrower, the panel shrinks to a band above the form card.
 */
const { title, subtitle } = defineProps<{ title: string; subtitle?: string }>()
const { t } = useI18n()
const appTitle = import.meta.env.VITE_APP_TITLE
const year = new Date().getFullYear()

const POINTS = [
  { icon: 'lucide:shield-check', title: 'common.brand.access', desc: 'common.brand.accessDesc' },
  { icon: 'lucide:languages', title: 'common.brand.global', desc: 'common.brand.globalDesc' },
  { icon: 'lucide:history', title: 'common.brand.audit', desc: 'common.brand.auditDesc' },
]
</script>

<template>
  <div class="auth-page">
    <aside class="auth-brand">
      <div class="auth-brand__logo">
        <BrandMark :size="32" />
        <span>
          <template v-if="appTitle">{{ appTitle }}</template>
          <template v-else>
            {{ t('common.app.name')
            }}<span class="auth-brand__suffix">{{ t('common.app.suffix') }}</span>
          </template>
        </span>
      </div>
      <div class="auth-brand__body">
        <p class="auth-brand__tagline">{{ t('common.brand.tagline') }}</p>
        <ul class="auth-brand__points">
          <li v-for="p in POINTS" :key="p.title" class="auth-brand__point">
            <span class="auth-brand__icon"><Icon :icon="p.icon" /></span>
            <span>
              <strong class="auth-brand__point-title">{{ t(p.title) }}</strong>
              <span class="auth-brand__point-desc">{{ t(p.desc) }}</span>
            </span>
          </li>
        </ul>
      </div>
      <p class="auth-brand__foot">{{ t('layout.footer', { year }) }}</p>
    </aside>
    <main class="auth-page__main">
      <section class="auth-page__card">
        <header class="auth-page__head">
          <h1 class="auth-page__title">{{ title }}</h1>
          <p v-if="subtitle" class="auth-page__subtitle">{{ subtitle }}</p>
        </header>
        <slot />
      </section>
    </main>
    <!-- after the form in the DOM: the first Tab lands in the form; placed top-right by CSS -->
    <div class="auth-page__locale"><LocaleSwitch /></div>
  </div>
</template>

<style scoped>
.auth-page {
  position: relative;
  display: grid;
  grid-template-columns: clamp(420px, 44%, 680px) 1fr;
  min-height: 100vh;
  background: var(--qw-surface);
}

/* ---------- brand panel: navy, a lift of the theme color at the top, a faint grid fading out ---------- */
.auth-brand {
  position: relative;
  display: flex;
  flex-direction: column;
  padding: 36px clamp(56px, 5vw, 96px) 32px;
  overflow: hidden;
  color: var(--qw-side-text);
  background:
    radial-gradient(
      90% 60% at 100% 0%,
      color-mix(in srgb, var(--qw-brand) 30%, transparent),
      transparent 70%
    ),
    linear-gradient(
      165deg,
      color-mix(in srgb, var(--qw-brand) 14%, var(--qw-side-bg)) 0%,
      var(--qw-side-bg) 60%
    );
  isolation: isolate;
}
.auth-brand::before {
  position: absolute;
  inset: 0;
  z-index: -1;
  content: '';
  background-image:
    linear-gradient(color-mix(in srgb, var(--qw-side-text) 9%, transparent) 1px, transparent 1px),
    linear-gradient(
      90deg,
      color-mix(in srgb, var(--qw-side-text) 9%, transparent) 1px,
      transparent 1px
    );
  background-position: -1px -1px;
  background-size: 48px 48px;
  /* a mask only reads alpha: any opaque token will do */
  mask-image: radial-gradient(70% 55% at 72% 30%, var(--qw-side-bg), transparent);
}
.auth-brand__logo {
  display: flex;
  gap: 12px;
  align-items: center;
  font-size: 16px;
  font-weight: 600;
  line-height: 32px;
  color: var(--qw-side-active-text);
  letter-spacing: 0.01em;
}
/* the zh wordmark (six CJK glyphs, suffix included) needs a touch more air than the Latin tracking */
.auth-brand__logo:lang(zh) {
  letter-spacing: 0.04em;
}
.auth-brand__suffix {
  font-weight: 400;
  opacity: 0.6;
}
.auth-brand__body {
  margin: auto 0;
  padding: 48px 0;
}
.auth-brand__tagline {
  max-width: 13em;
  margin: 0;
  font-size: clamp(32px, 2.4vw, 44px);
  font-weight: 650;
  line-height: 1.3;
  color: var(--qw-side-active-text);
  letter-spacing: -0.02em;
  text-wrap: balance;
  /* a translation may place its own line break (zh keeps a word from splitting) */
  white-space: pre-line;
}
.auth-brand__points {
  display: grid;
  gap: 22px;
  max-width: 400px;
  padding: 0;
  margin: 40px 0 0;
  list-style: none;
}
.auth-brand__point {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}
.auth-brand__icon {
  display: grid;
  flex: none;
  place-items: center;
  width: 36px;
  height: 36px;
  font-size: 18px;
  /* a light tint of the theme color, legible on navy whatever the theme color is */
  color: color-mix(in srgb, var(--qw-brand) 40%, var(--qw-on-brand));
  background: color-mix(in srgb, var(--qw-on-brand) 7%, transparent);
  border-radius: var(--qw-radius-sm);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--qw-on-brand) 10%, transparent);
}
.auth-brand__point-title {
  display: block;
  font-size: 15px;
  font-weight: 600;
  line-height: 22px;
  color: var(--qw-side-active-text);
}
.auth-brand__point-desc {
  display: block;
  margin-top: 2px;
  font-size: 13px;
  line-height: 20px;
}
.auth-brand__foot {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--qw-side-text-3);
}

/* ---------- form side ---------- */
.auth-page__main {
  /* above the band it overlaps below 992px */
  position: relative;
  display: grid;
  place-items: center;
  min-width: 0;
  /* a little above the middle: the optical center */
  padding: 72px 32px 120px;
}
.auth-page__card {
  box-sizing: border-box;
  width: 100%;
  max-width: 400px;
}
.auth-page__head {
  margin-bottom: 28px;
}
.auth-page__title {
  margin: 0;
  font-size: 26px;
  font-weight: 650;
  line-height: 34px;
  color: var(--qw-text);
  letter-spacing: -0.02em;
}
.auth-page__subtitle {
  margin: 6px 0 0;
  font-size: 14px;
  line-height: 22px;
  color: var(--qw-text-3);
  text-wrap: pretty;
}
.auth-page__locale {
  position: absolute;
  /* centered on the brand panel's logo row */
  top: 36px;
  right: 24px;
}

/* ---------- < 992px: the panel becomes a band, the form a card overlapping it ---------- */
@media (max-width: 991.98px) {
  .auth-page {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto 1fr;
    background: var(--qw-canvas);
  }
  /* band and card share one column: the card's edges, 16px from the screen edge at least */
  .auth-page {
    --auth-gutter: max(16px, calc((100% - 420px) / 2));
  }
  .auth-brand {
    padding: 20px var(--auth-gutter) 88px;
    /* the band's edge, needed in dark mode where navy and canvas are close */
    border-bottom: 1px solid var(--qw-border);
  }
  .auth-brand__logo {
    font-size: 15px;
  }
  .auth-brand__body {
    padding: 0;
    margin: 24px 0 0;
  }
  .auth-brand__tagline {
    max-width: none;
    font-size: 20px;
    font-weight: 600;
  }
  .auth-brand__points,
  .auth-brand__foot {
    display: none;
  }
  .auth-page__main {
    align-items: start;
    padding: 0 16px 48px;
    margin-top: -56px;
  }
  .auth-page__card {
    max-width: 420px;
    padding: 32px;
    background: var(--qw-surface);
    border: 1px solid var(--qw-border);
    border-radius: var(--qw-radius-lg);
    box-shadow: var(--qw-shadow-2);
  }
  .auth-page__head {
    margin-bottom: 24px;
  }
  .auth-page__title {
    font-size: 22px;
    line-height: 30px;
  }
  .auth-page__locale {
    top: 20px;
    right: var(--auth-gutter);
  }
}
@media (max-width: 480px) {
  .auth-page__card {
    padding: 24px 20px;
  }
}
</style>
