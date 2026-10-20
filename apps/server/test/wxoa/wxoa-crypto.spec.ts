// Push signatures and the message encryption of compat and secure mode. The official example of
// https://developers.weixin.qq.com/doc/service/guide/dev/push/encryption.html is taken as published (its
// messages are JSON: they test the signature and the cipher only); own vectors are assembled byte by
// byte below, apart from the code under test, and the refusals built the same way.
import { createCipheriv } from 'node:crypto'
import {
  wxoaAesKey,
  WxoaCryptoError,
  type WxoaCryptoFault,
  wxoaDecrypt,
  wxoaEncrypt,
  wxoaSealReply,
  wxoaSign,
  wxoaSignOk,
  wxoaTimeOk,
} from '../../src/modules/platform/wxoa/core/wxoa-crypto.js'
import { wxoaParseXml, wxoaReplyXml } from '../../src/modules/platform/wxoa/core/wxoa-xml.js'

/** The fault `run` was refused with, null when it went through. */
function faultOf(run: () => unknown): WxoaCryptoFault | null {
  try {
    run()
  } catch (err) {
    if (err instanceof WxoaCryptoError) return err.fault
    throw err
  }
  return null
}

describe('official example', () => {
  const token = 'AAAAA'
  const key = wxoaAesKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
  const appId = 'wxba5fad812f8e6fb9'
  const encrypt =
    '+qdx1OKCy+5JPCBFWw70tm0fJGb2Jmeia4FCB7kao+/Q5c/ohsOzQHi8khUOb05JCpj0JB4RvQMkUyus8TPxLKJGQqcvZqzDpVzazhZv6JsXUnnR8XGT740XgXZUXQ7vJVnAG+tE8NUd4yFyjPy7GgiaviNrlCTj+l5kdfMuFUPpRSrfMZuMcp3Fn2Pede2IuQrKEYwKSqFIZoNqJ4M8EajAsjLY2km32IIjdf8YL/P50F7mStwntrA2cPDrM1kb6mOcfBgRtWygb3VIYnSeOBrebufAlr7F9mFUPAJGj04='

  it('plain mode: the signature over token, timestamp and nonce', () => {
    expect(wxoaSign(token, '1714037059', '486452656')).toBe(
      '899cf89e464efb63f54ddac96b0a0a235f53aa78',
    )
    expect(
      wxoaSignOk('899cf89e464efb63f54ddac96b0a0a235f53aa78', token, '1714037059', '486452656'),
    ).toBe(true)
  })

  it('secure mode: the push signature and msg_signature', () => {
    expect(
      wxoaSignOk('6c5c811b55cc85e0e1b54100749188c20beb3f5d', token, '1714112445', '415670741'),
    ).toBe(true)
    expect(
      wxoaSignOk(
        '046e02f8204d34f8ba5fa3b1db94908f3df2e9b3',
        token,
        '1714112445',
        '415670741',
        encrypt,
      ),
    ).toBe(true)
  })

  it('secure mode: Encrypt opens to the example message', () => {
    expect(key).toEqual(Buffer.alloc(32))
    const message = wxoaDecrypt(key, encrypt, appId)
    expect(message).toBe(
      '{"ToUserName":"gh_97417a04a28d","FromUserName":"o9AgO5Kd5ggOC-bXrbNODIiE3bGY","CreateTime":1714112445,"MsgType":"event","Event":"debug_demo","debug_str":"hello world"}',
    )
    expect(Buffer.byteLength(message)).toBe(167)
  })

  it('secure mode: the reply encrypts and signs as the example', () => {
    const random = Buffer.from('707722b803182950')
    const reply = '{"demo_resp":"good luck"}'
    const sealed =
      'ELGduP2YcVatjqIS+eZbp80MNLoAUWvzzyJxgGzxZO/5sAvd070Bs6qrLARC9nVHm48Y4hyRbtzve1L32tmxSQ=='
    expect(wxoaEncrypt(key, reply, appId, random)).toBe(sealed)
    expect(wxoaDecrypt(key, sealed, appId)).toBe(reply)
    const xml = wxoaSealReply({ token, key, appId }, reply, {
      nonce: '415670741',
      timestamp: '1713424427',
      random,
    })
    expect(wxoaParseXml(xml)).toEqual({
      Encrypt: sealed,
      MsgSignature: '1b9339964ed2e271e7c7b6ff2b0ef902fc94dea1',
      TimeStamp: '1713424427',
      Nonce: '415670741',
    })
  })
})

// Own vectors: a key, 16 random bytes and an AppID fixed here.
const AES = 'qiwuTestKey0123456789abcdefghijklmnopqrstuv'
const KEY = Buffer.from(`${AES}=`, 'base64')
const RANDOM = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex')
const APPID = 'wx0123456789abcdef'

