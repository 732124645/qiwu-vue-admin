// storage S3Storage (see docs/design-notes.md#storage, #security): requests through the core/net guarded agents, checksums
// only when required, path-style or virtual-hosted URLs, public/ and private/ areas, publicDomain
// links, 60 s presigned downloads and the test connection; direct upload's check-then-publish bound to
// one ETag, reads capped. No S3 service: a middleware at the innermost (deserialize) step records the
// signed request and answers a fake response.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { OUTBOUND_PORTS, OutboundRefused } from '../../src/core/net/net-guard.js'
import {
  type S3Config,
  S3_DOWNLOAD_TTL_SEC,
  S3Storage,
} from '../../src/modules/platform/storage/s3-storage.js'

interface SeenRequest {
  method: string
  hostname: string
  port?: number
  path: string
  headers: Record<string, string>
}

const CFG: S3Config = {
  endpoint: 'https://s3.example.com',
  region: 'us-east-1',
  bucket: 'qw-files',
  accessKey: 'AKIDEXAMPLE',
  secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  forcePathStyle: true,
  publicDomain: 'https://cdn.example.com/',
}
const KEY = '2026/09/28/0b6f7a3e-1d2c-4e5f-8a9b-0c1d2e3f4a5b.png'

/** Answers every request of `s3` with `status` (+ an XML body) and records what would have been sent. */
function fake(s3: S3Storage, status = 200, body = '') {
  const seen: SeenRequest[] = []
  s3.client.middlewareStack.add(
    () => async (args) => {
      seen.push(args.request as SeenRequest)
      return {
        response: {
          statusCode: status,
          headers: body ? { 'content-type': 'application/xml' } : {},
          body: Readable.from([Buffer.from(body)]),
        },
        output: undefined,
      } as never
    },
    { step: 'deserialize', priority: 'low', name: 'qwFakeResponse' },
  )
  return seen
}

const stores: S3Storage[] = []
const store = (cfg: Partial<S3Config> = {}, allowPrivate = false) => {
  const s3 = new S3Storage({ ...CFG, ...cfg }, { ports: OUTBOUND_PORTS.s3, allowPrivate })
  stores.push(s3)
  return s3
}
afterAll(() => stores.forEach((s) => s.destroy()))

