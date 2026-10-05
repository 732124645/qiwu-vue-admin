import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { guardedAgents, NET_TIMEOUT_MS, type OutboundRule } from '../../../core/net/net-guard.js'

/** `fs_storage.config` of an s3 storage, `secretKey` already opened (SecretBox). */
export interface S3Config {
  endpoint: string
  region: string
  bucket: string
  accessKey: string
  secretKey: string
  forcePathStyle: boolean
  publicDomain: string | null
}

/** The HTTP status of an S3 error (the SDK's `$metadata`). */
const status = (e: unknown) =>
  (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode

/**
 * The first `max` bytes of a response body, reading no further: leaving the loop destroys the stream
 * (and its socket), so a body longer than asked for is never read to its end.
 */
async function readCapped(body: unknown, max: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of (body ?? []) as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk))
    size += chunk.length
    if (size >= max) break
  }
  return Buffer.concat(chunks).subarray(0, max)
}

/** Lifetime of a private download's presigned GET (see docs/design-notes.md#storage). */
export const S3_DOWNLOAD_TTL_SEC = 60

/**
 * The S3-compatible driver (AWS, OSS, COS, R2, SeaweedFS…; see docs/design-notes.md#storage). Objects sit at
 * `public/<key>` / `private/<key>` in the bucket like the local areas, direct uploads land in
 * `staging/<key>` until confirmed; the bucket policy (or the CDN in front) exposes `public/` only. Every request goes through the core/net guarded agents (the endpoint is
 * admin input; see docs/design-notes.md#security), checksums only when an operation requires one (`WHEN_REQUIRED`: many
 * S3-compatible services reject the SDK's default CRC headers), path-style URLs when configured.
 */
export class S3Storage {
  readonly client: S3Client
  private readonly agents: ReturnType<typeof guardedAgents>

