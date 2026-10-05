import dns, { type LookupAddress } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import type { Duplex } from 'node:stream'
import type { AppConfigService } from '../config/config.module.js'

/**
 * Outbound guard for targets an admin configures (SSRF: S3 endpoints, SMTP hosts; see docs/design-notes.md#security). A target
 * must resolve only to public addresses and use a port registered for its purpose; the check runs on the
 * address the socket really connects to (the agents' `lookup`), so DNS rebinding and redirects to inner
 * hosts meet it again. Every refusal is the same {@link OutboundRefused}: callers answer a generic error
 * and never echo the remote end. `ALLOW_PRIVATE_ENDPOINTS=true` (tests and dev only, never a cfg_param)
 * lifts the address and port checks for local S3/SMTP services.
 */

/** Longest wait for a DNS answer, and for any byte on a guarded socket (connect, TLS, response). */
export const NET_TIMEOUT_MS = 5000

/**
 * Ports a purpose may reach by default; a custom S3/SMTP port is registered by the deployer in env
 * `OUTBOUND_S3_PORTS` / `OUTBOUND_SMTP_PORTS` ({@link outboundRule}), never by an admin form.
 */
export const OUTBOUND_PORTS = {
  s3: [80, 443],
  smtp: [25, 465, 587],
} as const satisfies Record<string, readonly number[]>

const EXTRA_PORTS = { s3: 'OUTBOUND_S3_PORTS', smtp: 'OUTBOUND_SMTP_PORTS' } as const

export interface OutboundRule {
  /** the purpose's registered ports ({@link OUTBOUND_PORTS}) */
  ports: readonly number[]
  /** `ALLOW_PRIVATE_ENDPOINTS` */
  allowPrivate: boolean
  /** socket silence limit of {@link guardedAgents} (default {@link NET_TIMEOUT_MS}; tests shorten it) */
  timeoutMs?: number
}

/**
 * The rule of a purpose in this deployment: its default ports plus the ones the env registers for it
 * (every other port stays refused), and `ALLOW_PRIVATE_ENDPOINTS`.
 */
export function outboundRule(
  cfg: Pick<AppConfigService, 'get'>,
  purpose: keyof typeof OUTBOUND_PORTS,
): OutboundRule {
  return {
    ports: [...OUTBOUND_PORTS[purpose], ...cfg.get(EXTRA_PORTS[purpose])],
    allowPrivate: cfg.get('ALLOW_PRIVATE_ENDPOINTS'),
  }
}

/** The one error every refused or failed guard check throws: nothing about the target in it. */
export class OutboundRefused extends Error {
  constructor() {
    super('outbound target refused')
    this.name = 'OutboundRefused'
  }
}

// two lists: node checks an IPv4 address against IPv6 rules as its mapped form, so `::ffff:0:0/96`
// in one list would block every IPv4
const BLOCKED4 = new BlockList()
const BLOCKED6 = new BlockList()
for (const [net, bits] of [
  ['0.0.0.0', 8], // "this network", unspecified
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT (Alibaba's metadata 100.100.100.200 too)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata 169.254.169.254
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const)
  BLOCKED4.addSubnet(net, bits, 'ipv4')
for (const [net, bits] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['::', 96], // IPv4-compatible (deprecated)
  ['::ffff:0:0', 96], // IPv4-mapped: refused whatever the IPv4 is
  ['64:ff9b::', 96], // NAT64 (could translate to an inner IPv4)
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard
  ['2001::', 32], // Teredo (embeds an IPv4)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds an IPv4)
  ['fc00::', 7], // unique local (AWS metadata fd00:ec2::254 too)
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
] as const)
  BLOCKED6.addSubnet(net, bits, 'ipv6')

/** An IP literal that is not public (anything unparsable counts as blocked). */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 0) return true
  return family === 4 ? BLOCKED4.check(address, 'ipv4') : BLOCKED6.check(address, 'ipv6')
}

/**
 * The checks that need no DNS, for validating a target when it is saved: an unregistered port, an inner
 * IP literal or a `localhost` name. A name passing it is still checked when connecting.
 */
export function isRefusedLiteral(host: string, port: number, rule: OutboundRule): boolean {
  if (rule.allowPrivate) return false
  const bare = host.replace(/^\[(.*)\]$/, '$1').toLowerCase()
  return (
    !rule.ports.includes(port) ||
    (isIP(bare) !== 0 && isBlockedAddress(bare)) ||
    bare === 'localhost' ||
    bare.endsWith('.localhost')
  )
}

