import {
  utf8Bytes,
  WXOA_BUTTON_FIELDS,
  WXOA_LEGACY_BUTTON_KINDS,
  WXOA_MENU_LIMITS,
  type WxoaButton,
  type WxoaButtonKind,
} from '@qiwu/shared'

/**
 * The button tree of the menu editor (see docs/design-notes.md#wxoa): at most 3 buttons, each a leaf with
 * a kind or a parent of 1–5 sub-buttons. A draft keeps every field it was given, so switching the kind
 * back or removing the last sub-button brings the old values back; `toButtons` sends only the fields the
 * kind takes. Retired kinds (pulled from WeChat) are kept or removed, never changed or added.
 */
export interface DraftButton {
  name: string
  kind?: WxoaButtonKind
  key?: string
  url?: string
  appId?: string
  pagePath?: string
  articleId?: string
  mediaId?: string
  subButtons?: DraftButton[]
}

/** A button's place: `i` the top-level index, `j` the sub-button index under it. */
export interface Slot {
  i: number
  j?: number
}

const LEGACY: readonly string[] = WXOA_LEGACY_BUTTON_KINDS

export const isLegacy = (b: { kind?: string }) => b.kind !== undefined && LEGACY.includes(b.kind)
export const isParent = (b: DraftButton) => b.subButtons !== undefined

export const buttonAt = (buttons: DraftButton[], { i, j }: Slot): DraftButton | undefined =>
  j === undefined ? buttons[i] : buttons[i]?.subButtons?.[j]

export const sameSlot = (a: Slot | null, b: Slot | null) => a?.i === b?.i && a?.j === b?.j

/** UTF-8 bytes of a name as the server counts them (trimmed), and the limit of its level. */
export const nameBytes = (b: DraftButton) => utf8Bytes(b.name.trim())
export const nameLimit = ({ j }: Slot) =>
  j === undefined ? WXOA_MENU_LIMITS.nameBytes : WXOA_MENU_LIMITS.subNameBytes

export const canAddTop = (buttons: DraftButton[]) => buttons.length < WXOA_MENU_LIMITS.buttons
/** a retired-kind leaf takes no sub-buttons: that would change it */
export const canAddSub = (b: DraftButton) =>
  !isLegacy(b) && (b.subButtons?.length ?? 0) < WXOA_MENU_LIMITS.subButtons

const newButton = (): DraftButton => ({ name: '', kind: 'click' })

export function addTop(buttons: DraftButton[]): Slot | null {
  if (!canAddTop(buttons)) return null
  buttons.push(newButton())
  return { i: buttons.length - 1 }
}

/** The first sub-button turns the button into a parent (its own kind and fields are kept, not sent). */
export function addSub(buttons: DraftButton[], i: number): Slot | null {
  const parent = buttons[i]
  if (!parent || !canAddSub(parent)) return null
  const subs = (parent.subButtons ??= [])
  subs.push(newButton())
  return { i, j: subs.length - 1 }
}

/** Removes the button; the slot to select next (null: no button left). */
export function removeAt(buttons: DraftButton[], { i, j }: Slot): Slot | null {
  if (j === undefined) {
    buttons.splice(i, 1)
    return buttons.length ? { i: Math.min(i, buttons.length - 1) } : null
  }
  const parent = buttons[i]!
  const subs = parent.subButtons!
  subs.splice(j, 1)
  if (subs.length) return { i, j: Math.min(j, subs.length - 1) }
  // the last one gone: a leaf again
  delete parent.subButtons
  parent.kind ??= 'click'
  return { i }
}

/** Moves the button one place among its siblings (-1 earlier, 1 later); its slot afterwards. */
export function moveBy(buttons: DraftButton[], slot: Slot, delta: -1 | 1): Slot {
  const list = slot.j === undefined ? buttons : buttons[slot.i]!.subButtons!
  const from = slot.j ?? slot.i
  const to = from + delta
  if (to < 0 || to >= list.length) return slot
  list.splice(to, 0, ...list.splice(from, 1))
  return slot.j === undefined ? { i: to } : { i: slot.i, j: to }
}

export const canMove = (buttons: DraftButton[], slot: Slot, delta: -1 | 1) => {
  const size = slot.j === undefined ? buttons.length : (buttons[slot.i]?.subButtons?.length ?? 0)
  const to = (slot.j ?? slot.i) + delta
  return to >= 0 && to < size
}

function leaf(b: DraftButton): Record<string, unknown> {
  const out: Record<string, unknown> = { name: b.name }
  if (!b.kind) return out
  out.kind = b.kind
  for (const prop of WXOA_BUTTON_FIELDS[b.kind]) if (b[prop]) out[prop] = b[prop]
  return out
}

/** The request's `buttons`: a parent as name + sub-buttons, a leaf with only its kind's fields set. */
export function toButtons(buttons: DraftButton[]): WxoaButton[] {
  return buttons.map((b) =>
    isParent(b) ? { name: b.name, subButtons: b.subButtons!.map(leaf) } : leaf(b),
  ) as WxoaButton[]
}

/** An editable copy of stored buttons (also of a reactive one). */
export const toDraft = (buttons: readonly WxoaButton[]): DraftButton[] =>
  JSON.parse(JSON.stringify(buttons)) as DraftButton[]

/** The button an issue path (`buttons.<i>[.subButtons.<j>].<prop>`) points at, and the prop. */
export function issueSlot(path: readonly PropertyKey[]): { slot: Slot; prop?: string } | null {
  if (path[0] !== 'buttons' || typeof path[1] !== 'number') return null
  if (path[2] === 'subButtons' && typeof path[3] === 'number')
    return { slot: { i: path[1], j: path[3] }, prop: path[4] as string | undefined }
  return { slot: { i: path[1] }, prop: path[2] as string | undefined }
}