  /** `net` = `outboundRule(config, 's3')`: the registered ports, ALLOW_PRIVATE_ENDPOINTS */
  constructor(
    private readonly cfg: S3Config,
    net: OutboundRule,
  ) {
    this.agents = guardedAgents(net)
    const { httpAgent, httpsAgent } = this.agents
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      requestHandler: { httpAgent, httpsAgent, connectionTimeout: NET_TIMEOUT_MS },
    })
  }

  private key(key: string, isPublic: boolean): string {
    return `${isPublic ? 'public' : 'private'}/${key}`
  }

  /**
   * `<publicDomain>/public/<key>`; without a public domain the bucket's own URL (path-style
   * `<endpoint>/<bucket>/public/<key>`, else `<bucket>.<endpoint host>`): public objects always link.
   */
  publicUrl(key: string): string {
    const endpoint = new URL(this.cfg.endpoint)
    const bucketUrl = this.cfg.forcePathStyle
      ? `${endpoint.origin}${endpoint.pathname.replace(/\/+$/, '')}/${this.cfg.bucket}`
      : `${endpoint.protocol}//${this.cfg.bucket}.${endpoint.host}${endpoint.pathname.replace(/\/+$/, '')}`
    const base = this.cfg.publicDomain?.replace(/\/+$/, '') || bucketUrl
    return `${base}/${this.key(key, true)}`
  }

  async put(key: string, data: Buffer, isPublic: boolean, mime: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: this.key(key, isPublic),
        Body: data,
        ContentType: mime,
        ContentLength: data.length,
      }),
    )
  }

  async remove(key: string, isPublic: boolean): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: this.key(key, isPublic) }),
    )
  }

  /**
   * A GET URL valid for {@link S3_DOWNLOAD_TTL_SEC} that makes S3 answer with this type and
   * disposition (signed offline: no request to the endpoint). The caller authorizes first.
   */
  presignGet(key: string, isPublic: boolean, type: string, disposition: string): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.cfg.bucket,
        Key: this.key(key, isPublic),
        ResponseContentType: type,
        ResponseContentDisposition: disposition,
      }),
      { expiresIn: S3_DOWNLOAD_TTL_SEC },
    )
  }

  /**
   * Direct upload (see docs/design-notes.md#storage): a PUT URL for the browser to `staging/<key>` (never public, never the
   * final object: confirm checks the bytes there, then {@link publish}es them), signed with the
   * Content-Type and Content-Length it must send, and `x-amz-checksum-sha256` when the hash is given
   * (S3 then refuses other bytes). `headers` = what the PUT must send besides the length.
   * The URL stays valid after confirm, so a repeated PUT leaves a stray `staging/` object;
   * a bucket lifecycle rule expiring `staging/` after a day cleans those up.
   */
  async presignPut(
    key: string,
    put: { mime: string; size: number; sha256?: string },
    expiresIn: number,
  ): Promise<{ url: string; headers: Record<string, string> }> {
    const checksum = put.sha256 && Buffer.from(put.sha256, 'hex').toString('base64')
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: `staging/${key}`,
        ContentType: put.mime,
        ContentLength: put.size,
        ChecksumSHA256: checksum || undefined,
      }),
      {
        expiresIn,
        // content-type is not signed by default; x-amz-* headers would move into the query
        signableHeaders: new Set(['content-type', 'content-length']),
        unhoistableHeaders: new Set(checksum ? ['x-amz-checksum-sha256'] : []),
      },
    )
    return {
      url,
      headers: {
        'Content-Type': put.mime,
        ...(checksum ? { 'x-amz-checksum-sha256': checksum } : {}),
      },
    }
  }

  /**
   * A staged upload's size, ETag (the version confirm checks and then publishes: a later PUT to the
   * still-valid URL is another version) and full-object SHA-256 (base64, when the service kept one);
   * null = no such object.
   */
  async headStaged(
    key: string,
  ): Promise<{ size: number; etag: string | null; sha256: string | null } | null> {
    try {
      const h = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.cfg.bucket,
          Key: `staging/${key}`,
          ChecksumMode: 'ENABLED',
        }),
      )
      return { size: h.ContentLength ?? 0, etag: h.ETag ?? null, sha256: h.ChecksumSHA256 ?? null }
    } catch (e) {
      if (status(e) === 404) return null
      throw e
    }
  }

  /**
   * The staged version `etag` as a stream (`first`: only its first bytes, a Range GET), always with
   * If-Match; null when the staged object is no longer that version (412, or the answer names another
   * ETag: a service ignoring If-Match). The caller reads what it needs and stops (see `readStaged`).
   */
  async openStaged(
    key: string,
    etag: string,
    first?: number,
  ): Promise<AsyncIterable<Uint8Array> | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({
          Bucket: this.cfg.bucket,
          Key: `staging/${key}`,
          Range: first ? `bytes=0-${first - 1}` : undefined,
          IfMatch: etag,
        }),
      )
      if (res.ETag === etag) return (res.Body ?? []) as AsyncIterable<Uint8Array>
      await readCapped(res.Body, 0)
      return null
    } catch (e) {
      if (status(e) === 412) return null
      throw e
    }
  }

  /**
   * At most `max` bytes from the start of the staged version `etag` (a Range GET), null when it changed.
   * Read with a hard cap: a service ignoring Range (200 + the whole object) is cut off after `max` bytes.
   */
  async readStaged(key: string, etag: string, max: number): Promise<Buffer | null> {
    const body = await this.openStaged(key, etag, max)
    return body && readCapped(body, max)
  }

  /**
   * Moves the checked version `etag` of a staged upload to its area, served with `mime` (not the
   * browser's type): the copy is conditional on that ETag, so bytes PUT after the check are never
   * published. false (and nothing copied) when the staged object is no longer that version.
   */
  async publish(key: string, etag: string, isPublic: boolean, mime: string): Promise<boolean> {
    try {
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.cfg.bucket,
          Key: this.key(key, isPublic),
          CopySource: `${this.cfg.bucket}/staging/${key}`,
          CopySourceIfMatch: etag,
          MetadataDirective: 'REPLACE',
          ContentType: mime,
        }),
      )
    } catch (e) {
      if (status(e) === 412) return false
      throw e
    }
    await this.dropStaged(key)
    return true
  }

  /**
   * Moves a public object to `private/` (a deleted object: its public URL stops answering; the retention
   * purge removes it there): copy, then delete the public one. Already moved (no public object) → only
   * the delete, which S3 answers 204 for a missing key. A CDN in front of `publicDomain` may still serve
   * its cached copy until that expires (the provider's cache, not ours to purge).
   */
  async unpublish(key: string): Promise<void> {
    try {
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.cfg.bucket,
          Key: this.key(key, false),
          CopySource: `${this.cfg.bucket}/${this.key(key, true)}`,
        }),
      )
    } catch (e) {
      if (status(e) !== 404) throw e
    }
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: this.key(key, true) }),
    )
  }

  async dropStaged(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: `staging/${key}` }),
    )
  }

  /** Test connection: the bucket answers to these credentials within 5 s (retries included). */
  async test(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.cfg.bucket }), {
        abortSignal: AbortSignal.timeout(NET_TIMEOUT_MS),
      })
      return true
    } catch {
      return false
    }
  }

  /** Closes the agents' sockets (tests; a replaced client is left to finish its requests). */
  destroy(): void {
    this.client.destroy()
    this.agents.httpAgent.destroy()
    this.agents.httpsAgent.destroy()
  }
}
