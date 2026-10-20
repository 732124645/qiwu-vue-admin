import { createHash } from 'node:crypto'
import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  Err,
  WXOA_BUTTON_FIELDS,
  WXOA_CLIENT_PLATFORMS,
  type WxoaButton,
  type WxoaMenuCreate,
  type WxoaMenuKind,
  type WxoaMenuPullResult,
  type WxoaMenuSkipped,
  type WxoaMenuTryMatchBody,
  type WxoaMenuTryMatchVo,
  type WxoaMenuUpdate,
  type WxoaMenuVo,
  wxoaMenuUpdateFor,
  wxoaPerms,
  wxoaStoredButtons,
} from '@qiwu/shared'
import type { QueryDeepPartialEntity } from 'typeorm'
import { clsGet } from '../../../../core/context/cls.js'
import { BaseCrudService } from '../../../../core/db/base-crud.service.js'
import { BizError } from '../../../../core/http/biz-error.js'
import { parseOr400 } from '../../../../core/http/validation.pipe.js'
import { WxoaAccount, WxoaMenu, WxoaTag } from '../core/wxoa.entity.js'
import { type WxoaCaller, type WxoaJson, WxoaGateway } from '../core/wxoa-gateway.js'

type Platform = (typeof WXOA_CLIENT_PLATFORMS)[number]
type Leaf = Omit<WxoaButton, 'subButtons'>

/** Button fields as WeChat names them, in the order a request carries them. */
const WIRE = [
  ['key', 'key'],
  ['url', 'url'],
  ['appId', 'appid'],
  ['pagePath', 'pagepath'],
  ['articleId', 'article_id'],
  ['mediaId', 'media_id'],
] as const
const WIRE_NAME: Record<string, string> = Object.fromEntries(WIRE)
/** `client_platform_type` of a match rule */
const PLATFORM_CODE: Record<Platform, string> = { ios: '1', android: '2', other: '3' }
const PLATFORM_OF = new Map(Object.entries(PLATFORM_CODE).map(([k, v]) => [v, k as Platform]))

/** `menu/get` with no menu set through the API */
const NO_MENU = 46003
/** `delconditional` of a menuid WeChat no longer has */
const NO_CONDITIONAL = 65301
/** `addconditional` while WeChat has no default menu */
const NO_DEFAULT = 65303
const MENU_ID = /^\d{1,32}$/
/** the columns of a menu WeChat does not have */
const unpublished = { wxMenuId: null, publishedAt: null, publishedDigest: null }
const TAG_ID = /^\d{1,10}$/
const TAG_MAX = 4_294_967_295

/** Whether the caller holds the menu publish permission (root always does). */
const mayPublish = () => {
  const p = clsGet('principal')
  return p?.root === true || p?.perms.includes(wxoaPerms.menu.publish) === true
}

/** One button as WeChat takes it (fixed key order, so equal buttons serialize equally). */
function wireButton(b: WxoaButton | Leaf): Record<string, unknown> {
  if ('subButtons' in b && b.subButtons)
    return { name: b.name, sub_button: b.subButtons.map(wireButton) }
  const out: Record<string, unknown> = { type: b.kind, name: b.name }
  for (const [prop, wire] of WIRE) if (b[prop] !== undefined) out[wire] = b[prop]
  return out
}

/** One button of WeChat's in this module's shape (to be validated): only the fields of its kind. */
function ownButton(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw
  const w = raw as Record<string, unknown>
  if (Array.isArray(w.sub_button) && w.sub_button.length)
    return { name: w.name, subButtons: w.sub_button.map(ownButton) }
  const kind = typeof w.type === 'string' ? w.type : undefined
  const fields: readonly string[] =
    kind && Object.hasOwn(WXOA_BUTTON_FIELDS, kind)
      ? WXOA_BUTTON_FIELDS[kind as keyof typeof WXOA_BUTTON_FIELDS]
      : []
  return Object.fromEntries([
    ['name', w.name],
    ['kind', kind],
    ...fields.map((prop) => [prop, w[WIRE_NAME[prop]!]]),
  ])
}

/** WeChat's buttons as stored ones; null when they are none of this module's. */
function ownButtons(raw: unknown): WxoaButton[] | null {
  if (!Array.isArray(raw)) return null
  const parsed = wxoaStoredButtons.safeParse(raw.map(ownButton))
  return parsed.success ? parsed.data : null
}

type Publishable = Pick<WxoaMenu, 'menuKind' | 'buttons' | 'matchTagId' | 'matchPlatform'>

