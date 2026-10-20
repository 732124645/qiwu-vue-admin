import { z } from 'zod'
import { fieldDomains } from '../../validation/zod-i18n.js'
import {
  WXOA_APP_ID,
  WXOA_BUTTON_KINDS,
  WXOA_CLIENT_PLATFORMS,
  WXOA_LEGACY_BUTTON_KINDS,
  WXOA_MENU_KINDS,
  wxoaBytes,
  wxoaHttpUrl,
  wxoaId,
  wxoaNeed,
  wxoaTagId,
  type WxoaButtonKind,
  type WxoaMenuKind,
} from './wxoa.schema.js'

/**
 * Custom menus (`wxoa_menu`), `/api/wxoa/menus`: one default menu per account and conditional menus
 * matching a fan tag and / or a client platform. `buttons` is saved as a draft and sent on publish.
 * WeChat's limits: 1–3 buttons, 1–5 sub-buttons each; names ≤ 16 UTF-8 bytes (sub-buttons ≤ 60), keys
 * ≤ 128, links ≤ 1024 (bytes as UTF-8, the count WeChat applies is not confirmed).
 */

export const WXOA_MENU_LIMITS = {
  buttons: 3,
  subButtons: 5,
  nameBytes: 16,
  subNameBytes: 60,
  keyBytes: 128,
  urlBytes: 1024,
} as const

const BUTTON_PROPS = ['key', 'url', 'appId', 'pagePath', 'articleId', 'mediaId'] as const
type ButtonProp = (typeof BUTTON_PROPS)[number]

/** The fields each button kind needs and the only ones it takes besides `name`. */
export const WXOA_BUTTON_FIELDS = {
  click: ['key'],
  scancode_push: ['key'],
  scancode_waitmsg: ['key'],
  pic_sysphoto: ['key'],
  pic_photo_or_album: ['key'],
  pic_weixin: ['key'],
  location_select: ['key'],
  view: ['url'],
  miniprogram: ['url', 'appId', 'pagePath'],
  article_id: ['articleId'],
  article_view_limited: ['articleId'],
  media_id: ['mediaId'],
  view_limited: ['mediaId'],
} as const satisfies Record<WxoaButtonKind, readonly ButtonProp[]>

const buttonProps = {
  key: wxoaBytes(WXOA_MENU_LIMITS.keyBytes).optional(),
  url: wxoaHttpUrl(WXOA_MENU_LIMITS.urlBytes).optional(),
  /** the mini program's AppID */
  appId: z.string().regex(WXOA_APP_ID).optional(),
  pagePath: wxoaBytes(WXOA_MENU_LIMITS.urlBytes).optional(),
  articleId: z.string().min(1).max(128).optional(),
  mediaId: z.string().min(1).max(128).optional(),
}

type ButtonInput = Partial<Record<ButtonProp, unknown>> & {
  kind?: WxoaButtonKind
  subButtons?: unknown[]
}

/**
 * A button with `subButtons` is a parent: a name and nothing else. Any other one needs its `kind` and
 * exactly the fields of {@link WXOA_BUTTON_FIELDS} (missing → `validation.required`, foreign →
 * `validation.invalid`).
 */
function checkButton(b: ButtonInput, ctx: z.RefinementCtx) {
  const parent = b.subButtons !== undefined
  wxoaNeed(b.kind, !parent, 'kind', ctx)
  const wanted: readonly ButtonProp[] = (!parent && b.kind && WXOA_BUTTON_FIELDS[b.kind]) || []
  for (const prop of BUTTON_PROPS) wxoaNeed(b[prop], wanted.includes(prop), prop, ctx)
}

const name = (maxBytes: number) => z.string().trim().pipe(wxoaBytes(maxBytes))

function buttonTree(kinds: readonly [WxoaButtonKind, ...WxoaButtonKind[]]) {
  const kind = z.enum(kinds).optional()
  const sub = z
    .strictObject({ name: name(WXOA_MENU_LIMITS.subNameBytes), kind, ...buttonProps })
    .superRefine(checkButton)
  const top = z
    .strictObject({
      name: name(WXOA_MENU_LIMITS.nameBytes),
      kind,
      ...buttonProps,
      subButtons: z.array(sub).min(1).max(WXOA_MENU_LIMITS.subButtons).optional(),
    })
    .superRefine(checkButton)
  return z.array(top).min(1).max(WXOA_MENU_LIMITS.buttons)
}

/** Buttons a new menu may have (no retired kinds). */
export const wxoaButtons = buttonTree(WXOA_BUTTON_KINDS)
/**
 * Buttons as stored and as a PUT sends them: a menu pulled from WeChat may hold retired kinds, shown
 * read-only; {@link wxoaMenuUpdateFor} lets a save keep or drop them, never add or change one.
 */
export const wxoaStoredButtons = buttonTree([...WXOA_BUTTON_KINDS, ...WXOA_LEGACY_BUTTON_KINDS])
export type WxoaButton = z.infer<typeof wxoaStoredButtons>[number]

const menuFields = {
  label: z.string().trim().min(1).max(64),
  matchTagId: wxoaTagId.nullish(),
  matchPlatform: z.enum(WXOA_CLIENT_PLATFORMS).nullish(),
}