const withTimeout = <T>(p: Promise<T>): Promise<T> => {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OutboundRefused()), NET_TIMEOUT_MS)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

/** Every address of `host` (an IP literal as itself), all public unless `allowPrivate`; else refused. */
async function resolvePublic(host: string, allowPrivate: boolean): Promise<LookupAddress[]> {
  const bare = host.replace(/^\[(.*)\]$/, '$1')
  const family = isIP(bare)
  const addrs = family
    ? [{ address: bare, family }]
    : await withTimeout(dns.promises.lookup(bare, { all: true, verbatim: true })).catch(() => {
        throw new OutboundRefused()
      })
  // any inner answer refuses the host: a mixed answer could be picked either way later
  if (!addrs.length || (!allowPrivate && addrs.some((a) => isBlockedAddress(a.address))))
    throw new OutboundRefused()
  return addrs
}

/**
 * The target's addresses when `host` resolves (within {@link NET_TIMEOUT_MS}) only to public ones and
 * `port` is registered for the purpose; else {@link OutboundRefused}. A client that connects by name
 * afterwards resolves again: connect through {@link guardedAgents} (or to one of these addresses with the
 * name as SNI) so a rebound name cannot slip through.
 */
export async function assertPublicHost(
  host: string,
  port: number,
  rule: OutboundRule,
): Promise<LookupAddress[]> {
  if (!rule.allowPrivate && !rule.ports.includes(port)) throw new OutboundRefused()
  return resolvePublic(host, rule.allowPrivate)
}

/** `lookup` for net/tls connects: the checked addresses, in the shape the caller asked for. */
const guardedLookup =
  (allowPrivate: boolean): LookupFunction =>
  (hostname, options, callback) => {
    resolvePublic(hostname, allowPrivate).then(
      (all) => {
        const addrs = options.family ? all.filter((a) => a.family === options.family) : all
        const first = addrs[0]
        if (!first) callback(new OutboundRefused(), '', 4)
        else if (options.all) callback(null, addrs)
        else callback(null, first.address, first.family)
      },
      (err: Error) => callback(err, '', 4),
    )
  }

type Connect = (
  options: http.ClientRequestArgs,
  callback: (err: Error | null, socket: Duplex) => void,
) => Duplex | null | undefined

/**
 * The port check, and the address check for IP literals (net skips `lookup` for those); names are
 * checked by `lookup` on the address actually dialled.
 */
function guardedConnect(rule: OutboundRule, connect: Connect): Connect {
  return (options, callback) => {
    const host = String(options.host ?? options.hostname ?? '').replace(/^\[(.*)\]$/, '$1')
    const refused =
      !rule.allowPrivate &&
      (!rule.ports.includes(Number(options.port)) || (isIP(host) !== 0 && isBlockedAddress(host)))
    if (!refused) {
      const socket = connect(options, callback)
      // the agents' `timeout` keeps every socket (new, reused) on it; silence ends the request
      socket?.once('timeout', () => socket.destroy(new OutboundRefused()))
      return socket
    }
    // the agent reports it as the request's error
    callback(new OutboundRefused(), undefined as unknown as Duplex)
    return undefined
  }
}

/**
 * An http and an https agent that refuse inner addresses and unregistered ports on every connection
 * (keep-alive sockets were checked when they opened) and end a request whose socket stays silent for
 * {@link NET_TIMEOUT_MS} (a blackholed connect, a server that never answers). For clients that take agents: the AWS SDK's
 * `NodeHttpHandler({ httpAgent, httpsAgent })`, `http(s).request({ agent })`.
 */
export function guardedAgents(rule: OutboundRule): {
  httpAgent: http.Agent
  httpsAgent: https.Agent
} {
  const opts = {
    keepAlive: true,
    lookup: guardedLookup(rule.allowPrivate),
    timeout: rule.timeoutMs ?? NET_TIMEOUT_MS,
  }
  const httpAgent = new http.Agent(opts)
  const httpsAgent = new https.Agent(opts)
  for (const agent of [httpAgent, httpsAgent] as unknown as { createConnection: Connect }[])
    agent.createConnection = guardedConnect(rule, agent.createConnection.bind(agent))
  return { httpAgent, httpsAgent }
}