/** The body of `menu/create` (default) or `menu/addconditional` (conditional). */
function publishBody(m: Publishable): WxoaJson {
  const button = m.buttons.map(wireButton)
  if (m.menuKind === 'default') return { button }
  const matchrule: Record<string, string> = {}
  if (m.matchTagId != null) matchrule.tag_id = String(m.matchTagId)
  if (m.matchPlatform) matchrule.client_platform_type = PLATFORM_CODE[m.matchPlatform as Platform]
  return { button, matchrule }
}

/** What a publish sends, hashed: a menu whose digest differs from the published one has changes. */
export const wxoaMenuDigest = (m: Publishable) =>
  createHash('sha256')
    .update(JSON.stringify(publishBody(m)))
    .digest('hex')

const vo = (m: WxoaMenu): WxoaMenuVo => ({
  id: m.id,
  accountId: m.accountId,
  menuKind: m.menuKind,
  label: m.label,
  matchTagId: m.matchTagId,
  matchPlatform: m.matchPlatform as Platform | null,
  buttons: m.buttons,
  wxMenuId: m.wxMenuId,
  publishedAt: m.publishedAt?.toISOString() ?? null,
  unpublished: m.publishedDigest !== wxoaMenuDigest(m),
  createdAt: m.createdAt.toISOString(),
  updatedAt: m.updatedAt.toISOString(),
})

const errcodeOf = (err: unknown) =>
  err instanceof BizError ? Number(err.params.errcode) : Number.NaN

/** A menu as `menu/get` lists it, in this module's shape. */
interface Pulled {
  menuKind: WxoaMenuKind
  wxMenuId: string | null
  buttons: WxoaButton[]
  matchTagId: number | null
  matchPlatform: Platform | null
}

const idOf = (raw: unknown) => {
  const s = typeof raw === 'number' ? String(raw) : raw
  return typeof s === 'string' && MENU_ID.test(s) ? s : null
}

/** A conditional menu of `menu/get` (tag and platform only: other conditions WeChat retired). */
function pulledConditional(raw: unknown): Pulled | WxoaMenuSkipped {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const wxMenuId = idOf(c.menuid)
  const rule = (c.matchrule && typeof c.matchrule === 'object' ? c.matchrule : {}) as Record<
    string,
    unknown
  >
  // `group_id` is the name older answers give the tag; an unused condition comes as ""
  const tagRaw = String(rule.tag_id ?? rule.group_id ?? '')
  const platformRaw = String(rule.client_platform_type ?? '')
  if (!tagRaw && !platformRaw) return { menuKind: 'conditional', wxMenuId, reason: 'no_match' }
  const matchTagId = TAG_ID.test(tagRaw) && Number(tagRaw) <= TAG_MAX ? Number(tagRaw) : null
  const matchPlatform = PLATFORM_OF.get(platformRaw) ?? null
  const buttons = ownButtons(c.button)
  if (
    !wxMenuId ||
    !buttons ||
    (tagRaw && matchTagId === null) ||
    (platformRaw && matchPlatform === null)
  )
    return { menuKind: 'conditional', wxMenuId, reason: 'invalid' }
  return { menuKind: 'conditional', wxMenuId, buttons, matchTagId, matchPlatform }
}

/**
 * Custom menus (see docs/design-notes.md#wxoa). Menus are drafts until published: the default one
 * through `menu/create`, a conditional one through `addconditional` once the default one is published
 * (`B6009`). The digest of what was last published tells unpublished changes. A pull overwrites the
 * local menus WeChat has; clearing removes every menu on WeChat and leaves the drafts. Every route goes
 * through the account: alive (404) and enabled (`B6011`); a new match tag must be one of the account's
 * (404), a pulled one is kept as it is.
 */
@Injectable()
export class WxoaMenuService extends BaseCrudService<WxoaMenu> {
  private readonly logger = new Logger(WxoaMenuService.name)

  constructor(
    txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly gateway: WxoaGateway,
  ) {
    super(txHost, WxoaMenu)
  }

  /** The account's menus, the default one first. */
  async list(accountId: number): Promise<WxoaMenuVo[]> {
    await this.account(accountId)
    const rows = await this.repo.find({ where: { accountId }, order: { id: 'ASC' } })
    return [
      ...rows.filter((m) => m.menuKind === 'default'),
      ...rows.filter((m) => m.menuKind !== 'default'),
    ].map(vo)
  }

  async one(id: number): Promise<WxoaMenuVo> {
    const row = await this.get(id)
    await this.account(row.accountId)
    return vo(row)
  }

  /** A draft; a second default menu of the account → 409 (unique index). */
  add(dto: WxoaMenuCreate): Promise<WxoaMenuVo> {
    return this.txHost.withTransaction(async () => {
      await this.account(dto.accountId)
      await this.assertTag(dto.accountId, dto.matchTagId)
      const row = await this.create({
        accountId: dto.accountId,
        menuKind: dto.menuKind,
        label: dto.label,
        matchTagId: dto.matchTagId ?? null,
        matchPlatform: dto.matchPlatform ?? null,
        buttons: dto.buttons,
      })
      return vo(await this.get(row.id))
    })
  }

