import { describe, expect, it } from 'vitest'
import { CG_BATCH_MAX, cgDownloadQuery } from './codegen-api.schema.js'

describe('cgDownloadQuery', () => {
  it('ids: comma-separated or repeated, 1 to CG_BATCH_MAX positive integers', () => {
    expect(cgDownloadQuery.parse({ ids: '3,1' }).ids).toEqual([3, 1])
    expect(cgDownloadQuery.parse({ ids: '7' }).ids).toEqual([7])
    expect(cgDownloadQuery.parse({ ids: ['2', '5'] }).ids).toEqual([2, 5])
    const bad = [
      undefined,
      '',
      '1,',
      '0',
      '-1',
      '1.5',
      'x',
      String(Array(CG_BATCH_MAX + 1).fill(1)),
    ]
    expect(bad.filter((ids) => cgDownloadQuery.safeParse({ ids }).success)).toEqual([])
  })
})
