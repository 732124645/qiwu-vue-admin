<script setup lang="ts">
import { onHide, onLaunch, onShow } from '@dcloudio/uni-app'
import { locale, setLocale } from '@/core/i18n'
import { startRealtime, stopRealtime } from '@/core/realtime'
import { initTheme } from '@/core/theme'
import { checkUpdate } from '@/core/update'

onLaunch(() => {
  // uni's built-in UI (modals, pickers) and wot-ui's texts follow the saved language from the start
  setLocale(locale())
  // The saved appearance (App / H5) or the system's, before the first page renders
  initTheme()
  // App only, silent unless the server offers a newer version
  void checkUpdate()
})

// The socket only while the app is in the foreground; back in front it reconnects and catches up
onShow(startRealtime)
onHide(stopRealtime)
</script>

<style lang="scss">
@use '@wot-ui/ui/styles/theme/dark.scss' as wd;

/*
 * Direction B (docs/design/visual-system.md §2, §12): light and dark tokens. Same-named tokens take the web's
 * values (apps/web/src/styles/tokens.css, light and html.dark); the mobile-only ones are §12.1's
 * (mobile-theme.spec.ts checks both). Components use these tokens, never raw colors. wot-ui's semantic
 * variables point at them here; no <wd-config-provider>: its .wot-theme-light class would reset them.
 * Dark: H5 by the `qw-dark` class on <html> (core/theme.ts, so Me → Appearance can override the system);
 * App and mini program by prefers-color-scheme (App switches it with plus.nativeUI.setUIStyle).
 */
@mixin qw-wot-map {
  /* wot-ui → tokens: fill, pressed (the darker text shade), weak background */
  --wot-primary-6: var(--qw-brand);
  --wot-primary-5: var(--qw-brand);
  --wot-primary-7: var(--qw-brand-text);
  --wot-primary-1: var(--qw-brand-weak);
  --wot-primary-2: var(--qw-brand-weak);
  --wot-success-main: var(--qw-success);
  --wot-success-surface: var(--qw-success-weak);
  --wot-warning-main: var(--qw-warning);
  --wot-warning-surface: var(--qw-warning-weak);
  --wot-danger-main: var(--qw-danger);
  --wot-danger-surface: var(--qw-danger-weak);
  --wot-text-main: var(--qw-text);
  --wot-text-secondary: var(--qw-text-2);
  --wot-text-auxiliary: var(--qw-text-3);
  --wot-text-placeholder: var(--qw-text-3);
  --wot-text-white: var(--qw-on-brand);
  --wot-icon-main: var(--qw-text);
  --wot-icon-secondary: var(--qw-text-2);
  --wot-icon-auxiliary: var(--qw-text-3);
  --wot-border-main: var(--qw-border);
  --wot-border-light: var(--qw-border);
  --wot-filled-bottom: var(--qw-canvas);
  --wot-filled-content: var(--qw-surface-2);
  --wot-filled-oppo: var(--qw-surface);
  --wot-radius-main: var(--qw-radius-sm);
  --wot-radius-large: var(--qw-radius);
  --wot-radius-extra-large: var(--qw-radius-lg);
  /* every popup here is a bottom sheet (§12.2: radius-xl); the mask */
  --wot-popup-radius: var(--qw-radius-xl);
  --wot-action-sheet-radius: var(--qw-radius-xl);
  --wot-overlay-bg: var(--qw-mask);
  /* the stepper's field and buttons: a neutral fill in both themes (wot-ui's canvas is a hole in dark) */
  --wot-input-number-input-bg: var(--qw-neutral-weak);
  --wot-input-number-action-bg: var(--qw-neutral-weak);
}

