import { randomBytes } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import sharp from 'sharp'
import {
  CAPTCHA_IMAGE_TYPE_PARAM,
  CAPTCHA_MODE_PARAM,
  CAPTCHA_MODES,
  DEFAULT_CAPTCHA_IMAGE_TYPE,
  DEFAULT_CAPTCHA_MODE,
  Err,
  type CaptchaCheckBody,
  type CaptchaChallengeVo,
  type CaptchaMode,
  type CaptchaQuery,
  type CaptchaScene,
  type CaptchaTicketVo,
} from '@qiwu/shared'
import { BizError } from '../http/biz-error.js'
import { redisKey } from '../redis/cache-namespaces.js'
import { REDIS, type Redis } from '../redis/redis.module.js'
import { ParamService } from '../settings/param.service.js'
import { makeCharsChallenge, makeMathChallenge, renderCaptchaSvg } from './captcha-image.js'
import { sliderChallenge } from './captcha-slider.js'
import { CAPTCHA_TTL_SEC, CaptchaTicketVerifier } from './captcha-ticket.js'

type StoredChallenge =
  | { scene: CaptchaScene; kind: 'image'; answer: string }
  | { scene: CaptchaScene; kind: 'slider'; answer: { x: number; y: number } }

export const SLIDER_TOLERANCE_PX = 5

/** Issues 120 s challenges and GETDEL-checks each attempt before issuing a scene/IP-bound ticket. */
@Injectable()
export class CaptchaService {
  constructor(
    private readonly params: ParamService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly tickets: CaptchaTicketVerifier,
  ) {}

  async mode(): Promise<CaptchaMode> {
    const raw = (await this.params.get(CAPTCHA_MODE_PARAM))?.trim()
    return CAPTCHA_MODES.find((mode) => mode === raw) ?? DEFAULT_CAPTCHA_MODE
  }

  /**
   * A new challenge of the current mode. An image challenge is an SVG data URI, or with `format: 'png'`
   * (mini programs may not show SVG data URIs) the same SVG rasterised at 2x by sharp.
   */
  async challenge(
    scene: CaptchaScene,
    format: CaptchaQuery['format'] = 'svg',
  ): Promise<CaptchaChallengeVo> {
    const id = randomBytes(18).toString('base64url')
    if ((await this.mode()) === 'slider') {
      const { answer, ...challenge } = await sliderChallenge()
      const stored: StoredChallenge = { scene, kind: 'slider', answer }
      await this.redis.set(redisKey('captcha', id), JSON.stringify(stored), { EX: CAPTCHA_TTL_SEC })
      return { kind: 'slider', id, ...challenge }
    }
    const imageType =
      (await this.params.get(CAPTCHA_IMAGE_TYPE_PARAM))?.trim() || DEFAULT_CAPTCHA_IMAGE_TYPE
    const { text, answer } = imageType === 'chars' ? makeCharsChallenge() : makeMathChallenge()
    const stored: StoredChallenge = { scene, kind: 'image', answer }
    await this.redis.set(redisKey('captcha', id), JSON.stringify(stored), { EX: CAPTCHA_TTL_SEC })
    const svg = Buffer.from(renderCaptchaSvg(text))
    const image =
      format === 'png'
        ? `data:image/png;base64,${(await sharp(svg, { density: 144 }).png().toBuffer()).toString('base64')}`
        : `data:image/svg+xml;base64,${svg.toString('base64')}`
    return { kind: 'image', id, image }
  }

  async check(body: CaptchaCheckBody, ip: string): Promise<CaptchaTicketVo> {
    const raw = await this.redis.getDel(redisKey('captcha', body.id))
    if (!raw) throw new BizError(Err.AUTH_CAPTCHA_INVALID)
    let stored: StoredChallenge
    try {
      stored = JSON.parse(raw) as StoredChallenge
    } catch {
      throw new BizError(Err.AUTH_CAPTCHA_INVALID)
    }
    if (!stored || typeof stored !== 'object') throw new BizError(Err.AUTH_CAPTCHA_INVALID)
    const valid =
      stored.kind === 'slider'
        ? typeof body.answer === 'object' &&
          body.answer !== null &&
          typeof stored.answer === 'object' &&
          stored.answer !== null &&
          typeof stored.answer.x === 'number' &&
          typeof stored.answer.y === 'number' &&
          Math.abs(body.answer.x - stored.answer.x) <= SLIDER_TOLERANCE_PX &&
          Math.abs(body.answer.y - stored.answer.y) <= SLIDER_TOLERANCE_PX
        : typeof body.answer === 'string' &&
          stored.kind === 'image' &&
          typeof stored.answer === 'string' &&
          body.answer.trim().toUpperCase() === stored.answer.toUpperCase()
    if (!valid) throw new BizError(Err.AUTH_CAPTCHA_INVALID)
    return { captchaTicket: await this.tickets.issue(stored.scene, ip) }
  }
}
