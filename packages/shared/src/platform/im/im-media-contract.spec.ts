import { expect, it } from 'vitest'
import { IM_INT_PARAMS } from '../../common/params.js'
import {
  imCallAction,
  imCallCreate,
  imCallHint,
  imCallSummaryVo,
  IM_CALL_LIMITS,
  IM_VOICE_LIMITS,
} from './im-media.schema.js'
import { IM_COUNTED_KINDS, imEntrySend, imEventVo } from './im.schema.js'

it('accepts voice objects and counts them as messages while rejecting client duration and unrelated fields', () => {
  expect(imEntrySend.parse({ clientEntryId: 'voice-one', kind: 'voice', objectId: 3 })).toEqual({
    clientEntryId: 'voice-one',
    kind: 'voice',
    objectId: 3,
  })
  expect(IM_COUNTED_KINDS).toContain('voice')
  for (const extra of [
    { durationMs: 5000 },
    { text: 'fake duration' },
    { stickerId: 1 },
    { token: 'example' },
  ]) {
    expect(
      imEntrySend.safeParse({ clientEntryId: 'voice-one', kind: 'voice', objectId: 3, ...extra })
        .success,
    ).toBe(false)
  }
  expect(imEntrySend.safeParse({ clientEntryId: 'voice-one', kind: 'voice' }).success).toBe(false)
})

it('requires a stable call request id, supported mode and a bounded distinct invitation list', () => {
  for (const mode of ['audio', 'video']) {
    expect(imCallCreate.safeParse({ clientCallId: 'request-one', mode }).success).toBe(true)
    expect(
      imCallCreate.safeParse({ clientCallId: 'request-one', mode, userIds: [1, 2, 3, 4, 5, 6, 7] })
        .success,
    ).toBe(true)
  }
  for (const patch of [
    { clientCallId: '' },
    { clientCallId: 'a'.repeat(65) },
    { clientCallId: 'bad/id' },
    { mode: 'screen' },
    { userIds: [] },
    { userIds: [2, 2] },
    { userIds: [0] },
    { userIds: [1, 2, 3, 4, 5, 6, 7, 8] },
    { sid: 'injected' },
    { mediaRoom: 'injected' },
  ]) {
    expect(
      imCallCreate.safeParse({ clientCallId: 'request-one', mode: 'audio', ...patch }).success,
    ).toBe(false)
  }
})

it('does not accept client-supplied session binding, participation or grant authority in call actions', () => {
  expect(imCallAction.parse({})).toEqual({})
  for (const body of [
    { sid: 'example' },
    { userId: 7 },
    { state: 'accepted' },
    { token: 'example' },
    { roomCreate: true },
  ]) {
    expect(imCallAction.safeParse(body).success).toBe(false)
  }
})

it('keeps realtime call hints free of credentials and records only a bounded terminal summary', () => {
  expect(imCallHint.parse({ callId: 1, roomId: 2, rev: 3 })).toEqual({
    callId: 1,
    roomId: 2,
    rev: 3,
  })
  expect(imCallHint.safeParse({ callId: 1, roomId: 2, rev: 3, token: 'example' }).success).toBe(
    false,
  )
  expect(imCallHint.safeParse({ callId: 1, roomId: 2, rev: 0 }).success).toBe(false)
  const call = { callId: 1, mode: 'audio', endReason: 'no_answer', durationSeconds: 0 }
  expect(imEventVo.safeParse({ code: 'call.ended', actorId: null, call }).success).toBe(true)
  expect(
    imCallSummaryVo.safeParse({ ...call, durationSeconds: IM_CALL_LIMITS.maxSeconds + 1 }).success,
  ).toBe(false)
  expect(imCallSummaryVo.safeParse({ ...call, durationSeconds: -1 }).success).toBe(false)
  expect(imCallSummaryVo.safeParse({ ...call, sid: 'example' }).success).toBe(false)
})

it('shares voice bounds between upload, parsing and client recording without changing call grant lifetime', () => {
  expect(IM_INT_PARAMS.voiceMaxSeconds).toMatchObject({
    min: 1,
    max: IM_VOICE_LIMITS.maxSeconds,
    fallback: IM_VOICE_LIMITS.defaultSeconds,
  })
  expect(IM_INT_PARAMS.voiceMaxMb).toMatchObject({
    min: 1,
    max: IM_VOICE_LIMITS.maxMb,
    fallback: IM_VOICE_LIMITS.defaultMb,
  })
  expect(IM_CALL_LIMITS.grantSeconds).toBe(60)
  expect(IM_CALL_LIMITS.participants).toBe(8)
})