page,
.wd-root-portal {
  --qw-brand: #1f6feb;
  --qw-brand-text: #1d68dd;
  --qw-brand-weak: #e9f1fd;
  --qw-on-brand: #ffffff;
  --qw-canvas: #f2f4f7;
  --qw-surface: #ffffff;
  --qw-surface-2: #f7f9fc;
  --qw-border: #e3e7ee;
  --qw-text: #0f1a2b;
  --qw-text-2: #4b5870;
  --qw-text-3: #5f6b80;
  --qw-success: #127d5a;
  --qw-success-weak: #e6f4ee;
  --qw-warning: #a75808;
  --qw-warning-weak: #fdf1e3;
  --qw-danger: #c8322f;
  --qw-danger-weak: #fdecec;
  --qw-neutral: #5f6b80;
  --qw-neutral-weak: #eef1f5;
  --qw-side-bg: #0b1a33;
  --qw-side-text: #b9c4d8;
  --qw-side-hover: rgba(255, 255, 255, 0.06);
  --qw-side-active-text: #ffffff;
  --qw-radius-sm: 8px;
  --qw-radius: 10px;
  --qw-radius-lg: 14px;
  --qw-shadow-1: 0 1px 3px rgba(15, 26, 43, 0.05), 0 10px 24px -14px rgba(15, 26, 43, 0.16);
  --qw-shadow-2: 0 18px 48px -18px rgba(15, 26, 43, 0.28);
  --qw-font:
    -apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', 'Segoe UI', 'PingFang SC',
    'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Arial, sans-serif;
  --qw-ease-enter: cubic-bezier(0.2, 0.8, 0.2, 1);
  /* mobile only (§12.1) */
  --qw-brand-2: #2193e0;
  --qw-brand-soft: #a9c7f7;
  /* the one raised surface (segmented thumb): above its track in both themes */
  --qw-raised: #ffffff;
  --qw-mask: rgba(8, 13, 22, 0.45);
  --qw-radius-xl: 24px;
  --qw-shadow-up: 0 -8px 24px -16px rgba(15, 26, 43, 0.22);
  --qw-shadow-brand: 0 8px 16px -10px var(--qw-brand);
  --qw-space-1: 8rpx;
  --qw-space-2: 16rpx;
  --qw-space-3: 24rpx;
  --qw-space-4: 32rpx;
  --qw-space-5: 48rpx;
  --qw-fs-display: 52rpx;
  --qw-fs-title-lg: 44rpx;
  --qw-fs-title: 34rpx;
  --qw-fs-body-lg: 30rpx;
  --qw-fs-body: 28rpx;
  --qw-fs-caption: 24rpx;
  --qw-fs-micro: 22rpx;
  @include qw-wot-map;
}

/* the dark values; wot-ui's own dark set first for what we do not map (picker fades, dividers…) */
@mixin qw-dark {
  color-scheme: dark;
  @include wd.dark-theme-vars;
  --qw-brand-text: #6fa3ff;
  --qw-brand-weak: rgba(76, 141, 255, 0.14);
  --qw-canvas: #080d16;
  --qw-surface: #0f1624;
  --qw-surface-2: #141c2d;
  --qw-border: #1e2940;
  --qw-text: #e8edf5;
  --qw-text-2: #9aa7bd;
  --qw-text-3: #7a879e;
  /* --qw-side-text keeps its light value: the navy it sits on does not change (§12.1) */
  --qw-side-hover: rgba(255, 255, 255, 0.05);
  --qw-success: #3fcb8f;
  --qw-success-weak: rgba(63, 203, 143, 0.12);
  --qw-warning: #f0a14a;
  --qw-warning-weak: rgba(240, 161, 74, 0.12);
  --qw-danger: #f26b68;
  --qw-danger-weak: rgba(242, 107, 104, 0.12);
  --qw-neutral: #8b98ae;
  --qw-neutral-weak: rgba(139, 152, 174, 0.12);
  --qw-shadow-1: none;
  --qw-shadow-2: 0 18px 48px -18px rgba(0, 0, 0, 0.6);
  --qw-raised: #2a3550;
  --qw-mask: rgba(0, 0, 0, 0.6);
  --qw-shadow-up: none;
  --qw-shadow-brand: none;
  @include qw-wot-map;
}

/* #ifdef H5 */
.qw-dark page,
.qw-dark .wd-root-portal {
  @include qw-dark;
}
/*
 * H5 builds without uni's darkmode: its native navigation bar carries theme.json's light colours inline. The
 * class turns it dark (navBg: the surface) the moment the theme is known, before the page's own code loads,
 * so a page opened by its URL never shows a light bar; the back / home icon follows the text.
 */
.qw-dark .uni-page-head {
  @include qw-dark;
  background-color: var(--qw-surface) !important;
  color: var(--qw-text) !important;
}
.qw-dark .uni-page-head path {
  fill: currentColor;
}
/* #endif */
/* #ifndef H5 */
@media (prefers-color-scheme: dark) {
  page,
  .wd-root-portal {
    @include qw-dark;
  }
}
/* #endif */

/* min-height: on H5 `page` is the page body, as tall as its content */
page {
  min-height: 100%;
  background: var(--qw-canvas);
  color: var(--qw-text);
  font-family: var(--qw-font);
}

