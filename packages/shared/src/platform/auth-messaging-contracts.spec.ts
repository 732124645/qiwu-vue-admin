import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  authMobile,
  signupBody,
  smsCodeBody,
  smsOtpCode,
  smsResetPasswordBody,
} from '../common/auth.js'
import {
  CAPTCHA_MODES,
  CAPTCHA_SCENES,
  captchaChallengeVo,
  captchaCheckBody,
  captchaQuery,
} from '../common/captcha.js'
import { myInboxQuery } from './messaging/inbox-mine.schema.js'
import {
  inboxTemplateTestBody,
  mailTemplateTestBody,
  smsTemplateTestBody,
} from './messaging/messaging.schema.js'

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success

describe('captcha, OTP, signup and messaging contracts', () => {
  it('restricts captcha modes and scenes', () => {
    expect(CAPTCHA_MODES).toEqual(['off', 'image', 'slider'])
    expect(CAPTCHA_SCENES).toEqual(['signin', 'signup', 'sms_send'])
    expect(ok(z.enum(CAPTCHA_MODES), 'puzzle')).toBe(false)
    expect(ok(captchaQuery, { scene: 'sms_send' })).toBe(true)
    expect(ok(captchaQuery, { scene: 'password_reset' })).toBe(false)
  })

  it('checks both answer types and server-made IDs', () => {
    const id = 'aB12_cd-Ef34_gh5'
    expect(captchaCheckBody.parse({ id, answer: '  a1  ' }).answer).toBe('a1')
    expect(ok(captchaCheckBody, { id, answer: { x: 0, y: 1000 } })).toBe(true)
    for (const answer of [
      '',
      '123456789',
      { x: -1, y: 1 },
      { x: 2.5, y: 1 },
      { x: 1, y: 1001 },
      [],
    ])
      expect(ok(captchaCheckBody, { id, answer })).toBe(false)
    expect(ok(captchaCheckBody, { id: 'short', answer: 'a' })).toBe(false)
    expect(ok(captchaCheckBody, { id: 'a'.repeat(65), answer: 'a' })).toBe(false)
    expect(ok(captchaCheckBody, { id: 'a'.repeat(15) + '!', answer: 'a' })).toBe(false)
  })

  it('discriminates image and slider payloads', () => {
    const id = 'aB12_cd-Ef34_gh5'
    const image = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='
    expect(ok(captchaChallengeVo, { kind: 'image', id, image })).toBe(true)
    expect(
      ok(captchaChallengeVo, {
        kind: 'slider',
        id,
        image: 'data:image/png;base64,eA==',
        thumb: 'data:image/png;base64,eA==',
        thumbX: 10,
        thumbY: 20,
        thumbWidth: 30,
        thumbHeight: 30,
      }),
    ).toBe(true)
    expect(ok(captchaChallengeVo, { kind: 'slider', id, image })).toBe(false)
    expect(ok(captchaChallengeVo, { kind: 'audio', id, image })).toBe(false)
  })

  it('validates OTP mobile, codes and scenes', () => {
    expect(ok(authMobile, '+12345-67890')).toBe(true)
    for (const mobile of ['1234', 'abc123456', '+12 34567'])
      expect(ok(authMobile, mobile)).toBe(false)
    expect(ok(smsOtpCode, '012345')).toBe(true)
    for (const code of ['12345', '1234567', '12345a']) expect(ok(smsOtpCode, code)).toBe(false)
    expect(ok(smsCodeBody, { mobile: '+123456789', scene: 'signin' })).toBe(true)
    expect(ok(smsCodeBody, { mobile: '+123456789', scene: 'unknown' })).toBe(false)
  })

  it('applies the supplied password policy to signup and SMS reset', () => {
    const policy = { minLength: 12, charClasses: 2, expireDays: 0 }
    expect(ok(signupBody(policy), { username: 'alice', password: 'shortA1' })).toBe(false)
    expect(ok(signupBody(policy), { username: 'alice', password: 'longEnoughA1' })).toBe(true)
    expect(
      ok(smsResetPasswordBody(policy), {
        mobile: '+123456789',
        code: '123456',
        newPassword: 'shortA1',
      }),
    ).toBe(false)
    expect(
      ok(smsResetPasswordBody(policy), {
        mobile: '+123456789',
        code: '123456',
        newPassword: 'longEnoughA1',
      }),
    ).toBe(true)
  })

  it('bounds test-send params and recipients', () => {
    expect(inboxTemplateTestBody.parse({})).toEqual({ params: {} })
    expect(
      ok(inboxTemplateTestBody, {
        params: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v'])),
      }),
    ).toBe(false)
    expect(ok(inboxTemplateTestBody, { params: { 'bad-name': 'v' } })).toBe(false)
    expect(ok(inboxTemplateTestBody, { params: { key: 'x'.repeat(501) } })).toBe(false)
    expect(ok(mailTemplateTestBody, { to: 'a@example.com', params: { name: 'A' } })).toBe(true)
    expect(ok(mailTemplateTestBody, { to: 'bad' })).toBe(false)
    expect(ok(mailTemplateTestBody, { to: `${'a'.repeat(120)}@example.com` })).toBe(false)
    expect(ok(smsTemplateTestBody, { mobile: '+123456789' })).toBe(true)
    expect(ok(smsTemplateTestBody, { mobile: 'bad' })).toBe(false)
  })

  it('parses the unread query string as a boolean', () => {
    expect(myInboxQuery.parse({ unread: 'false' }).unread).toBe(false)
    expect(ok(myInboxQuery, { category: 'unknown' })).toBe(false)
  })
})