describe('requests', () => {
  it('put: path-style URL below private/, type and length sent, no checksum headers (WHEN_REQUIRED), signed', async () => {
    const s3 = store()
    const seen = fake(s3)
    await s3.put(KEY, Buffer.from('hello'), false, 'text/plain')
    const [req] = seen
    expect(req).toMatchObject({
      method: 'PUT',
      hostname: 's3.example.com',
      path: `/qw-files/private/${KEY}`,
    })
    expect(req!.headers).toMatchObject({ 'content-type': 'text/plain', 'content-length': '5' })
    expect(req!.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//)
    const names = Object.keys(req!.headers).map((h) => h.toLowerCase())
    expect(names.filter((h) => h.includes('checksum'))).toEqual([])
    expect(JSON.stringify(req)).not.toContain(CFG.secretKey)
  })

  it('virtual-hosted style without forcePathStyle; public objects below public/; delete', async () => {
    const s3 = store({ forcePathStyle: false })
    const seen = fake(s3, 204)
    await s3.put(KEY, Buffer.from('x'), true, 'image/png')
    await s3.remove(KEY, true)
    expect(seen.map((r) => [r.method, r.hostname, r.path])).toEqual([
      ['PUT', 'qw-files.s3.example.com', `/public/${KEY}`],
      ['DELETE', 'qw-files.s3.example.com', `/public/${KEY}`],
    ])
  })

  it('an S3 error surfaces as a rejection (and never as the remote text to callers of test())', async () => {
    const s3 = store()
    fake(s3, 403, '<Error><Code>AccessDenied</Code><Message>remote secret text</Message></Error>')
    await expect(s3.put(KEY, Buffer.from('x'), false, 'text/plain')).rejects.toMatchObject({
      name: 'AccessDenied',
    })
    expect(await s3.test()).toBe(false)
  })

  it('test(): HEAD bucket answered → true', async () => {
    const s3 = store()
    const seen = fake(s3, 200)
    expect(await s3.test()).toBe(true)
    expect(seen[0]).toMatchObject({ method: 'HEAD', path: '/qw-files/' })
  })
})

describe('urls', () => {
  it("publicUrl = publicDomain + /public/<key>; without one the bucket's own URL", () => {
    expect(store().publicUrl(KEY)).toBe(`https://cdn.example.com/public/${KEY}`)
    expect(store({ publicDomain: null }).publicUrl(KEY)).toBe(
      `https://s3.example.com/qw-files/public/${KEY}`,
    )
    expect(store({ publicDomain: null, forcePathStyle: false }).publicUrl(KEY)).toBe(
      `https://qw-files.s3.example.com/public/${KEY}`,
    )
  })

  it('presignGet: 60 s, the object in its area, response type and disposition signed; no secret in it', async () => {
    const url = new URL(
      await store().presignGet(KEY, false, 'application/pdf', 'attachment; filename="a.pdf"'),
    )
    expect(url.origin + url.pathname).toBe(`https://s3.example.com/qw-files/private/${KEY}`)
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      'X-Amz-Expires': String(S3_DOWNLOAD_TTL_SEC),
      'response-content-type': 'application/pdf',
      'response-content-disposition': 'attachment; filename="a.pdf"',
      'X-Amz-Credential': expect.stringMatching(/^AKIDEXAMPLE\//),
      'X-Amz-Signature': expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect(S3_DOWNLOAD_TTL_SEC).toBe(60)
    expect(url.href).not.toContain(encodeURIComponent(CFG.secretKey))
  })
})

/**
 * A small bucket behind the middleware: objects by path, each with an ETag (a new one per write);
 * GET honours If-Match and Range, the copy x-amz-copy-source-if-match (else 412), as S3 does.
 */
function bucket(s3: S3Storage) {
  const objects = new Map<string, { body: Buffer; etag: string }>()
  const seen: SeenRequest[] = []
  let version = 0
  const write = (path: string, body: Buffer) => objects.set(path, { body, etag: `"v${++version}"` })
  const answer = (
    statusCode: number,
    headers: Record<string, string> = {},
    body: Buffer = Buffer.alloc(0),
  ) =>
    ({ response: { statusCode, headers, body: Readable.from([body]) }, output: undefined }) as never
  const fail = (statusCode: number, code: string) =>
    answer(
      statusCode,
      { 'content-type': 'application/xml' },
      Buffer.from(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`),
    )
  s3.client.middlewareStack.add(
    () => async (args) => {
      const req = args.request as SeenRequest
      const h = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]),
      )
      seen.push({ ...req, headers: h })
      const copyOf = h['x-amz-copy-source']
      if (req.method === 'PUT' && copyOf) {
        const src = objects.get(`/${decodeURIComponent(copyOf)}`)
        if (!src) return fail(404, 'NoSuchKey')
        const ifMatch = h['x-amz-copy-source-if-match']
        if (ifMatch !== undefined && ifMatch !== src.etag) return fail(412, 'PreconditionFailed')
        objects.set(req.path, { ...src })
        return answer(
          200,
          { 'content-type': 'application/xml' },
          Buffer.from(`<CopyObjectResult><ETag>${src.etag}</ETag></CopyObjectResult>`),
        )
      }
      if (req.method === 'DELETE') {
        objects.delete(req.path)
        return answer(204)
      }
      const obj = objects.get(req.path)
      if (!obj) return fail(404, 'NotFound')
      if (req.method === 'HEAD')
        return answer(200, { etag: obj.etag, 'content-length': String(obj.body.length) })
      if (h['if-match'] !== undefined && h['if-match'] !== obj.etag)
        return fail(412, 'PreconditionFailed')
      const end = Number(/^bytes=0-(\d+)$/.exec(h.range ?? '')?.[1] ?? obj.body.length - 1)
      const part = obj.body.subarray(0, end + 1)
      return answer(
        206,
        {
          etag: obj.etag,
          'content-length': String(part.length),
          'content-range': `bytes 0-${part.length - 1}/${obj.body.length}`,
        },
        part,
      )
    },
    { step: 'deserialize', priority: 'low', name: 'qwFakeBucket' },
  )
  return { objects, seen, write }
}

describe('direct upload: check and publish one version (see docs/design-notes.md#storage)', () => {
  const staged = `/qw-files/staging/${KEY}`
  const published = `/qw-files/public/${KEY}`

  it('HEAD, the ranged GET and the copy are bound to one ETag; the checked version is published', async () => {
    const s3 = store()
    const b = bucket(s3)
    b.write(staged, Buffer.from('checked bytes'))
    const head = await s3.headStaged(KEY)
    expect(head).toEqual({ size: 13, etag: '"v1"', sha256: null })
    expect(await s3.readStaged(KEY, head!.etag!, 7)).toEqual(Buffer.from('checked'))
    expect(await s3.publish(KEY, head!.etag!, true, 'image/png')).toBe(true)
    expect(b.objects.get(published)?.body).toEqual(Buffer.from('checked bytes'))
    expect(b.objects.has(staged)).toBe(false)
    const [, get, copy] = b.seen
    expect(get!.headers).toMatchObject({ range: 'bytes=0-6', 'if-match': '"v1"' })
    expect(copy!.headers).toMatchObject({
      'x-amz-copy-source-if-match': '"v1"',
      'content-type': 'image/png',
    })
    expect(await s3.headStaged('2026/09/28/missing.png')).toBeNull()
  })

  it('unpublish (a deleted public object): copied to private/, the public one deleted; again → only the delete', async () => {
    const s3 = store()
    const b = bucket(s3)
    b.write(published, Buffer.from('public bytes'))
    await s3.unpublish(KEY)
    expect(b.objects.has(published)).toBe(false)
    expect(b.objects.get(`/qw-files/private/${KEY}`)?.body).toEqual(Buffer.from('public bytes'))
    await s3.unpublish(KEY)
    expect(b.seen.map((r) => r.method)).toEqual(['PUT', 'DELETE', 'PUT', 'DELETE'])
    expect(b.objects.get(`/qw-files/private/${KEY}`)?.body).toEqual(Buffer.from('public bytes'))
  })

  it('a PUT overwriting staging/ between the check and the copy: nothing is published', async () => {
    const s3 = store()
    const b = bucket(s3)
    b.write(staged, Buffer.from('checked bytes'))
    const { etag } = (await s3.headStaged(KEY))!
    expect(await s3.readStaged(KEY, etag!, 4100)).toEqual(Buffer.from('checked bytes'))
    // the still-valid presigned PUT lands now
    b.write(staged, Buffer.from('<html>other bytes</html>'))
    expect(await s3.publish(KEY, etag!, true, 'image/png')).toBe(false)
    expect(b.objects.has(published)).toBe(false)
    // a read after the overwrite is refused as well
    expect(await s3.readStaged(KEY, etag!, 4100)).toBeNull()
  })

  it('a service ignoring If-Match (another ETag in the answer) is refused too', async () => {
    const s3 = store()
    fakeGet(s3, { etag: '"v2"' }, [Buffer.from('other version')])
    expect(await s3.readStaged(KEY, '"v1"', 4100)).toBeNull()
  })

  it('a service ignoring Range (200 + the whole object): reads stop at the cap', async () => {
    const s3 = store()
    let pulled = 0
    const chunks = function* () {
      for (let i = 0; i < 1600; i++) {
        pulled++
        yield Buffer.alloc(64 * 1024, i)
      }
    }
    fakeGet(s3, { etag: '"v1"', 'content-length': String(1600 * 64 * 1024) }, chunks(), 200)
    const got = await s3.readStaged(KEY, '"v1"', 4100)
    expect(got).toEqual(Buffer.alloc(4100, 0))
    // 100 MB offered, a few chunks read (the stream's read-ahead), the rest never produced
    expect(pulled).toBeLessThan(40)
  })
})

/** Answers every request of `s3` with `status`, `headers` and a streamed `body`. */
function fakeGet(
  s3: S3Storage,
  headers: Record<string, string>,
  body: Iterable<Buffer>,
  status = 206,
) {
  s3.client.middlewareStack.add(
    () => async () =>
      ({
        response: { statusCode: status, headers, body: Readable.from(body) },
        output: undefined,
      }) as never,
    { step: 'deserialize', priority: 'low', name: 'qwFakeGet' },
  )
}

describe('SSRF guard (core/net agents; real sockets, nothing leaves the machine)', () => {
  let hits: string[]
  let target: http.Server
  let port: number
  beforeAll(async () => {
    hits = []
    target = http.createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`)
      if (req.url?.startsWith('/moved/')) {
        // an endpoint redirecting elsewhere: the SDK never follows it
        res.writeHead(307, { location: `http://127.0.0.1:${port}/elsewhere/` }).end()
        return
      }
      res.writeHead(200).end()
    })
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))
    port = (target.address() as AddressInfo).port
  })
  afterAll(() => new Promise((resolve) => target.close(resolve)))

  it('inner endpoints are refused before any connection (loopback, metadata, localhost)', async () => {
    for (const endpoint of [
      `http://127.0.0.1:${port}`,
      'http://169.254.169.254',
      `http://localhost:${port}`,
    ]) {
      const s3 = store({ endpoint })
      await expect(s3.put(KEY, Buffer.from('x'), false, 'text/plain')).rejects.toBeInstanceOf(
        OutboundRefused,
      )
      expect(await s3.test()).toBe(false)
    }
    expect(hits).toEqual([])
  })

  it('ALLOW_PRIVATE_ENDPOINTS reaches a local service; a redirect answer is not followed', async () => {
    const s3 = store({ endpoint: `http://127.0.0.1:${port}` }, true)
    expect(await s3.test()).toBe(true)
    const moved = store({ endpoint: `http://127.0.0.1:${port}/moved` }, true)
    await expect(moved.put(KEY, Buffer.from('x'), false, 'text/plain')).rejects.toBeTruthy()
    expect(hits.some((h) => h.includes('/elsewhere/'))).toBe(false)
  })
})