/* ---- shared building blocks (§12.4); pages add only what is theirs ---- */

/* a tab page's content sheet over its QwPageHeader: canvas, top corners radius-xl, 24px over the header */
.qw-sheet {
  position: relative;
  z-index: 1;
  margin-top: -24px;
  padding: var(--qw-space-4) var(--qw-space-4) 0;
  border-radius: var(--qw-radius-xl) var(--qw-radius-xl) 0 0;
  background: var(--qw-canvas);
}

/* QwPageHeader's texts, also for what a page puts in its slots: the big title, the summary line */
.qw-hdr__title {
  position: relative;
  font-size: var(--qw-fs-title-lg);
  font-weight: 650;
  letter-spacing: 0.02em;
  color: var(--qw-side-active-text);
}

.qw-hdr__sub {
  position: relative;
  display: block;
  margin-top: 4px;
  font-size: var(--qw-fs-body);
  color: var(--qw-side-text);
}

/* QwTabBar (§12.4): surface, 54 high + the safe area, labels micro, 600 when active. Here, not in the
   component: `qw-tabbar` sits on wd-tabbar's inner node, which a component's (H5-scoped) style does not
   reach. The labels carry wot-ui's class but are drawn in QwTabBar's icon slot, so wot-ui's (H5/App-scoped)
   size rule misses them: their size and line height are set here too */
.qw-tabbar {
  --wot-tabbar-height: 54px;
  --wot-tabbar-bg: var(--qw-surface);
  --wot-tabbar-item-color-active: var(--qw-brand-text);
  --wot-tabbar-item-color-inactive: var(--qw-text-3);
  --wot-tabbar-item-title-font-size: var(--qw-fs-micro);
}

.qw-tabbar .wd-tabbar-item__body-title {
  margin-top: 6rpx;
  font-size: var(--wot-tabbar-item-title-font-size);
  font-weight: 500;
  line-height: 16px;
}

.qw-tabbar .wd-tabbar-item__body-title.is-active {
  font-weight: 600;
}

/* a card; cards carry no shadow (§12.2) */
.qw-card {
  border-radius: var(--qw-radius-lg);
  background: var(--qw-surface);
}

/* a section title row, an optional "View all ›" link on the right (44 high: its hit area) */
.qw-sec {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 44px;
  margin-top: var(--qw-space-2);
}

.qw-sec__title {
  font-size: var(--qw-fs-body-lg);
  font-weight: 600;
  color: var(--qw-text);
}

.qw-sec__link {
  display: inline-flex;
  align-items: center;
  gap: 4rpx;
  height: 44px;
  font-size: var(--qw-fs-body);
  color: var(--qw-brand-text);
}

/* a read-only row (the detail's form summary, a process form's read fields): the label (88 wide) and its
   value, lines between; global: components on mp-weixin only see App.vue's classes */
.qw-kv {
  display: flex;
  gap: 24rpx;
  padding: 20rpx 0;
  border-top: 1px solid var(--qw-border);
  font-size: var(--qw-fs-body);
}

.qw-kv__k {
  flex: none;
  width: 164rpx;
  color: var(--qw-text-3);
}

.qw-kv__v {
  flex: 1;
  min-width: 0;
  line-height: 1.5;
  color: var(--qw-text);
  word-break: break-word;
  font-variant-numeric: tabular-nums;
}

/* a form field: the input box (52 high, radius-lg, 1px border; `is-focus` rings it), its message below */
.qw-field {
  --wot-input-bg: var(--qw-surface-2);
  --wot-input-inner-font-size: var(--qw-fs-body-lg);
  display: flex;
  flex-direction: column;
  gap: 8rpx;
}

.qw-field .wd-input {
  display: flex;
  align-items: center;
  box-sizing: border-box;
  min-height: 96rpx;
  padding: 0 28rpx;
  border-radius: var(--qw-radius-lg);
  background: var(--qw-surface-2);
  box-shadow: inset 0 0 0 1px var(--qw-border);
  transition: box-shadow 150ms var(--qw-ease-enter);
}

.qw-field.is-focus .wd-input {
  box-shadow:
    inset 0 0 0 1px var(--qw-brand),
    0 0 0 3px var(--qw-brand-weak);
}

/* a field that draws its own show-password eye (sign-in) hides wd-input's (and Edge's on H5) */
.qw-field--own-eye .wd-input__suffix .wd-input__icon {
  display: none;
}

