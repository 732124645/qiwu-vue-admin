// 聊天接口契约：请求严格（未知字段 400）、整数安全、发送体的类型与字段搭配、实时提示的形状、错误码、
// 表情与 emoji 清单、存储标签与静态路由名。
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { Err } from '../../common/error-codes.js'
import { IM_INT_PARAMS, imParams } from '../../common/params.js'
import { RT, SESSION_END_REASONS } from '../../common/realtime.js'
import { WEB_STATIC_ROUTE_NAMES } from '../../common/reserved-names.js'
import { fieldDomainOf } from '../../validation/zod-i18n.js'
import { IM_STORAGE_TAGS, STORAGE_BIZ_TAGS } from '../storage/storage.schema.js'
import { IM_EMOJI_CATEGORIES } from './emoji.js'
import {
  IM_LIMITS,
  imCodePoints,
  imDirectCreate,
  imEntriesQuery,
  imEntryEdit,
  imEntryHint,
  imEntrySend,
  imEntryVo,
  imFileQuery,
  imGroupCreate,
  imLabelChange,
  imMembersAdd,
  imOwnerTransfer,
  imPathId,
  imReadBody,
  imRoleChange,
  imRoomHint,
  imStickerFileQuery,
  imStickerFromEntry,
  imStickerOrder,
  imSyncQuery,
  imSyncTupleVo,
  imTextOk,
} from './im.schema.js'
import { IM_STICKER_CODES, isImStickerCode } from './stickers.js'

const ok = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success
const UNSAFE = Number.MAX_SAFE_INTEGER + 2

/** 每个请求结构与一个合法值（未知字段 / 不安全整数的用例从它变出来）。 */
const REQUESTS: [string, z.ZodType, Record<string, unknown>][] = [
  ['imSyncQuery', imSyncQuery, { ids: '1,2' }],
  ['imDirectCreate', imDirectCreate, { peerId: 2 }],
  ['imGroupCreate', imGroupCreate, { label: 'team', userIds: [2, 3] }],
  ['imMembersAdd', imMembersAdd, { userIds: [4] }],
  ['imOwnerTransfer', imOwnerTransfer, { userId: 4 }],
  ['imRoleChange', imRoleChange, { role: 'moderator' }],
  ['imLabelChange', imLabelChange, { label: 'renamed' }],
  ['imReadBody', imReadBody, { seq: 10 }],
  ['imEntriesQuery', imEntriesQuery, { afterSeq: '3', limit: '20' }],
  ['imEntrySend', imEntrySend, { clientEntryId: 'a-1', kind: 'text', text: 'hi' }],
  ['imEntryEdit', imEntryEdit, { text: 'fixed', rev: 1 }],
  ['imFileQuery', imFileQuery, { thumb: '1', proxy: '0' }],
  ['imStickerFileQuery', imStickerFileQuery, { proxy: '1' }],
  ['imStickerFromEntry', imStickerFromEntry, { roomId: 1, seq: 2 }],
  ['imStickerOrder', imStickerOrder, { ids: [3, 1, 2] }],
]

describe('requests', () => {
  it.each(REQUESTS)('%s accepts its sample and refuses an unknown field', (_, schema, sample) => {
    expect(ok(schema, sample)).toBe(true)
    expect(ok(schema, { ...sample, extra: 1 })).toBe(false)
    expect(fieldDomainOf(schema)).toBe('im')
  })

  it('ids are positive safe integers, in bodies, paths and lists', () => {
    expect(ok(imDirectCreate, { peerId: UNSAFE })).toBe(false)
    expect(ok(imDirectCreate, { peerId: 0 })).toBe(false)
    expect(ok(imDirectCreate, { peerId: 1.5 })).toBe(false)
    expect(ok(imDirectCreate, { peerId: '2' })).toBe(false)
    expect(ok(imStickerOrder, { ids: [1, UNSAFE] })).toBe(false)
    expect(imPathId.parse('42')).toBe(42)
    for (const bad of ['0', '-1', '01', '1e3', '1.0', ' 1', String(UNSAFE), '99999999999999999'])
      expect([bad, ok(imPathId, bad)]).toEqual([bad, false])
  })

  it('id lists are unique and bounded', () => {
    expect(ok(imGroupCreate, { label: 'g', userIds: [2, 2] })).toBe(false)
    expect(ok(imGroupCreate, { label: 'g', userIds: [] })).toBe(false)
    expect(ok(imStickerOrder, { ids: [1, 1] })).toBe(false)
    expect(imSyncQuery.parse({ ids: '3,1,3' }).ids).toEqual([3, 1])
    const many = Array.from({ length: IM_LIMITS.idsMax + 1 }, (_, i) => i + 1).join(',')
    expect(ok(imSyncQuery, { ids: many })).toBe(false)
    for (const bad of ['', ',1', '1,,2', 'a', '0'])
      expect([bad, ok(imSyncQuery, { ids: bad })]).toEqual([bad, false])
  })

  it('a group name is trimmed and at most 80 characters', () => {
    expect(imLabelChange.parse({ label: '  team  ' }).label).toBe('team')
    expect(ok(imLabelChange, { label: '   ' })).toBe(false)
    expect(ok(imLabelChange, { label: 'x'.repeat(IM_LIMITS.labelMax + 1) })).toBe(false)
  })

  it('only moderator and participant can be assigned', () => {
    expect(ok(imRoleChange, { role: 'participant' })).toBe(true)
    expect(ok(imRoleChange, { role: 'owner' })).toBe(false)
  })

  it('entries: afterSeq, beforeSeq and seqs exclude each other; limit is bounded', () => {
    expect(imEntriesQuery.parse({})).toEqual({})
    expect(imEntriesQuery.parse({ afterSeq: '0' })).toEqual({ afterSeq: 0 })
    expect(imEntriesQuery.parse({ seqs: '5,4' }).seqs).toEqual([5, 4])
    expect(ok(imEntriesQuery, { afterSeq: '1', beforeSeq: '9' })).toBe(false)
    expect(ok(imEntriesQuery, { afterSeq: '1', seqs: '2' })).toBe(false)
    expect(ok(imEntriesQuery, { beforeSeq: '0' })).toBe(false)
    expect(ok(imEntriesQuery, { afterSeq: '' })).toBe(false)
    expect(ok(imEntriesQuery, { limit: '0' })).toBe(false)
    expect(ok(imEntriesQuery, { limit: String(IM_LIMITS.entriesMax + 1) })).toBe(false)
  })

  it('a read position is a non-negative safe integer', () => {
    expect(ok(imReadBody, { seq: 0 })).toBe(true)
    expect(ok(imReadBody, { seq: -1 })).toBe(false)
    expect(ok(imReadBody, { seq: UNSAFE })).toBe(false)
  })
})