  /** Replaces the draft as a whole, validated against the stored menu (its kind, its retired buttons). */
  change(id: number, dto: WxoaMenuUpdate): Promise<void> {
    return this.txHost.withTransaction(async () => {
      const { row } = await this.locked(id)
      const body = parseOr400(wxoaMenuUpdateFor(row), dto)
      if (body.matchTagId !== row.matchTagId) await this.assertTag(row.accountId, body.matchTagId)
      // a JSON column (`buttons`) is beyond what QueryDeepPartialEntity can type
      await this.repo.update(id, {
        label: body.label,
        matchTagId: body.matchTagId ?? null,
        matchPlatform: body.matchPlatform ?? null,
        buttons: body.buttons,
      } as QueryDeepPartialEntity<WxoaMenu>)
    })
  }

  /**
   * Deletes the menu here; a published conditional one is deleted on WeChat too (failing: nothing),
   * which changes what fans see and so needs the publish permission as well (else 403).
   */
  drop(id: number): Promise<void> {
    return this.txHost.withTransaction(async () => {
      const { row, account } = await this.locked(id)
      const live = row.menuKind === 'conditional' ? row.wxMenuId : null
      if (live && !mayPublish()) throw new ForbiddenException()
      await this.deleteRows([id])
      if (live) await this.delConditional(account, live)
    })
  }

  /**
   * Publishes the menu. A conditional one needs the account's default menu published (`B6009`, also when
   * WeChat answers it has none: the local default menu then counts as unpublished). It is added anew and
   * the one it replaces deleted afterwards: WeChat matches the newest menu first, so the matched fans see
   * no gap. A failed delete is logged with the menuid and leaves that menu on WeChat: under an unchanged
   * match rule it is never shown, but after a change of the rule it still serves the fans only the old
   * rule matches, until a pull lists it again (as a menu of its own) or a clear removes it.
   */
  async publish(id: number): Promise<WxoaMenuVo> {
    const done = await this.txHost.withTransaction(async () => {
      const { row, account } = await this.locked(id)
      const published = { publishedAt: new Date(), publishedDigest: wxoaMenuDigest(row) }
      if (row.menuKind === 'default') {
        await this.gateway.json(account, '/cgi-bin/menu/create', { body: publishBody(row) })
        await this.repo.update(id, published)
        return vo(await this.repo.findOneByOrFail({ id }))
      }
      const base = await this.repo.findOneBy({ accountId: row.accountId, menuKind: 'default' })
      if (!base?.publishedAt) throw new BizError(Err.WXOA_DEFAULT_MENU_REQUIRED)
      let answer: WxoaJson
      try {
        answer = await this.gateway.json(account, '/cgi-bin/menu/addconditional', {
          body: publishBody(row),
        })
      } catch (err) {
        if (errcodeOf(err) !== NO_DEFAULT) throw err
        // committed before the refusal is thrown
        await this.repo.update(base.id, unpublished)
        return null
      }
      const wxMenuId = idOf(answer.menuid)
      if (!wxMenuId) throw new BizError(Err.WXOA_UPSTREAM)
      await this.repo.update(id, { ...published, wxMenuId })
      if (row.wxMenuId && row.wxMenuId !== wxMenuId) {
        const replaced = row.wxMenuId
        await this.delConditional(account, replaced).catch((err: unknown) =>
          this.logger.warn(
            { accountId: account.id, menuid: replaced, err },
            'wxoa menu: replaced menu not deleted',
          ),
        )
      }
      return vo(await this.repo.findOneByOrFail({ id }))
    })
    if (!done) throw new BizError(Err.WXOA_DEFAULT_MENU_REQUIRED)
    return done
  }

