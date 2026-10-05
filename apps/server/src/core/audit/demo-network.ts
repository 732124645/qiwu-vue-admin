import { isIP } from 'node:net'
import Bowser from 'bowser'
import { demoMode } from '../config/demo-mode.js'

type NetworkData = {
  ip: string | null
  location?: string | null
  userAgent?: string | null
  browser?: string | null
  os?: string | null
}

/** Demo visitors share accounts: mask read/export copies, never the stored audit or session data. */
export function demoNetwork<T extends NetworkData>(row: T): T {
  if (!demoMode()) return row
  const masked = { ...row, ip: maskIp(row.ip) }
  if ('location' in row) masked.location = '*'
  if ('userAgent' in row)
    masked.userAgent = row.userAgent ? Bowser.parse(row.userAgent).browser.name || '*' : null
  if ('browser' in row) masked.browser = row.browser?.replace(/ \d.*$/, '') ?? null
  if ('os' in row) masked.os = '*'
  return masked
}

function maskIp(ip: string | null): string | null {
  if (ip === null) return null
  const address = ip.split('%', 1)[0]!
  if (isIP(address) === 4) return `${address.split('.').slice(0, 2).join('.')}.*.*`
  if (isIP(address) === 6) {
    const groups = new URL(`http://[${address}]/`).hostname.slice(1, -1).split(':')
    return `${groups[0] || '0'}:${groups[1] || '0'}::*`
  }
  return '*'
}