/** random, the length (4 bytes, big-endian) of `message`, the message and the AppID */
function body(message: string, opts: { size?: number; appId?: string } = {}): Buffer {
  const msg = Buffer.from(message, 'utf8')
  const size = Buffer.alloc(4)
  size.writeUInt32BE(opts.size ?? msg.length)
  return Buffer.concat([RANDOM, size, msg, Buffer.from(opts.appId ?? APPID, 'utf8')])
}
/** PKCS#7 over 32-byte blocks */
const pkcs7 = (b: Buffer) => {
  const pad = 32 - (b.length % 32)
  return Buffer.concat([b, Buffer.alloc(pad, pad)])
}
/** AES-256-CBC of `plain` exactly as given (IV: the key's first 16 bytes), base64 */
function seal(plain: Buffer): string {
  const cipher = createCipheriv('aes-256-cbc', KEY, KEY.subarray(0, 16)).setAutoPadding(false)
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64')
}
/** `message` whose plaintext needs exactly `pad` bytes of padding */
const sized = (pad: number) => 'm'.repeat((((32 - pad - body('').length) % 32) + 32) % 32)

describe('own vectors', () => {
  it('the AES key is the EncodingAESKey and a = decoded, 32 bytes', () => {
    expect(wxoaAesKey(AES)).toEqual(KEY)
    expect(KEY).toHaveLength(32)
    expect(() => wxoaAesKey(AES.slice(1))).toThrow('not an EncodingAESKey')
  })

  it('encrypts as the assembly by hand and opens again, multibyte text included', () => {
    for (const message of ['', 'hello', '你好 \u{1f600}', '<xml>x</xml>'.repeat(40)]) {
      const sealed = wxoaEncrypt(KEY, message, APPID, RANDOM)
      expect(sealed).toBe(seal(pkcs7(body(message))))
      expect(wxoaDecrypt(KEY, sealed, APPID)).toBe(message)
    }
  })

  it('pads with every value from 1 to 32', () => {
    for (let pad = 1; pad <= 32; pad++) {
      const message = sized(pad)
      expect(pkcs7(body(message)).at(-1)).toBe(pad)
      expect(wxoaDecrypt(KEY, wxoaEncrypt(KEY, message, APPID), APPID)).toBe(message)
    }
  })

  it('a fresh random prefix each time unless given', () => {
    expect(wxoaEncrypt(KEY, 'x', APPID)).not.toBe(wxoaEncrypt(KEY, 'x', APPID))
  })
})

describe('refused ciphertexts', () => {
  it('padding value 0', () => {
    const plain = body(sized(7))
    const encrypt = seal(Buffer.concat([plain, Buffer.alloc(7, 0)]))
    expect(faultOf(() => wxoaDecrypt(KEY, encrypt, APPID))).toBe('padding')
    // all zero: the last byte's zero bytes are the whole plaintext
    expect(faultOf(() => wxoaDecrypt(KEY, seal(Buffer.alloc(64)), APPID))).toBe('padding')
  })

  it('padding value 33', () => {
    // 63 bytes and 33 bytes of 33: three whole blocks, the message exact once 33 bytes are dropped
    const encrypt = seal(Buffer.concat([body(sized(1)), Buffer.alloc(33, 33)]))
    expect(Buffer.from(encrypt, 'base64')).toHaveLength(96)
    expect(faultOf(() => wxoaDecrypt(KEY, encrypt, APPID))).toBe('padding')
  })

  it('padding bytes not all equal to its value, though the value itself fits', () => {
    const message = sized(5)
    const plain = Buffer.concat([body(message), Buffer.from([9, 9, 9, 9, 5])])
    const encrypt = seal(plain)
    expect(faultOf(() => wxoaDecrypt(KEY, encrypt, APPID))).toBe('padding')
    // the same plaintext correctly padded opens
    expect(wxoaDecrypt(KEY, seal(pkcs7(body(message))), APPID)).toBe(message)
  })

  it('a length running past the end', () => {
    const message = 'hello'
    const past = Buffer.byteLength(message) + APPID.length + 1
    for (const size of [past, 0xffffffff])
      expect(faultOf(() => wxoaDecrypt(KEY, seal(pkcs7(body(message, { size }))), APPID))).toBe(
        'length',
      )
    // shorter than 20 bytes once unpadded: no room for the length
    expect(faultOf(() => wxoaDecrypt(KEY, seal(pkcs7(Buffer.alloc(10, 1))), APPID))).toBe('length')
  })

  it('an AppID other than the account’s', () => {
    for (const appId of ['wxfedcba9876543210', `${APPID}0`, APPID.slice(0, -1), ''])
      expect(faultOf(() => wxoaDecrypt(KEY, seal(pkcs7(body('hello', { appId }))), APPID))).toBe(
        'appid',
      )
    // a shorter length makes the message's tail look like part of the AppID
    expect(faultOf(() => wxoaDecrypt(KEY, seal(pkcs7(body('hello', { size: 4 }))), APPID))).toBe(
      'appid',
    )
  })

  it('not base64 of whole 32-byte blocks', () => {
    const good = wxoaEncrypt(KEY, 'hello', APPID)
    for (const encrypt of ['', good.slice(0, -4), `${good}AAAAAAAAAAAAAAAAAAAAAA==`, `${good}!`])
      expect(faultOf(() => wxoaDecrypt(KEY, encrypt, APPID))).toBe('format')
  })

  it('one byte changed: msg_signature no longer matches, and in the last block the padding fails', () => {
    const encrypt = wxoaEncrypt(KEY, 'hello world', APPID, RANDOM)
    const signature = wxoaSign('token1', '1714112445', '415670741', encrypt)
    const bytes = Buffer.from(encrypt, 'base64')
    bytes[bytes.length - 1]! ^= 0x01
    const tampered = bytes.toString('base64')
    expect(wxoaSignOk(signature, 'token1', '1714112445', '415670741', tampered)).toBe(false)
    expect(faultOf(() => wxoaDecrypt(KEY, tampered, APPID))).not.toBeNull()
  })

  it('a wrong key never opens', () => {
    const encrypt = wxoaEncrypt(KEY, 'hello', APPID)
    expect(faultOf(() => wxoaDecrypt(Buffer.alloc(32, 7), encrypt, APPID))).not.toBeNull()
  })
})

