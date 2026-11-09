import { expect, test, msg } from './fixtures.ts'
import { serverDir, serverEnv } from './env.ts'
import {
  cleanupIm,
  desktopScript,
  imBearer,
  imSignIn,
  seedImUsers,
  type ImFixture,
} from './im-fixtures.ts'

const run = desktopScript(serverDir, serverEnv)
let fixture: ImFixture
/** 合成静音测试样本，不采集设备，也不在产品里实现音频编码。 */
function sample() {
  const data = Buffer.alloc(44 + 64000)
  data.write('RIFF')
  data.writeUInt32LE(data.length - 8, 4)
  data.write('WAVEfmt ', 8)
  data.writeUInt32LE(16, 16)
  data.writeUInt16LE(1, 20)
  data.writeUInt16LE(1, 22)
  data.writeUInt32LE(16000, 24)
  data.writeUInt32LE(32000, 28)
  data.writeUInt16LE(2, 32)
  data.writeUInt16LE(16, 34)
  data.write('data', 36)
  data.writeUInt32LE(64000, 40)
  return data
}
test.beforeAll(() => {
  fixture = seedImUsers(run, `voice${Date.now() % 100000}`, ['ann', 'ben'])
})
test.afterAll(() => cleanupIm(run, fixture))

test('voice uses authoritative duration, authenticated cached playback and recalled content disappears', async ({
  page,
  request,
}) => {
  const headers = await imBearer(request, fixture.users[0]!)
  const roomResponse = await request.post('/api/im/rooms/directs', {
    headers,
    data: { peerId: fixture.users[1]!.id },
  })
  expect(roomResponse.ok(), await roomResponse.text()).toBe(true)
  const room = (await roomResponse.json()).data.roomId as number
  const upload = await request.post(`/api/im/rooms/${room}/voice-uploads`, {
    headers,
    multipart: { file: { name: 'voice.wav', mimeType: 'audio/wav', buffer: sample() } },
  })
  expect(upload.ok(), await upload.text()).toBe(true)
  const objectId = (await upload.json()).data.objectId as number
  const sent = await request.post(`/api/im/rooms/${room}/entries`, {
    headers,
    data: { clientEntryId: `voice_${Date.now()}`, kind: 'voice', objectId },
  })
  expect(sent.ok(), await sent.text()).toBe(true)
  const entry = (await sent.json()).data
  expect(entry.attachment.durationMs).toBe(2000)
  await imSignIn(page, fixture.users[0]!)
  await page
    .getByRole('button', { name: new RegExp(fixture.users[1]!.username) })
    .first()
    .click()
  const play = page.getByRole('button', { name: msg('im.voice.play', 'zh-CN', { seconds: 2 }) })
  await expect(play).toBeVisible()
  const file = page.waitForResponse(
    (r) => r.url().includes(`/entries/${entry.seq}/file`) && r.request().method() === 'GET',
  )
  await play.click()
  expect((await file).ok()).toBe(true)
  await request.post(`/api/im/rooms/${room}/entries/${entry.seq}/recall`, { headers })
  await expect(play).toHaveCount(0)
  await expect(page.getByText(msg('im.message.recalledMine'))).toBeVisible()
})