describe('send body', () => {
  const base = { clientEntryId: '0b5d3c1e-7f00-4a1b-9c2d-1234567890ab' }

  it('each kind takes exactly its own fields', () => {
    expect(ok(imEntrySend, { ...base, kind: 'text', text: 'hi 👋' })).toBe(true)
    expect(ok(imEntrySend, { ...base, kind: 'image', objectId: 5 })).toBe(true)
    expect(ok(imEntrySend, { ...base, kind: 'file', objectId: 5 })).toBe(true)
    expect(ok(imEntrySend, { ...base, kind: 'sticker', stickerCode: 'smile' })).toBe(true)
    expect(ok(imEntrySend, { ...base, kind: 'sticker', stickerId: 7 })).toBe(true)

    expect(ok(imEntrySend, { ...base, kind: 'text' })).toBe(false)
    expect(ok(imEntrySend, { ...base, kind: 'text', text: 'hi', objectId: 5 })).toBe(false)
    expect(ok(imEntrySend, { ...base, kind: 'image' })).toBe(false)
    expect(ok(imEntrySend, { ...base, kind: 'image', objectId: 5, text: 'x' })).toBe(false)
    expect(ok(imEntrySend, { ...base, kind: 'sticker' })).toBe(false)
    expect(ok(imEntrySend, { ...base, kind: 'sticker', stickerCode: 'smile', stickerId: 7 })).toBe(
      false,
    )
    expect(ok(imEntrySend, { ...base, kind: 'event' })).toBe(false)
  })

  it('an unknown built-in sticker code is refused', () => {
    expect(ok(imEntrySend, { ...base, kind: 'sticker', stickerCode: 'nope' })).toBe(false)
  })

  it('text: blank or control characters other than line feed and tab are refused', () => {
    expect(ok(imEntrySend, { ...base, kind: 'text', text: 'a\nb\tc' })).toBe(true)
    for (const bad of ['', '   ', '\n', 'a\u0000b', 'a\u0007', 'a\rb', 'a\u007fb', 'a\u0085b'])
      expect([bad, ok(imEntrySend, { ...base, kind: 'text', text: bad })]).toEqual([bad, false])
    expect(ok(imEntryEdit, { text: 'a\u0000', rev: 1 })).toBe(false)
    expect(ok(imEntryEdit, { text: ' ', rev: 1 })).toBe(false)
    expect(ok(imEntryEdit, { text: 'x', rev: 0 })).toBe(false)
    expect(imTextOk('ok')).toBe(true)
    expect(imCodePoints('a😀')).toBe(2)
  })

  it('clientEntryId is a short ASCII token', () => {
    expect(ok(imEntrySend, { kind: 'text', text: 'x', clientEntryId: 'a b' })).toBe(false)
    expect(ok(imEntrySend, { kind: 'text', text: 'x', clientEntryId: '' })).toBe(false)
    expect(
      ok(imEntrySend, {
        kind: 'text',
        text: 'x',
        clientEntryId: 'a'.repeat(IM_LIMITS.clientEntryIdMax + 1),
      }),
    ).toBe(false)
  })
})

