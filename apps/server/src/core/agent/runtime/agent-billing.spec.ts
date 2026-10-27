import { usageOf } from '../provider/usage.js'
import { chargeCredits, creditLimitReached, creditMicros, creditString } from './billing.js'

const pricing = {
  input: '1.5',
  output: '3',
  cacheRead: '0.1',
  cacheWrite: '2',
  imageCredits: null,
}

it('keeps reported zero, unknown counters and the bounded numeric vendor details distinct', () => {
  const usage = usageOf({
    prompt_tokens: 1000,
    completion_tokens: 250,
    total_tokens: 1250,
    prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 100, audio_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 70, accepted_prediction_tokens: 3 },
    private_message: 'must not enter usage',
  })
  expect(usage).toMatchObject({
    promptTokens: 1000,
    completionTokens: 250,
    cacheReadTokens: 200,
    cacheWriteTokens: 100,
    reasoningTokens: 70,
    inputDetails: { audio_tokens: 0 },
    outputDetails: { accepted_prediction_tokens: 3 },
    usageReported: true,
  })
  expect(usage.rawUsage).not.toHaveProperty('private_message')
  expect(chargeCredits(pricing, usage)).toBe('0.002020')
  expect(usageOf(undefined)).toMatchObject({
    promptTokens: null,
    completionTokens: null,
    cacheReadTokens: null,
    rawUsage: null,
    usageReported: false,
  })
  expect(usageOf({ prompt_tokens: 0, completion_tokens: 0 })).toMatchObject({
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: null,
    usageReported: true,
  })
})

it('normalizes compatible cache counters and image dimensions without inventing missing tokens', () => {
  expect(
    usageOf({ prompt_tokens: 30, completion_tokens: 10, prompt_cache_hit_tokens: 20 }),
  ).toMatchObject({ promptTokens: 30, completionTokens: 10, cacheReadTokens: 20 })
  expect(
    usageOf(
      {
        input_tokens: 40,
        output_tokens: 80,
        input_tokens_details: { text_tokens: 10, image_tokens: 30 },
        output_tokens_details: { image_tokens: 80 },
      },
      true,
    ),
  ).toMatchObject({
    promptTokens: 40,
    completionTokens: 80,
    inputDetails: { text_tokens: 10, image_tokens: 30 },
    outputDetails: { image_tokens: 80 },
  })
  expect(usageOf({ prompt_tokens: -1, completion_tokens: 1.2 })).toMatchObject({
    promptTokens: null,
    completionTokens: null,
  })
})

it('preserves cache creation and multimodal detail with standard counters taking precedence', () => {
  const usage = usageOf({
    prompt_tokens: 120,
    completion_tokens: 30,
    prompt_tokens_details: {
      cached_tokens: 20,
      created_cache_tokens: 60,
      multimodal_tokens: { image: 10, audio: 5, video: 8 },
    },
  })
  expect(usage).toMatchObject({
    cacheWriteTokens: 60,
    inputDetails: { image_tokens: 10, audio_tokens: 5, video_tokens: 8 },
    rawUsage: { prompt_tokens_details: { multimodal_tokens: { image: 10, audio: 5, video: 8 } } },
    totalTokens: 150,
  })
  expect(
    usageOf({ prompt_tokens_details: { cache_write_tokens: 0, created_cache_tokens: 60 } }),
  ).toMatchObject({ cacheWriteTokens: 0 })
})

it('charges reasoning within output and rounds once per complete call', () => {
  const usage = usageOf({
    prompt_tokens: 1,
    completion_tokens: 1,
    completion_tokens_details: { reasoning_tokens: 1 },
  })
  expect(
    chargeCredits(
      {
        input: '0.333333',
        output: '0.333333',
        cacheRead: null,
        cacheWrite: null,
        imageCredits: null,
      },
      usage,
    ),
  ).toBe('0.000001')
})

it('charges missing or impossible cache details at the highest input rate and never treats unknown consumption as free', () => {
  const usage = usageOf({ prompt_tokens: 10, completion_tokens: 5 })
  // 缓存写入费率 2 是三项输入费率里最高的：10 × 2 + 5 × 3
  expect(chargeCredits(pricing, usage)).toBe('0.000035')
  expect(chargeCredits({ ...pricing, cacheRead: null, cacheWrite: null }, usage)).toBe('0.000030')
  expect(chargeCredits({ ...pricing, cacheRead: '1.5', cacheWrite: '1.5' }, usage)).toBe('0.000030')
  expect(chargeCredits(null, usage)).toBeNull()
  expect(
    chargeCredits({ ...pricing, cacheRead: null, cacheWrite: null }, usageOf(undefined)),
  ).toBeNull()
  expect(
    chargeCredits(
      pricing,
      usageOf({
        prompt_tokens: 10,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 11, cache_write_tokens: 0 },
      }),
    ),
  ).toBe('0.000035')
})

it('prices a reported total that disagrees by input plus output, adding reasoning the output left out', () => {
  const rates = { ...pricing, cacheRead: null, cacheWrite: null }
  // total 与 10 + 5 不符：不放弃，按 10 × 1.5 + 5 × 3
  expect(
    chargeCredits(rates, usageOf({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 99 })),
  ).toBe('0.000030')
  // 推理 8 超过输出 5：输出没含推理，按 5 + 8 计
  expect(
    chargeCredits(
      rates,
      usageOf({
        prompt_tokens: 10,
        completion_tokens: 5,
        completion_tokens_details: { reasoning_tokens: 8 },
      }),
    ),
  ).toBe('0.000054')
})

it('uses an explicit image price only when token charging is unavailable', () => {
  const image = { ...pricing, imageCredits: '2.5', cacheRead: null, cacheWrite: null }
  expect(chargeCredits(image, null, 'image')).toBe('2.500000')
  expect(chargeCredits(image, usageOf(undefined, true), 'image')).toBe('2.500000')
  expect(chargeCredits(image, usageOf({ input_tokens: 0, output_tokens: 0 }, true), 'image')).toBe(
    '0.000000',
  )
  expect(chargeCredits(pricing, null, 'image')).toBeNull()
})

it('recognizes explicit free pricing without inventing unknown tokens, while image fallback takes precedence', () => {
  const free = { input: '0', output: '0', cacheRead: null, cacheWrite: '0', imageCredits: null }
  const unknown = usageOf(undefined)
  expect(chargeCredits(free, unknown)).toBe('0.000000')
  expect(unknown.promptTokens).toBeNull()
  expect(unknown.usageReported).toBe(false)
  expect(chargeCredits({ ...free, imageCredits: '3' }, unknown, 'image')).toBe('3.000000')
  expect(chargeCredits({ ...free, cacheRead: '0.1' }, unknown)).toBeNull()
})

it('enforces finite credit thresholds, preserves unlimited and bounds decimal storage exactly', () => {
  expect(creditLimitReached('9.999999', '10')).toBe(false)
  expect(creditLimitReached('10', '10')).toBe(true)
  expect(creditLimitReached('0', '10')).toBe(false)
  expect(creditLimitReached('999', '0')).toBe(false)
  expect(creditString(creditMicros('999999999999999999.999999'))).toBe('999999999999999999.999999')
  expect(() => creditString(10n ** 24n)).toThrow('out of range')
  expect(() => creditMicros('1.0000001')).toThrow('invalid')
  expect(() => creditMicros('-1')).toThrow('invalid')
})