/** A conditional menu matches a tag and / or a platform; a default menu matches nothing. */
function checkMatch(
  m: { menuKind: WxoaMenuKind; matchTagId?: number | null; matchPlatform?: string | null },
  ctx: z.RefinementCtx,
) {
  const matched = m.matchTagId != null || m.matchPlatform != null
  if (m.menuKind === 'conditional' && !matched)
    ctx.addIssue({ code: 'custom', path: ['matchTagId'], message: 'validation.wxoa.menu_match' })
  if (m.menuKind === 'default')
    for (const prop of ['matchTagId', 'matchPlatform'] as const)
      if (m[prop] != null)
        ctx.addIssue({ code: 'custom', path: [prop], message: 'validation.invalid' })
}

/** POST body; one default menu per account (409). */
export const wxoaMenuCreate = z
  .object({
    accountId: wxoaId,
    menuKind: z.enum(WXOA_MENU_KINDS),
    ...menuFields,
    buttons: wxoaButtons,
  })
  .superRefine(checkMatch)
  .register(fieldDomains, { domain: 'wxoa.menu' })
export type WxoaMenuCreate = z.infer<typeof wxoaMenuCreate>

/** PUT body: every field but `accountId` and `menuKind`, both fixed once added. */
export const wxoaMenuUpdate = z
  .strictObject({ ...menuFields, buttons: wxoaStoredButtons })
  .register(fieldDomains, { domain: 'wxoa.menu' })
export type WxoaMenuUpdate = z.infer<typeof wxoaMenuUpdate>

type Located = {
  button: { name: string; kind?: WxoaButtonKind; mediaId?: string }
  path: (string | number)[]
}
const LEGACY: readonly string[] = WXOA_LEGACY_BUTTON_KINDS

/** Retired-kind buttons, top-level and nested, with their paths in the body. */
function legacyButtons(buttons: readonly WxoaButton[]): Located[] {
  const all: Located[] = buttons.flatMap((button, i) => [
    { button, path: ['buttons', i] },
    ...(button.subButtons ?? []).map((sub, j) => ({
      button: sub,
      path: ['buttons', i, 'subButtons', j],
    })),
  ])
  return all.filter(({ button }) => button.kind !== undefined && LEGACY.includes(button.kind))
}

const legacyId = (b: Located['button']) => JSON.stringify([b.name, b.kind, b.mediaId])

/**
 * {@link wxoaMenuUpdate} with the checks that need the stored menu, for the service
 * (`parseOr400(wxoaMenuUpdateFor(row), body)`) and the form alike: match conditions by the stored kind,
 * and every retired-kind button one of the stored ones, unchanged (each stored one kept at most once).
 */
export function wxoaMenuUpdateFor(stored: {
  menuKind: WxoaMenuKind
  buttons: readonly WxoaButton[]
}) {
  return wxoaMenuUpdate
    .superRefine((m, ctx) => {
      checkMatch({ ...m, menuKind: stored.menuKind }, ctx)
      const left = new Map<string, number>()
      for (const { button } of legacyButtons(stored.buttons))
        left.set(legacyId(button), (left.get(legacyId(button)) ?? 0) + 1)
      for (const { button, path } of legacyButtons(m.buttons)) {
        const n = left.get(legacyId(button)) ?? 0
        if (n > 0) left.set(legacyId(button), n - 1)
        else
          ctx.addIssue({ code: 'custom', path: [...path, 'kind'], message: 'validation.invalid' })
      }
    })
    .register(fieldDomains, { domain: 'wxoa.menu' })
}

/** POST /try-match: which menu a fan (openid or WeChat ID) sees. */
export const wxoaMenuTryMatchBody = z
  .object({ accountId: wxoaId, userId: z.string().trim().min(1).max(64) })
  .register(fieldDomains, { domain: 'wxoa.menu' })
export type WxoaMenuTryMatchBody = z.infer<typeof wxoaMenuTryMatchBody>

export const wxoaMenuVo = z.object({
  id: z.number().int(),
  accountId: z.number().int(),
  menuKind: z.enum(WXOA_MENU_KINDS),
  label: z.string(),
  matchTagId: z.number().int().nullable(),
  matchPlatform: z.enum(WXOA_CLIENT_PLATFORMS).nullable(),
  buttons: wxoaStoredButtons,
  wxMenuId: z.string().nullable(),
  publishedAt: z.iso.datetime().nullable(),
  /** the buttons differ from the ones last published */
  unpublished: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type WxoaMenuVo = z.infer<typeof wxoaMenuVo>

/**
 * POST /pull: the account's menus afterwards, and the menus WeChat has that were not taken — a
 * conditional one matching neither a tag nor a platform (`no_match`), or one whose buttons or match
 * rule this module cannot hold (`invalid`); `wxMenuId` is null when WeChat gave none.
 */
export const wxoaMenuPullResult = z.object({
  menus: z.array(wxoaMenuVo),
  skipped: z.array(
    z.object({
      menuKind: z.enum(WXOA_MENU_KINDS),
      wxMenuId: z.string().nullable(),
      reason: z.enum(['no_match', 'invalid']),
    }),
  ),
})
export type WxoaMenuPullResult = z.infer<typeof wxoaMenuPullResult>
export type WxoaMenuSkipped = WxoaMenuPullResult['skipped'][number]

/** POST /try-match: the buttons WeChat shows the fan, in the stored shape; none when no menu matched. */
export const wxoaMenuTryMatchVo = z.object({ buttons: z.array(wxoaStoredButtons.element) })
export type WxoaMenuTryMatchVo = z.infer<typeof wxoaMenuTryMatchVo>
