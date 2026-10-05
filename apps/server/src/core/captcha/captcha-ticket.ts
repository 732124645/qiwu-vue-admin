import { createHash, randomBytes } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import type { CaptchaScene } from '@qiwu/shared'
import { redisKey } from '../redis/cache-namespaces.js'
import { REDIS, type Redis } from '../redis/redis.module.js'

export const CAPTCHA_TTL_SEC = 120

/**
 * A blank ticket returns false without Redis access. Otherwise GETDEL the key
 * redisKey('captcha', 'ticket', sha256(ticket)), whose value is {scene, ip}.
 * Return true only when both stored fields match; GETDEL consumes the ticket even on a mismatch.
 * The caller decides whether captcha.mode or cross-IP escalation requires a ticket at all.
 */
@Injectable()
export class CaptchaTicketVerifier {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async issue(scene: CaptchaScene, ip: string): Promise<string> {
    const ticket = randomBytes(32).toString('base64url')
    await this.redis.set(this.key(ticket), JSON.stringify({ scene, ip }), { EX: CAPTCHA_TTL_SEC })
    return ticket
  }

  async verify(
    scene: CaptchaScene,
    ip: string,
    ticket: string | null | undefined,
  ): Promise<boolean> {
    if (!ticket?.trim()) return false
    const stored = await this.redis.getDel(this.key(ticket))
    if (!stored) return false
    try {
      const value: unknown = JSON.parse(stored)
      return (
        typeof value === 'object' &&
        value !== null &&
        'scene' in value &&
        'ip' in value &&
        value.scene === scene &&
        value.ip === ip
      )
    } catch {
      return false
    }
  }

  private key(ticket: string): string {
    return redisKey('captcha', 'ticket', createHash('sha256').update(ticket).digest('hex'))
  }
}
