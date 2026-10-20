import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import { WXOA_AES_KEY } from '@qiwu/shared'
import { wxoaCdata } from './wxoa-xml.js'

// Push signatures and the message encryption of compat and secure mode (see
// docs/design-notes.md#wxoa): AES-256-CBC, the IV the key's first 16 bytes, PKCS#7 over 32-byte blocks
// done by hand; the plaintext is 16 random bytes, the message length (4 bytes, big-endian), the
// message and the account's AppID.

/** How far a push's `timestamp` may be from this machine's clock, in seconds. */
export const WXOA_TIME_WINDOW_S = 300

/** The padding block (PKCS#7 with K = 32, not the cipher's 16). */
const BLOCK = 32
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * sha1 hex of `parts` sorted and joined: a push's `signature` (token, timestamp, nonce), its
 * `msg_signature` (the same and `Encrypt`), a reply's `MsgSignature`.
 */
export function wxoaSign(...parts: string[]): string {
  return createHash('sha1').update(parts.toSorted().join('')).digest('hex')
}

/** Whether `given` (a query value: any type) is the signature of `parts`, compared in constant time. */
export function wxoaSignOk(given: unknown, ...parts: string[]): boolean {
  if (typeof given !== 'string') return false
  const want = Buffer.from(wxoaSign(...parts))
  const got = Buffer.from(given)
  return want.length === got.length && timingSafeEqual(want, got)
}

/** Whether a push's `timestamp` (seconds) is within {@link WXOA_TIME_WINDOW_S} of `now`. */
export function wxoaTimeOk(timestamp: unknown, now = Date.now()): boolean {
  return (
    typeof timestamp === 'string' &&
    /^[1-9]\d{0,11}$/.test(timestamp) &&
    Math.abs(now / 1000 - Number(timestamp)) <= WXOA_TIME_WINDOW_S
  )
}

/** The 32-byte AES key of an EncodingAESKey (its 43 characters and a `=`, base64). */
export function wxoaAesKey(encodingAesKey: string): Buffer {
  if (!WXOA_AES_KEY.test(encodingAesKey)) throw new Error('not an EncodingAESKey')
  return Buffer.from(`${encodingAesKey}=`, 'base64')
}

/** Why a ciphertext was refused (the callback answers 404 whatever the reason). */
export type WxoaCryptoFault = 'format' | 'padding' | 'length' | 'appid'

export class WxoaCryptoError extends Error {
  constructor(readonly fault: WxoaCryptoFault) {
    super(`wxoa ciphertext refused: ${fault}`)
  }
}

/**
 * The message in an `Encrypt` for `appId`. Refused: not base64 of whole 32-byte blocks (`format`), a
 * padding value outside 1–32 or bytes not all equal to it (`padding`), a length running past the end
 * (`length`), any other AppID after the message (`appid`). The cipher has no integrity of its own:
 * `msg_signature` must be checked first.
 */
export function wxoaDecrypt(key: Buffer, encrypt: string, appId: string): string {
  const data = BASE64.test(encrypt) ? Buffer.from(encrypt, 'base64') : Buffer.alloc(0)
  if (!data.length || data.length % BLOCK) throw new WxoaCryptoError('format')
  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16)).setAutoPadding(false)
  const full = Buffer.concat([decipher.update(data), decipher.final()])
  const pad = full.at(-1)!
  if (pad < 1 || pad > BLOCK || full.subarray(-pad).some((b) => b !== pad))
    throw new WxoaCryptoError('padding')
  const plain = full.subarray(0, -pad)
  const size = plain.length >= 20 ? plain.readUInt32BE(16) : -1
  if (size < 0 || 20 + size > plain.length) throw new WxoaCryptoError('length')
  if (!plain.subarray(20 + size).equals(Buffer.from(appId))) throw new WxoaCryptoError('appid')
  return plain.subarray(20, 20 + size).toString('utf8')
}

/** `message` encrypted for `appId` (base64), `random` its 16 leading bytes. */
export function wxoaEncrypt(
  key: Buffer,
  message: string,
  appId: string,
  random: Buffer = randomBytes(16),
): string {
  const msg = Buffer.from(message)
  const size = Buffer.alloc(4)
  size.writeUInt32BE(msg.length)
  const plain = Buffer.concat([random, size, msg, Buffer.from(appId)])
  const pad = BLOCK - (plain.length % BLOCK)
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16)).setAutoPadding(false)
  return Buffer.concat([
    cipher.update(Buffer.concat([plain, Buffer.alloc(pad, pad)])),
    cipher.final(),
  ]).toString('base64')
}

/** What encrypting for an account takes: its push Token, AES key and AppID. */
export interface WxoaCipher {
  token: string
  key: Buffer
  appId: string
}

/**
 * The encrypted form of a passive reply `xml`: `Encrypt`, `MsgSignature`, `TimeStamp` (now, unless
 * given) and `Nonce`, which must be the push's own nonce.
 */
export function wxoaSealReply(
  cipher: WxoaCipher,
  xml: string,
  opts: { nonce: string; timestamp?: string; random?: Buffer },
): string {
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000))
  const encrypt = wxoaEncrypt(cipher.key, xml, cipher.appId, opts.random)
  const signature = wxoaSign(cipher.token, timestamp, opts.nonce, encrypt)
  return `<xml><Encrypt>${wxoaCdata(encrypt)}</Encrypt><MsgSignature>${wxoaCdata(signature)}</MsgSignature><TimeStamp>${timestamp}</TimeStamp><Nonce>${wxoaCdata(opts.nonce)}</Nonce></xml>`
}