/* #ifdef H5 */
.qw-field--own-eye .uni-input-input::-ms-reveal {
  display: none;
}
/* #endif */

.qw-field__label {
  font-size: var(--qw-fs-body);
  color: var(--qw-text-2);
}

.qw-field__error,
.qw-form__error {
  font-size: var(--qw-fs-caption);
  color: var(--qw-danger);
}

.qw-field__label.is-required::before {
  content: '*';
  margin-right: 4rpx;
  color: var(--qw-danger);
}

/* a form card (profile, password): fields, a message, the submit button */
.qw-form {
  display: flex;
  flex-direction: column;
  gap: var(--qw-space-4);
  padding: 36rpx 32rpx;
  border-radius: var(--qw-radius-lg);
  background: var(--qw-surface);
}

.qw-form__hint {
  font-size: var(--qw-fs-caption);
  color: var(--qw-text-3);
}

/* a bottom sheet's form (the decision sheet, the start sheet): title, fields, submit; scrolls when long */
.qw-decide {
  display: flex;
  flex-direction: column;
  gap: 28rpx;
  max-height: 80vh;
  padding: 32rpx 32rpx 24rpx;
  overflow-y: auto;
  border-radius: var(--qw-radius-xl) var(--qw-radius-xl) 0 0;
  background: var(--qw-surface);
}

.qw-decide__title {
  font-size: var(--qw-fs-title);
  font-weight: 600;
  color: var(--qw-text);
}

.qw-decide__user {
  display: flex;
  flex-direction: column;
  gap: 8rpx;
}

/* in a form card or sheet, a picker's cell and a textarea as filled fields */
.qw-form,
.qw-decide {
  --wot-textarea-bg: var(--qw-surface-2);
  --wot-cell-bg: var(--qw-surface-2);
}

.qw-form .wd-cell,
.qw-form .wd-textarea,
.qw-decide .wd-cell,
.qw-decide .wd-textarea {
  overflow: hidden;
  border-radius: var(--qw-radius-sm);
}

/* a page of stacked cards; a group card (a cell group, or rows split by lines from the text's start) */
.qw-stack {
  display: flex;
  flex-direction: column;
  gap: var(--qw-space-3);
}

.qw-group {
  overflow: hidden;
  border-radius: var(--qw-radius-lg);
  background: var(--qw-surface);
}

.qw-group > .qw-row + .qw-row::before {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  left: 132rpx;
  height: 1px;
  background: var(--qw-border);
}

/* a list row: 40 avatar or icon tile, title and short time, a second line, optional third (tags, body) */
.qw-row {
  position: relative;
  display: flex;
  gap: 24rpx;
  padding: 28rpx 32rpx;
}

.qw-row__main {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 8rpx;
  min-width: 0;
}

.qw-row__line {
  display: flex;
  align-items: center;
  gap: var(--qw-space-2);
}

