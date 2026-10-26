import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { guardedFetch, McpNetFailure } from '../../src/core/agent/mcp-client/guarded-fetch.js'

let server: http.Server
let base: string
let active = 0

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = req.url!
    if (path === '/headers') return
    if (path.startsWith('/empty/')) {
      res.writeHead(Number(path.split('/').pop()))
      res.end()
      return
    }
    if (path === '/head' || path === '/buffered') {
      res.end(Buffer.alloc(32_768, 97))
      return
    }
    if (path === '/redirect') {
      res.writeHead(302, { location: '/buffered' })
      res.end()
      return
    }
    if (path === '/truncated') {
      res.writeHead(200, { 'content-length': 1000 })
      res.write('first')
      setTimeout(() => res.destroy(), 10)
      return
    }
    if (path === '/finite') {
      res.write('a')
      setTimeout(() => res.end('b'), 5)
      return
    }
    if (path === '/idle') {
      res.writeHead(200)
      res.flushHeaders()
      return
    }
    if (path === '/huge') {
      res.end(Buffer.alloc(256))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('first\n')
    active++
    const timer = setInterval(() => res.write('next\n'), 1)
    res.once('close', () => {
      clearInterval(timer)
      active--
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

it('repeated buffered and streaming cancellations never enqueue after the reader is closed', async () => {
  const reasons: string[] = []
  const fetch = guardedFetch({ allowPrivate: true, onFailure: (reason) => reasons.push(reason) })
  const reads: (boolean | undefined)[] = []
  for (let n = 0; n < 100; n++) {
    const response = await fetch(`${base}/${n % 2 ? 'buffered' : 'stream'}`)
    const reader = response.body!.getReader()
    if (n % 3) reads.push((await reader.read()).done)
    await reader.cancel()
    await reader.cancel()
    expect((await reader.read()).done).toBe(true)
  }
  await delay(30)
  expect(active).toBe(0)
  expect(new Set(reads)).toEqual(new Set([false]))
  expect(reasons).toEqual([])
})

it('complete buffered and streamed bodies retain every byte and terminate normally', async () => {
  const fetch = guardedFetch({ allowPrivate: true })
  expect(await (await fetch(`${base}/buffered`)).text()).toBe('a'.repeat(32_768))
  expect(await (await fetch(`${base}/finite`)).text()).toBe('ab')
})

it('consumer demand applies backpressure, and cancel releases a stream with queued data', async () => {
  const response = await guardedFetch({ allowPrivate: true })(`${base}/stream`)
  const reader = response.body!.getReader()
  await delay(40)
  expect((await reader.read()).value!.length).toBeGreaterThan(0)
  await reader.cancel()
  await delay(20)
  expect(active).toBe(0)
})

it.each([204, 205, 304])('response %i has no body and can be released', async (status) => {
  const response = await guardedFetch({ allowPrivate: true })(`${base}/empty/${status}`)
  expect(response.status).toBe(status)
  expect(response.body).toBeNull()
})
it('HEAD has no body; redirects are returned to the SDK without a second outbound request', async () => {
  const fetch = guardedFetch({ allowPrivate: true })
  for (const method of ['HEAD', 'head']) {
    const head = await fetch(`${base}/head`, { method })
    expect(head.body).toBeNull()
  }
  const redirected = await fetch(`${base}/redirect`)
  expect(redirected.status).toBe(302)
  expect(redirected.headers.get('location')).toBe('/buffered')
  await redirected.body!.cancel()
})

it('header and body silence timeouts retain their safe reason code', async () => {
  const reasons: string[] = []
  const fetch = guardedFetch({
    allowPrivate: true,
    headersTimeoutMs: 20,
    idleTimeoutMs: 20,
    onFailure: (reason) => reasons.push(reason),
  })
  await expect(fetch(`${base}/headers`)).rejects.toMatchObject({ reason: 'timeout' })
  const idle = await fetch(`${base}/idle`)
  await expect(idle.text()).rejects.toMatchObject({ reason: 'timeout' })
  expect(reasons).toEqual(['timeout', 'timeout'])
})

it('idle timeout remains paused during elicitation, then resumes', async () => {
  let paused = true
  const response = await guardedFetch({
    allowPrivate: true,
    idleTimeoutMs: 15,
    paused: () => paused,
  })(`${base}/idle`)
  const result = response.text().catch((error) => error)
  await delay(55)
  paused = false
  expect(await result).toMatchObject({ reason: 'timeout' })
})

it('caller abort remains an abort, and size/truncation errors cannot leak remote values', async () => {
  const reasons: string[] = []
  const controller = new AbortController()
  const fetch = guardedFetch({
    allowPrivate: true,
    maxBytes: 20,
    onFailure: (reason) => reasons.push(reason),
  })
  const response = await fetch(`${base}/stream`, { signal: controller.signal })
  const reader = response.body!.getReader()
  await reader.read()
  controller.abort()
  await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' })
  const huge = await fetch(`${base}/huge`)
  await expect(huge.text()).rejects.toMatchObject({ reason: 'too_large' })
  const truncated = await fetch(`${base}/truncated`)
  await expect(truncated.text()).rejects.toBeInstanceOf(McpNetFailure)
  expect(reasons).toEqual(['too_large', 'network'])
})

it('aborted requests before headers and refused hosts preserve the outbound trust boundary', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(
    guardedFetch({ allowPrivate: true })(`${base}/headers`, { signal: controller.signal }),
  ).rejects.toMatchObject({ name: 'AbortError' })
  const reasons: string[] = []
  const strict = guardedFetch({ allowPrivate: false, onFailure: (reason) => reasons.push(reason) })
  await expect(strict(`${base}/buffered`)).rejects.toMatchObject({ reason: 'address' })
  await expect(strict('http://user:secret@example.com')).rejects.toMatchObject({ reason: 'url' })
  expect(reasons).toEqual(['address', 'url'])
})
