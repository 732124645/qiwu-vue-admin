import { expect, test } from '../e2e/fixtures.ts'
import { serverDir, e2eServerEnv, TENANT_B } from '../e2e/env.ts'
import {
  cleanupIm,
  desktopScript,
  imBearer,
  seedImUsers,
  type ImFixture,
} from '../e2e/im-fixtures.ts'

const run = desktopScript(serverDir, e2eServerEnv(serverDir, true))
let a: ImFixture, b: ImFixture
test.beforeAll(() => {
  const tag = Date.now() % 100000
  a = seedImUsers(run, `mediaa${tag}`, ['ann', 'ben'])
  b = seedImUsers(run, `mediab${tag}`, ['cat'], TENANT_B.code)
})
test.afterAll(() => {
  cleanupIm(run, a)
  cleanupIm(run, b)
})

test('another tenant cannot upload voice or start a call in a known room', async ({ request }) => {
  const own = await imBearer(request, a.users[0]!),
    other = await imBearer(request, b.users[0]!, TENANT_B.code)
  const created = await request.post('/api/im/rooms/directs', {
    headers: own,
    data: { peerId: a.users[1]!.id },
  })
  expect(created.ok(), await created.text()).toBe(true)
  const id = (await created.json()).data.roomId as number
  const voice = await request.post(`/api/im/rooms/${id}/voice-uploads`, {
    headers: other,
    multipart: {
      file: { name: 'voice.wav', mimeType: 'audio/wav', buffer: Buffer.from('not-audio') },
    },
  })
  expect(voice.status()).toBe(404)
  const call = await request.post(`/api/im/rooms/${id}/calls`, {
    headers: other,
    data: { clientCallId: `foreign_${Date.now()}`, mode: 'audio' },
  })
  expect(call.status()).toBe(404)
})
