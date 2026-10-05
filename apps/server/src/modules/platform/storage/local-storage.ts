import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import type { Readable } from 'node:stream'
import { NotFoundException } from '@nestjs/common'
import { uploadRoot } from '../../../core/paths.js'

/**
 * The local driver (see docs/design-notes.md#storage): `<STORAGE_LOCAL_ROOT>/public/<key>` (also served without a token at
 * `/files/<key>`, app.setup.ts) and `<root>/private/<key>` (never served statically). Paths come from
 * DB keys only and must stay inside their area (no traversal). S3Storage offers the same `put` /
 * `remove` / `publicUrl`; StorageService picks the driver by the object's storage.
 */
export class LocalStorage {
  /** `publicPrefix` of the storage config: a site path or CDN URL in front of `public/` (none = `/files`) */
  constructor(private readonly publicPrefix?: string | null) {}

  publicUrl(key: string): string {
    return `${(this.publicPrefix || '/files').replace(/\/+$/, '')}/${key}`
  }

  private path(key: string, isPublic: boolean): string {
    const area = resolve(uploadRoot(), isPublic ? 'public' : 'private')
    const file = resolve(area, key)
    if (!file.startsWith(area + sep)) throw new NotFoundException()
    return file
  }

  /** Writes a new file; an existing one is never overwritten. */
  async put(key: string, data: Buffer, isPublic: boolean, _mime?: string): Promise<void> {
    const file = this.path(key, isPublic)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, data, { flag: 'wx' })
  }

  /** The file as a stream; a missing file → 404. */
  async read(key: string, isPublic: boolean): Promise<Readable> {
    const handle = await open(this.path(key, isPublic), 'r').catch(() => {
      throw new NotFoundException()
    })
    return handle.createReadStream()
  }

  async remove(key: string, isPublic: boolean): Promise<void> {
    await rm(this.path(key, isPublic), { force: true })
  }

  /**
   * Moves a public file to the private area (a deleted object: `/files/<key>` answers 404 at once, the
   * retention purge removes it there). A file already moved (or gone) is no error.
   */
  async unpublish(key: string): Promise<void> {
    const to = this.path(key, false)
    await mkdir(dirname(to), { recursive: true })
    await rename(this.path(key, true), to).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e
    })
  }
}