  /**
   * Overwrites the local menus with WeChat's (`menu/get`): the default menu, and each conditional one by
   * its menuid; all of them published as pulled. A conditional menu matching neither a tag nor a
   * platform, or a menu with buttons this module does not take, is skipped and listed; its local menu
   * then shows unpublished changes. Local menus WeChat no longer has stay as unpublished drafts.
   */
  async pull(accountId: number): Promise<WxoaMenuPullResult> {
    const account = await this.account(accountId)
    let answer: WxoaJson = {}
    try {
      answer = await this.gateway.json(account, '/cgi-bin/menu/get')
    } catch (err) {
      if (errcodeOf(err) !== NO_MENU) throw err
    }
    const pulled: Pulled[] = []
    const skipped: WxoaMenuSkipped[] = []
    const menu = answer.menu as Record<string, unknown> | undefined
    if (menu?.button !== undefined) {
      const buttons = ownButtons(menu.button)
      if (buttons)
        pulled.push({
          menuKind: 'default',
          wxMenuId: null,
          buttons,
          matchTagId: null,
          matchPlatform: null,
        })
      else skipped.push({ menuKind: 'default', wxMenuId: idOf(menu.menuid), reason: 'invalid' })
    }
    for (const raw of Array.isArray(answer.conditionalmenu) ? answer.conditionalmenu : []) {
      const one = pulledConditional(raw)
      if ('reason' in one) skipped.push(one)
      else pulled.push(one)
    }
    // the local menu of one WeChat has: the default one, a conditional one by its menuid
    const isLocal = (p: Pick<Pulled, 'menuKind' | 'wxMenuId'>) => (m: WxoaMenu) =>
      p.menuKind === 'default'
        ? m.menuKind === 'default'
        : p.wxMenuId !== null && m.wxMenuId === p.wxMenuId
    await this.txHost.withTransaction(async () => {
      await this.account(accountId, true)
      const stored = await this.repo.find({ where: { accountId } })
      const now = new Date()
      for (const p of pulled) {
        const local = stored.find(isLocal(p))
        const fields = { ...p, publishedAt: now, publishedDigest: wxoaMenuDigest(p) }
        if (local) await this.repo.update(local.id, fields as QueryDeepPartialEntity<WxoaMenu>)
        else
          await this.repo.save(
            this.repo.create({ ...fields, accountId, label: p.wxMenuId ?? 'default' }),
          )
      }
      // what WeChat has differs from the local menu
      for (const s of skipped) {
        const local = stored.find(isLocal(s))
        if (local?.publishedDigest) await this.repo.update(local.id, { publishedDigest: null })
      }
      for (const m of stored)
        if (m.publishedAt && ![...pulled, ...skipped].some((p) => isLocal(p)(m)))
          await this.repo.update(m.id, unpublished)
    })
    return { menus: await this.list(accountId), skipped }
  }

  /** Removes every menu on WeChat (`menu/delete`, conditional ones included); drafts stay unpublished. */
  async clear(accountId: number): Promise<void> {
    const account = await this.account(accountId)
    await this.gateway.json(account, '/cgi-bin/menu/delete')
    await this.repo.update({ accountId }, unpublished)
  }

  /** The buttons a fan (openid or WeChat ID) sees, as WeChat matches them. */
  async tryMatch({ accountId, userId }: WxoaMenuTryMatchBody): Promise<WxoaMenuTryMatchVo> {
    const account = await this.account(accountId)
    const answer = await this.gateway.json(account, '/cgi-bin/menu/trymatch', {
      body: { user_id: userId },
    })
    if (Array.isArray(answer.button) && !answer.button.length) return { buttons: [] }
    const buttons = ownButtons(answer.button)
    if (!buttons) throw new BizError(Err.WXOA_UPSTREAM)
    return { buttons }
  }

  /** Locks menu `id` (404) and checks its account. */
  private async locked(id: number): Promise<{ row: WxoaMenu; account: WxoaCaller }> {
    await this.lockScopedIds([id])
    const row = await this.repo.findOneByOrFail({ id })
    return { row, account: await this.account(row.accountId) }
  }

  /** Account `id`, alive (else 404) and enabled (else `B6011`); `lock` holds its row. */
  private async account(id: number, lock = false): Promise<WxoaCaller> {
    const qb = this.txHost.tx
      .getRepository(WxoaAccount)
      .createQueryBuilder('a')
      .select(['a.id', 'a.appId', 'a.accountKind', 'a.enabled'])
      .where('a.id = :id', { id })
    const row = await (lock ? qb.setLock('pessimistic_write') : qb).getOne()
    if (!row) throw new NotFoundException()
    if (!row.enabled) throw new BizError(Err.WXOA_ACCOUNT_DISABLED)
    return { id: row.id, appId: row.appId, accountKind: row.accountKind }
  }

  /** A match tag must be a live tag of the account (else 404). */
  private async assertTag(accountId: number, tagId: number | null | undefined): Promise<void> {
    if (tagId == null) return
    const found = await this.txHost.tx.getRepository(WxoaTag).existsBy({ accountId, tagId })
    if (!found) throw new NotFoundException()
  }

  private async delConditional(account: WxoaCaller, menuid: string): Promise<void> {
    try {
      await this.gateway.json(account, '/cgi-bin/menu/delconditional', { body: { menuid } })
    } catch (err) {
      if (errcodeOf(err) !== NO_CONDITIONAL) throw err
    }
  }
}