describe('responses and hints', () => {
  it('the sync tuple has six safe integers', () => {
    expect(ok(imSyncTupleVo, [1, 2, 3, 1, 1, 1])).toBe(true)
    expect(ok(imSyncTupleVo, [1, 2, 3, 1, 1])).toBe(false)
    expect(ok(imSyncTupleVo, [1, 2, UNSAFE, 1, 1, 1])).toBe(false)
  })

  it('realtime hints carry ids only, never content', () => {
    expect(RT.imEntry).toBe('im:entry')
    expect(RT.imRoom).toBe('im:room')
    expect(ok(imEntryHint, { roomId: 1, seq: 2, authorId: 3, kind: 'text' })).toBe(true)
    expect(ok(imEntryHint, { roomId: 1, seq: 2, authorId: null, kind: 'event' })).toBe(true)
    expect(ok(imEntryHint, { roomId: 1, seq: 2, authorId: 3, kind: 'text', text: 'x' })).toBe(false)
    expect(ok(imRoomHint, { roomId: 1 })).toBe(true)
    expect(ok(imRoomHint, { roomId: 1, readSeq: 9 })).toBe(true)
    expect(ok(imRoomHint, { roomId: 1, label: 'x' })).toBe(false)
    expect(SESSION_END_REASONS).toContain('app_replaced')
  })

  it('an entry is strict', () => {
    const entry = {
      seq: 1,
      kind: 'text',
      authorId: 2,
      authorKind: 'admin',
      authorLabel: 'A',
      clientEntryId: null,
      text: 'hi',
      stickerCode: null,
      attachment: null,
      event: null,
      targetSeq: null,
      rev: 1,
      createdAt: '2026-11-03T00:00:00.000Z',
      editedAt: null,
      recalledAt: null,
      recalledBy: null,
    }
    expect(ok(imEntryVo, entry)).toBe(true)
    expect(ok(imEntryVo, { ...entry, requestDigest: 'x' })).toBe(false)
  })
})

describe('catalogs and codes', () => {
  it('24 unique built-in sticker codes, safe as file names and i18n keys', () => {
    expect(IM_STICKER_CODES).toHaveLength(24)
    expect(new Set(IM_STICKER_CODES).size).toBe(24)
    for (const code of IM_STICKER_CODES) {
      expect(code).toMatch(/^[a-z][a-z0-9]{0,31}$/)
      expect(isImStickerCode(code)).toBe(true)
    }
    expect(isImStickerCode('constructor')).toBe(false)
  })

  it('the emoji picker lists unique characters per category', () => {
    const all = IM_EMOJI_CATEGORIES.flatMap((c) => [...c.items])
    expect(IM_EMOJI_CATEGORIES.length).toBeGreaterThan(1)
    expect(new Set(all).size).toBe(all.length)
    for (const e of all) expect(imTextOk(e)).toBe(true)
  })

  it('chat and media error codes are unique with their statuses', () => {
    const im = Object.values(Err).filter((e) => e.code.startsWith('B5'))
    expect(im.map((e) => e.code).sort()).toEqual([
      ...Array.from({ length: 13 }, (_, i) => `B50${String(i + 1).padStart(2, '0')}`),
      'B5020',
      'B5021',
      'B5030',
      'B5031',
      'B5032',
      'B5033',
      'B5034',
    ])
    for (const e of im) expect(e.key).toMatch(/^error\.im\.[a-z_]+$/)
    expect(Err.IM_STAFF_ONLY.status).toBe(403)
    expect(Err.IM_ROOM_NOT_FOUND.status).toBe(404)
    expect(Err.IM_CLIENT_ID_CONFLICT.status).toBe(409)
    expect(Err.IM_VOICE_INVALID.status).toBe(422)
    expect(Err.IM_VOICE_TOO_LONG.status).toBe(422)
    expect(Err.IM_CALL_NOT_FOUND.status).toBe(404)
    for (const e of [Err.IM_CALL_CONFLICT, Err.IM_CALL_STATE, Err.IM_CALL_SESSION])
      expect(e.status).toBe(409)
    expect(Err.IM_CALL_UNAVAILABLE.status).toBe(503)
  })

  it('the chat storage tags never pass the generic storage routes', () => {
    for (const tag of IM_STORAGE_TAGS)
      expect(STORAGE_BIZ_TAGS as readonly string[]).not.toContain(tag)
  })

  it('chat params are under im. with defaults inside their bounds; the chat page is a static route', () => {
    for (const key of Object.values(imParams)) expect(key).toMatch(/^im\.[a-z_]+\.[a-z_]+$/)
    for (const p of Object.values(IM_INT_PARAMS)) {
      expect(p.fallback).toBeGreaterThanOrEqual(p.min)
      expect(p.fallback).toBeLessThanOrEqual(p.max)
    }
    expect(WEB_STATIC_ROUTE_NAMES).toContain('im-chat')
  })
})
