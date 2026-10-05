import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { Global, Injectable, Module } from '@nestjs/common'
import { AppConfigService } from '../config/config.module.js'

/** AES-256-GCM output, each part base64url. */
export interface Sealed {
  /** 12 random bytes */
  iv: string
  /** 16-byte authentication tag */
  tag: string
  ct: string
}

/** HKDF-SHA256 → a 32-byte AES-256 key: the same inputs always give the same key. */
export const deriveKey = (ikm: string | Buffer, salt: string, info: string): Buffer =>
  Buffer.from(hkdfSync('sha256', ikm, salt, info, 32))

/** AES-256-GCM with a fresh random IV; `aad` is authenticated, not encrypted (open needs the same). */
export function seal(key: Buffer, plaintext: string, aad = ''): Sealed {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad))
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ct: ct.toString('base64url'),
  }
}

/** The plaintext, or null when the key, the AAD or any part does not match (tampered, foreign). */
export function open(key: Buffer, s: Sealed, aad = ''): string | null {
  try {
    const iv = Buffer.from(s.iv, 'base64url')
    const tag = Buffer.from(s.tag, 'base64url')
    if (iv.length !== 12 || tag.length !== 16) return null
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
    decipher.setAAD(Buffer.from(aad))
    decipher.setAuthTag(tag)
    const pt = Buffer.concat([decipher.update(Buffer.from(s.ct, 'base64url')), decipher.final()])
    return pt.toString('utf8')
  } catch {
    return null
  }
}

/** The only key version so far; the prefix lets a later one (rotation ⏸) tell old boxes apart. */
const VERSION = 'v1'
const BOX = /^v1:([\w-]{16}):([\w-]{22}):([\w-]*)$/

/**
 * Third-party secrets at rest (S3 secret keys, SMTP passwords, SMS keys; see docs/design-notes.md#security): AES-256-GCM under
 * HKDF(`APP_SECRET`, key version), stored as `v1:<iv>:<tag>:<ct>` (base64url). The version is also the
 * AAD, so a box never opens under another version's rules. A changed `APP_SECRET` makes every box
 * unreadable: re-enter the secrets. Rotation ⏸ (a `v2` key would be added beside this one).
 */
@Injectable()
export class SecretBox {
  private readonly key: Buffer

  constructor(cfg: AppConfigService) {
    // frozen HKDF label (kept through the project rename): another label makes every stored v1 box unreadable
    this.key = deriveKey(cfg.get('APP_SECRET'), '', `nv-secret-box:${VERSION}`)
  }

  /** A string that looks like a box (it may still fail to open). */
  static isBox(value: unknown): value is string {
    return typeof value === 'string' && BOX.test(value)
  }

  encrypt(plaintext: string): string {
    const s = seal(this.key, plaintext, VERSION)
    return `${VERSION}:${s.iv}:${s.tag}:${s.ct}`
  }

  /** Throws when the value is no box or does not open (tampered, other `APP_SECRET`). */
  decrypt(box: string): string {
    const m = BOX.exec(box)
    const pt = m && open(this.key, { iv: m[1]!, tag: m[2]!, ct: m[3]! }, VERSION)
    if (pt == null)
      throw new Error('SecretBox: the value does not open (tampered or another APP_SECRET)')
    return pt
  }
}

/** SecretBox for every module (needs only the global config). */
@Global()
@Module({ providers: [SecretBox], exports: [SecretBox] })
export class CoreCryptoModule {}