describe('signature compare', () => {
  const parts = ['token1', '1714112445', '415670741'] as const
  const good = wxoaSign(...parts)

  it('the parts in any order sign alike (sorted first)', () => {
    expect(wxoaSign('415670741', 'token1', '1714112445')).toBe(good)
  })

  it('a signature of another length is false, never a throw', () => {
    for (const given of [good.slice(0, -1), `${good}0`, '', good.repeat(2)])
      expect(wxoaSignOk(given, ...parts)).toBe(false)
  })

  it('one character changed, upper case, or no string at all is false', () => {
    const changed = `${good.slice(0, -1)}${good.endsWith('0') ? '1' : '0'}`
    for (const given of [changed, good.toUpperCase(), [good], undefined, 42])
      expect(wxoaSignOk(given, ...parts)).toBe(false)
    expect(wxoaSignOk(good, ...parts)).toBe(true)
  })
})

describe('timestamp window', () => {
  const now = 1_714_112_445_000
  it('300 s either way passes; 301 s or anything but plain digits does not', () => {
    for (const t of ['1714112445', '1714112745', '1714112145', '1714112744'])
      expect(wxoaTimeOk(t, now)).toBe(true)
    for (const t of [
      '1714112746',
      '1714112144',
      '',
      '17141124.5',
      '-1714112445',
      '1714112445.0',
      ' 1714112445',
      '1.714112445e9',
      '01714112445',
      ['1714112445'],
    ])
      expect(wxoaTimeOk(t, now)).toBe(false)
  })
})

describe('sealed passive reply', () => {
  const cipher = { token: 'token1', key: KEY, appId: APPID }

  it('carries the push nonce, a fresh timestamp and a signature over them', () => {
    const before = Math.floor(Date.now() / 1000)
    const xml = wxoaReplyXml(
      { openId: 'oFan', toUser: 'gh_0123456789ab' },
      { kind: 'text', content: 'hi ]]> there' },
    )!
    const sealed = wxoaParseXml(wxoaSealReply(cipher, xml, { nonce: '415670741' }))
    expect(Object.keys(sealed).sort()).toEqual(['Encrypt', 'MsgSignature', 'Nonce', 'TimeStamp'])
    expect(sealed.Nonce).toBe('415670741')
    expect(Number(sealed.TimeStamp)).toBeGreaterThanOrEqual(before)
    expect(
      wxoaSignOk(
        sealed.MsgSignature,
        'token1',
        sealed.TimeStamp as string,
        '415670741',
        sealed.Encrypt as string,
      ),
    ).toBe(true)
    expect(wxoaDecrypt(KEY, sealed.Encrypt as string, APPID)).toBe(xml)
  })

  it('a nonce holding ]]> or markup stays inside its CDATA', () => {
    for (const nonce of ['a]]>b', 'a</Nonce><Encrypt>x</Encrypt><Nonce>b']) {
      const sealed = wxoaParseXml(wxoaSealReply(cipher, '<xml/>', { nonce }))
      expect(sealed.Nonce).toBe(nonce)
      expect(wxoaDecrypt(KEY, sealed.Encrypt as string, APPID)).toBe('<xml/>')
    }
  })
})
