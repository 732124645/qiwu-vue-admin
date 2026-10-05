import { currentLocale, i18n } from '@/core/i18n'

// Value formats the monitor pages share (sizes are bytes, durations seconds: monitor.schema.ts).

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

/** `1536` → `1.5 KB` (binary steps, one decimal from KB on). */
export function bytes(n: number): string {
  let i = 0
  while (Math.abs(n) >= 1024 && i < UNITS.length - 1) {
    n /= 1024
    i++
  }
  return `${i ? n.toFixed(1) : Math.round(n)} ${UNITS[i]}`
}

/** A count in the page's language: `12345` → `12,345`. */
export const count = (n: number) => new Intl.NumberFormat(currentLocale()).format(n)

/** `93784` → `1 d 2 h 3 min` (days only when there are any; under a minute → `0 min`). */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const t = i18n.global.t
  return d
    ? t('monitor.duration.dhm', { d, h, m })
    : h
      ? t('monitor.duration.hm', { h, m })
      : t('monitor.duration.m', { m })
}

/** A usage percentage for a gauge: 0–100, one decimal. */
export const percent = (n: number) => Math.min(100, Math.max(0, Math.round(n * 10) / 10))

/** Gauge color by load: brand, warning from 70 %, danger from 90 %. */
export const loadColor = (p: number) =>
  p >= 90 ? 'var(--qw-danger)' : p >= 70 ? 'var(--qw-warning)' : 'var(--qw-brand)'
