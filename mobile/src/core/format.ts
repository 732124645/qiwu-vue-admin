const pad = (n: number) => String(n).padStart(2, '0')

/**
 * An API timestamp (ISO, UTC) as local `YYYY-MM-DD HH:mm`, the web's list format. By hand, not Intl: older
 * mp-weixin / App JS engines lack or trim it.
 */
export function formatTime(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * A list's short time (§12.4): today `HH:mm`, this year `MM-DD HH:mm`, earlier `YYYY-MM-DD`; details keep
 * formatTime(). `now` for tests.
 */
export function formatShort(iso: string, now = new Date()): string {
  const d = new Date(iso)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  if (d.getFullYear() !== now.getFullYear()) return `${d.getFullYear()}-${md}`
  return d.getMonth() === now.getMonth() && d.getDate() === now.getDate() ? hm : `${md} ${hm}`
}

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB']

/** Bytes for people, one decimal: 1536 → "1.5 KB" (by hand, as formatTime). */
export function formatSize(bytes: number): string {
  let n = bytes
  let i = 0
  while (n >= 1024 && i < SIZE_UNITS.length - 1) {
    n /= 1024
    i++
  }
  return `${Math.round(n * 10) / 10} ${SIZE_UNITS[i]}`
}