.qw-row__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: var(--qw-fs-body-lg);
  font-weight: 600;
  color: var(--qw-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.qw-row.is-read .qw-row__title {
  font-weight: 500;
}

.qw-row__time {
  flex: none;
  font-size: var(--qw-fs-caption);
  color: var(--qw-text-3);
  font-variant-numeric: tabular-nums;
}

.qw-row__sub {
  overflow: hidden;
  font-size: var(--qw-fs-body);
  color: var(--qw-text-2);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.qw-row__body {
  display: -webkit-box;
  overflow: hidden;
  font-size: var(--qw-fs-body);
  line-height: 1.45;
  color: var(--qw-text-2);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.qw-row__meta {
  font-size: var(--qw-fs-caption);
  color: var(--qw-text-3);
}

/* a person's initial (round) and an icon tile (radius-lg; 32 menu tiles: radius); colour by modifier */
.qw-av,
.qw-tile {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 76rpx;
  height: 76rpx;
  font-size: var(--qw-fs-body-lg);
  font-weight: 600;
}

.qw-av {
  border-radius: 50%;
}

.qw-tile {
  position: relative;
  border-radius: var(--qw-radius-lg);
}

.qw-av--brand,
.qw-tile--brand {
  color: var(--qw-brand-text);
  background: var(--qw-brand-weak);
}

.qw-av--success,
.qw-tile--success {
  color: var(--qw-success);
  background: var(--qw-success-weak);
}

.qw-av--warning,
.qw-tile--warning {
  color: var(--qw-warning);
  background: var(--qw-warning-weak);
}

.qw-av--neutral,
.qw-tile--neutral {
  color: var(--qw-neutral);
  background: var(--qw-neutral-weak);
}

.qw-tile--solid {
  color: var(--qw-on-brand);
  background: linear-gradient(135deg, var(--qw-brand), var(--qw-brand-2));
}

/* a status pill as the web's DictTag: weak ground, semantic text, a 6px dot (`is-plain`: none) */
.qw-tag {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 10rpx;
  height: 44rpx;
  padding: 0 16rpx;
  border-radius: 999px;
  font-size: var(--qw-fs-micro);
  font-weight: 500;
  white-space: nowrap;
}

.qw-tag::before {
  content: '';
  width: 12rpx;
  height: 12rpx;
  border-radius: 50%;
  background: currentColor;
}

.qw-tag.is-plain::before {
  display: none;
}

.qw-tag--primary {
  color: var(--qw-brand-text);
  background: var(--qw-brand-weak);
}

.qw-tag--success {
  color: var(--qw-success);
  background: var(--qw-success-weak);
}

.qw-tag--warning {
  color: var(--qw-warning);
  background: var(--qw-warning-weak);
}

.qw-tag--danger {
  color: var(--qw-danger);
  background: var(--qw-danger-weak);
}

.qw-tag--info {
  color: var(--qw-neutral);
  background: var(--qw-neutral-weak);
}

/* counts: the red badge (digits and ring in the surface colour: legible on dark red, §12.6) and dot */
.qw-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  min-width: 36rpx;
  height: 36rpx;
  padding: 0 10rpx;
  border-radius: 999px;
  font-size: 20rpx;
  font-weight: 600;
  line-height: 1;
  color: var(--qw-surface);
  background: var(--qw-danger);
  box-shadow: 0 0 0 2px var(--qw-surface);
  font-variant-numeric: tabular-nums;
}

.qw-dot {
  flex: none;
  width: 16rpx;
  height: 16rpx;
  border-radius: 50%;
  background: var(--qw-danger);
}

/* buttons (a wd-button's custom-class, or a view): 48 high; primary glow, soft. A wd-button
   takes its size from its own variables (its `.is-<size>` rules outrank one class) */
.qw-btn {
  --wot-button-height-medium: 90rpx;
  --wot-button-height-large: 90rpx;
  --wot-button-font-size-medium: var(--qw-fs-body-lg);
  --wot-button-font-size-large: var(--qw-fs-body-lg);
  --wot-button-padding-medium: 0 40rpx;
  --wot-button-padding-large: 0 40rpx;
  --wot-button-radius-main: var(--qw-radius-lg);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 12rpx;
  box-sizing: border-box;
  height: 90rpx;
  padding: 0 40rpx;
  border-radius: var(--qw-radius-lg);
  font-size: var(--qw-fs-body-lg);
  font-weight: 600;
  white-space: nowrap;
}

.qw-btn .wd-button__text {
  font-weight: 600;
}

.qw-btn--primary {
  color: var(--qw-on-brand);
  background: var(--qw-brand);
  box-shadow: var(--qw-shadow-brand);
}

/* 44 high: the smallest touch target (§12.2; the mockups' 40 is too small to tap) */
.qw-btn--soft {
  height: 44px;
  font-size: var(--qw-fs-body);
  color: var(--qw-brand-text);
  background: var(--qw-brand-weak);
}

/* read by screen readers only */
.qw-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

/* one message or bulletin: title, meta line, body; padding, not a card margin, which would collapse
   through the page body */
.qw-detail {
  padding: 32rpx;
}

.qw-article {
  display: flex;
  flex-direction: column;
  gap: 20rpx;
  padding: 36rpx 32rpx;
  border-radius: var(--qw-radius-lg);
  background: var(--qw-surface);
}

.qw-article__title {
  font-size: var(--qw-fs-title);
  font-weight: 600;
  color: var(--qw-text);
}

.qw-article__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 20rpx;
  font-size: var(--qw-fs-caption);
  color: var(--qw-text-3);
}

.qw-article__body {
  font-size: var(--qw-fs-body-lg);
  line-height: 1.7;
  color: var(--qw-text);
  word-break: break-word;
}

/* §12.8: no motion for those who ask for none */
@media (prefers-reduced-motion: reduce) {
  .qw-field .wd-input {
    transition: none;
  }
}
</style>
