import { Controller, Post, UploadedFile } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { UploadFile, type UploadedFileData } from '../../src/core/http/upload.js'
import { ParamService } from '../../src/core/settings/param.service.js'

@Controller()
class UploadFixture {
  @Post('voice')
  @UploadFile('file', 'im.voice.max_mb', 5, 20)
  voice(@UploadedFile() file: UploadedFileData) {
    return { size: file.size }
  }

  @Post('generic')
  @UploadFile('file', 'storage.max_size_mb', 20)
  generic(@UploadedFile() file: UploadedFileData) {
    return { size: file.size }
  }
}

describe('bounded multipart uploads', () => {
  let app: INestApplication
  let configured = 1
  const int = vi.fn<ParamService['int']>(async (_key, min, max, fallback) =>
    configured >= min && configured <= max ? configured : fallback,
  )
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [UploadFixture],
      providers: [{ provide: ParamService, useValue: { int } }],
    }).compile()
    app = module.createNestApplication()
    await app.init()
  })
  afterAll(async () => {
    await app.close()
  })
  beforeEach(() => {
    configured = 1
    int.mockClear()
  })

  it('rejects bytes above the route limit before invoking the handler', async () => {
    await request(app.getHttpServer())
      .post('/voice')
      .attach('file', Buffer.alloc(1024 * 1024 + 1), 'clip.wav')
      .expect(413)
    expect(int).toHaveBeenCalledWith('im.voice.max_mb', 1, 20, 5)
    const r = await request(app.getHttpServer())
      .post('/voice')
      .attach('file', Buffer.alloc(1024), 'clip.wav')
      .expect(201)
    expect(r.body).toEqual({ size: 1024 })
  })

  it('an invalid stored voice setting falls back before buffering a large upload', async () => {
    configured = 1000
    await request(app.getHttpServer())
      .post('/voice')
      .attach('file', Buffer.alloc(5 * 1024 * 1024 + 1), 'clip.wav')
      .expect(413)
    expect(int).toHaveBeenCalledWith('im.voice.max_mb', 1, 20, 5)
  })

  it('existing upload routes retain their ordinary ceiling', async () => {
    await request(app.getHttpServer())
      .post('/generic')
      .attach('file', Buffer.alloc(8), 'file.txt')
      .expect(201)
    expect(int).toHaveBeenCalledWith('storage.max_size_mb', 1, 2048, 20)
  })
})
