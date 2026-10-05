import { describe, expect, it } from 'vitest'
import { cronExpr, jobParamsText } from './scheduler/scheduler.schema.js'
import { storageConfigCreate, storageConfigUpdate } from './storage/storage-driver.schema.js'
import {
  fsConfirmBody,
  STORAGE_MAX_SIZE_DEFAULT,
  storageMaxBytes,
} from './storage/storage.schema.js'

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) =>
  schema.safeParse(v).success

describe('scheduler contracts', () => {
  it('cron: 5 or 6 fields of digits and * , - / only', () => {
    const good = ['*/10 * * * *', '0 */5 * * * *', '0 0 2 * * 1-5', ' 0 0,30 8-18 * * * ']
    expect(good.filter((c) => !ok(cronExpr, c))).toEqual([])
    const bad = [
      '',
      '* * * *',
      '0 0 0 1 1 * 2030',
      '0 0 12 ? * MON',
      '0 0 L * *',
      '@daily',
      '0 0 1#2 * *',
    ]
    expect(bad.filter((c) => ok(cronExpr, c))).toEqual([])
  })

  it('params: JSON object text, blank = null', () => {
    expect(jobParamsText.parse(' ')).toBeNull()
    expect(jobParamsText.parse('{"days": 30}')).toBe('{"days": 30}')
    for (const v of ['[1]', 'null', '3', '{x}'])
      expect(jobParamsText.safeParse(v).error?.issues[0]?.message).toBe('validation.json_object')
  })
})

describe('storage contracts', () => {
  const s3 = {
    driver: 's3',
    name: 'oss',
    endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
    region: 'cn-hangzhou',
    bucket: 'qw-files',
    accessKey: 'AK',
    secretKey: 'SK',
  }

  it('config: flat per driver; local never keeps a root; s3 needs its secret only when added', () => {
    expect(
      storageConfigCreate.parse({ driver: 'local', name: 'l', root: '/etc' }),
    ).not.toHaveProperty('root')
    expect(storageConfigCreate.parse(s3)).toMatchObject({ forcePathStyle: false })
    const { secretKey: _, ...noSecret } = s3
    expect(ok(storageConfigCreate, noSecret)).toBe(false)
    expect(ok(storageConfigUpdate, noSecret)).toBe(true)
    const bad = [
      { endpoint: 'ftp://host' },
      { endpoint: 'host:9000' },
      { bucket: 'No_Caps' },
      { bucket: 'ab' },
      { region: 'Region 1' },
      { driver: 'ftp' },
    ]
    expect(bad.filter((b) => ok(storageConfigCreate, { ...s3, ...b }))).toEqual([])
    const prefix = (publicPrefix: string) =>
      ok(storageConfigCreate, { driver: 'local', name: 'l', publicPrefix })
    expect(['/files', 'https://cdn.example.com/f', ''].every(prefix)).toBe(true)
    expect(['//evil.example.com', '/\\evil', 'files', 'javascript:alert(1)'].some(prefix)).toBe(
      false,
    )
  })

  it('confirm: only a key the server makes', () => {
    const key = '2026/09/28/0b7f6a0e-3c1d-4f5e-9a2b-8c7d6e5f4a3b.png'
    expect(ok(fsConfirmBody, { key })).toBe(true)
    const bad = ['../2026/09/28/x.png', `${key}/..`, key.toUpperCase(), 'a.png', '']
    expect(bad.filter((k) => ok(fsConfirmBody, { key: k }))).toEqual([])
  })

  it('upload limit: an integer 1–2048 MB as the server reads it, the default otherwise', () => {
    const MB = 1024 * 1024
    expect([' 50 ', '1', '2048'].map(storageMaxBytes)).toEqual([50 * MB, MB, 2048 * MB])
    for (const v of [null, undefined, '', ' ', '0', '2049', '1.5', '-3', 'abc'])
      expect(storageMaxBytes(v)).toBe(STORAGE_MAX_SIZE_DEFAULT)
  })
})
