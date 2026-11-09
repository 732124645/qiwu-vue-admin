import request from 'supertest'
import { bearer } from '../setup/auth.js'
import { signInDirect } from '../setup/tenants.js'
import { ImMediaKit, pcmVoice } from './im-media-kit.js'
import { ImObjectsService } from '../../src/modules/platform/im/im-objects.service.js'
import { PermVersion } from '../../src/core/auth/perm-version.js'

const kit = new ImMediaKit()
beforeAll(() => kit.boot())
beforeEach(() => kit.clearThrottle())
afterAll(() => kit.close())

async function upload(room: number, user: number, data = pcmVoice(0.2)) {
  return request(kit.app.getHttpServer())
    .post(`/api/im/rooms/${room}/voice-uploads`)
    .set(bearer(await kit.token(user)))
    .field('durationMs', '1')
    .attach('file', data, { filename: 'untrusted.wav', contentType: 'image/png' })
}

it('rejects missing file data and nonemployee access before handling an upload', async () => {
  const a = await kit.person('input-a'),
    b = await kit.person('input-b'),
    room = await kit.direct(a, b)
  await request(kit.app.getHttpServer())
    .post(`/api/im/rooms/${room}/voice-uploads`)
    .set(bearer(await kit.token(a)))
    .send({})
    .expect(400)
  const member = await kit.person('voice-member'),
    token = await kit.token(member)
  await kit.ds.query("UPDATE iam_user SET user_type='member' WHERE tenant_id=1 AND id=?", [member])
  await kit.app.get(PermVersion).bumpUser(member)
  await request(kit.app.getHttpServer())
    .post(`/api/im/rooms/${room}/voice-uploads`)
    .set(bearer(token))
    .attach('file', pcmVoice(), 'voice.wav')
    .expect(403)
})

it('uses actual PCM duration and the existing private attachment/seq/read/recall chain', async () => {
  const a = await kit.person('voice-a'),
    b = await kit.person('voice-b'),
    room = await kit.direct(a, b)
  const file = await upload(room, a)
  expect(file.status).toBe(201)
  expect(file.body.data.durationMs).toBe(200)
  const objectId = file.body.data.objectId
  const clientEntryId = `voice-${objectId}`
  const sent = await kit.call('post', `/rooms/${room}/entries`, a, {
    clientEntryId,
    kind: 'voice',
    objectId,
  })
  expect(sent.status).toBe(201)
  expect(sent.body.data.attachment.durationMs).toBe(200)
  const seq = sent.body.data.seq
  await kit.clearDuplicateGuard()
  const replay = await kit.call('post', `/rooms/${room}/entries`, a, {
    clientEntryId,
    kind: 'voice',
    objectId,
  })
  expect(replay.body.data.seq).toBe(seq)
  const received = await kit.call('get', `/rooms/${room}/entries?afterSeq=0`, b)
  expect(received.body.data.items).toContainEqual(
    expect.objectContaining({
      seq,
      kind: 'voice',
      attachment: expect.objectContaining({ durationMs: 200 }),
    }),
  )
  const detail = await kit.call('get', `/sync?ids=${room}`, b)
  expect(detail.body.data[0].unread).toBe(1)
  expect(detail.body.data[0].preview.kind).toBe('voice')
  const bytes = await kit.call('get', `/rooms/${room}/entries/${seq}/file?proxy=1`, b)
  expect(bytes.status).toBe(200)
  expect(bytes.headers['content-type']).toMatch(/audio\/(wav|x-wav|wave)/)
  for (const suffix of ['', '/download', '/content']) {
    expect(
      (
        await request(kit.app.getHttpServer())
          .get(`/api/storage/objects/${objectId}${suffix}`)
          .set(bearer(await kit.token(a)))
      ).status,
    ).not.toBe(200)
  }
  expect(
    (await kit.call('post', `/rooms/${room}/entries/${seq}/recall`, a)).body.data.attachment,
  ).toBeNull()
  expect((await kit.call('get', `/rooms/${room}/entries/${seq}/file?proxy=1`, b)).status).toBe(404)
})

it('rejects fake duration, nonvoice objects, forged PCM headers and current limit violations', async () => {
  const a = await kit.person('invalid-a'),
    b = await kit.person('invalid-b'),
    room = await kit.direct(a, b)
  for (const data of [
    Buffer.from('not a wave'),
    pcmVoice(0.1, 48000),
    pcmVoice(0.1, 16000, 1, 32, 3),
  ])
    expect((await upload(room, a, data)).status).toBe(422)
  const good = await upload(room, a)
  expect(
    (
      await kit.call('post', `/rooms/${room}/entries`, a, {
        clientEntryId: 'fake-duration',
        kind: 'voice',
        objectId: good.body.data.objectId,
        durationMs: 1,
      })
    ).status,
  ).toBe(400)
  await kit.param('im.voice.max_seconds', '1')
  expect((await upload(room, a, pcmVoice(1.1))).status).toBe(422)
  await kit.param('im.voice.max_seconds', '60')
  const text = await request(kit.app.getHttpServer())
    .post(`/api/im/rooms/${room}/uploads`)
    .set(bearer(await kit.token(a)))
    .attach('file', Buffer.from('a text'), 'plain.txt')
  expect(text.status).toBe(201)
  expect(
    (
      await kit.call('post', `/rooms/${room}/entries`, a, {
        clientEntryId: 'fake-voice-file',
        kind: 'voice',
        objectId: text.body.data.objectId,
      })
    ).status,
  ).toBe(422)
})

it('enforces uploader ownership, current membership, closed-room and cross-tenant boundaries', async () => {
  const a = await kit.person('scope-a'),
    b = await kit.person('scope-b'),
    outsider = await kit.person('scope-out')
  const room = await kit.group(a, [b]),
    file = await upload(room, a)
  expect(
    (
      await kit.call('post', `/rooms/${room}/entries`, b, {
        clientEntryId: 'stolen-voice',
        kind: 'voice',
        objectId: file.body.data.objectId,
      })
    ).status,
  ).toBe(400)
  expect((await upload(room, outsider)).status).toBe(404)
  const foreign = (await signInDirect(kit.app, kit.other.users.alice))!.accessToken
  expect(
    (
      await request(kit.app.getHttpServer())
        .post(`/api/im/rooms/${room}/voice-uploads`)
        .set(bearer(foreign))
        .attach('file', pcmVoice(), 'voice.wav')
    ).status,
  ).toBe(404)
  expect(
    (
      await request(kit.app.getHttpServer())
        .post(`/api/im/rooms/${room}/entries`)
        .set(bearer(foreign))
        .send({ clientEntryId: 'foreign-voice', kind: 'voice', objectId: file.body.data.objectId })
    ).status,
  ).toBe(404)
  await kit.call('post', `/rooms/${room}/close`, a)
  await kit.clearDuplicateGuard()
  expect((await upload(room, a)).status).toBe(409)
})

it('rejects an oversized body before voice handling even when the stored voice limit is invalidly huge', async () => {
  const a = await kit.person('ceiling-a'),
    b = await kit.person('ceiling-b'),
    room = await kit.direct(a, b)
  await kit.param('im.voice.max_mb', '1000')
  const spy = vi.spyOn(kit.app.get(ImObjectsService), 'uploadVoice')
  try {
    expect((await upload(room, a, Buffer.alloc(6 * 1024 * 1024))).status).toBe(413)
    expect(spy).not.toHaveBeenCalled()
  } finally {
    spy.mockRestore()
    await kit.param('im.voice.max_mb', '5')
  }
})
