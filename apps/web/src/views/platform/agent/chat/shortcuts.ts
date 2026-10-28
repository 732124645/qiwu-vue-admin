/**
 * Keyboard shortcuts of the chat page, per user and per browser (localStorage). A combo is the held
 * modifiers and the physical key, `Alt+KeyN`: on a Mac ⌥ changes `e.key`, never `e.code`.
 */
export const SHORTCUT_ACTIONS = ['newChat', 'focusComposer', 'stop', 'togglePlan', 'queue'] as const
export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number]
/** 每个动作的组合；空串表示这个动作没有快捷键 */
export type Shortcuts = Record<ShortcutAction, string>

/**
 * `stop` (the draft stays) and `queue` (send for the next turn) work in the message box while a turn runs;
 * the others page-wide.
 */
export const DEFAULT_SHORTCUTS: Readonly<Shortcuts> = {
  newChat: 'Alt+KeyN',
  focusComposer: 'Alt+KeyI',
  stop: 'Escape',
  togglePlan: 'Alt+KeyP',
  queue: 'Alt+Enter',
}

const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const
const MODIFIER_CODES = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/
/**
 * combos the page, the app, the browser or editing already uses: the menu search, the message box's own keys,
 * copy / paste / undo, and the browser's new window / new tab / close tab (pages never receive those)
 */
const RESERVED = new Set([
  'Ctrl+KeyK',
  'Meta+KeyK',
  'Ctrl+KeyR',
  'Enter',
  'Shift+Enter',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  ...['C', 'V', 'X', 'Z', 'Y', 'A', 'N', 'T', 'W'].flatMap((k) => [`Ctrl+Key${k}`, `Meta+Key${k}`]),
  'Ctrl+Shift+KeyZ',
  'Shift+Meta+KeyZ',
])

/**
 * 按下的组合：修饰键 + 物理键；只按了修饰键（或输入法组字中）时为 null。没有物理键码的合成事件
 * 退回 `e.key`（Escape、Enter 等命名键两者相同）。
 */
export function comboOf(e: KeyboardEvent): string | null {
  const code = e.code || e.key
  if (e.isComposing || !code || MODIFIER_CODES.test(code)) return null
  const held = { Ctrl: e.ctrlKey, Alt: e.altKey, Shift: e.shiftKey, Meta: e.metaKey }
  return [...MODIFIERS.filter((m) => held[m]), code].join('+')
}

/** 给人看的写法：`Alt+KeyN` → `Alt+N`，`Digit1` → `1`，`Escape` → `Esc`，Mac 上 Meta 写成 ⌘。 */
export function comboLabel(combo: string): string {
  return combo
    .split('+')
    .map((p) => (p === 'Meta' ? '⌘' : p === 'Escape' ? 'Esc' : p.replace(/^(Key|Digit)/, '')))
    .join('+')
}

/**
 * 把 `action` 设成 `combo` 是否冲突：`reserved`（页面或编辑已占用）、`modifier`（必须带 Ctrl、Alt 或 ⌘，
 * 否则打字时会误触；只有停止还可以用单独的 Esc）、另一个动作的名字（已被它使用），不冲突为 null。
 */
export function conflictOf(
  map: Shortcuts,
  action: ShortcutAction,
  combo: string,
): 'reserved' | 'modifier' | ShortcutAction | null {
  if (RESERVED.has(combo)) return 'reserved'
  const plainEscape = action === 'stop' && combo === 'Escape'
  if (!plainEscape && !/(^|\+)(Ctrl|Alt|Meta)\+/.test(combo)) return 'modifier'
  return SHORTCUT_ACTIONS.find((a) => a !== action && map[a] === combo) ?? null
}

const storageKey = (userId: number) => `qw.agent.shortcuts.${userId}`

/**
 * 读本人在本浏览器保存的快捷键；没有、损坏或存储不可用时用默认值，逐项补齐。补上的默认值（如后来新增的动作）
 * 已被本人给另一个动作用了时留空（空串即没有快捷键，可在设置里再录），不让同一组合同时触发两个动作。
 */
export function loadShortcuts(userId: number): Shortcuts {
  const out = { ...DEFAULT_SHORTCUTS }
  const own = new Set<ShortcutAction>()
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(userId)) ?? 'null') as unknown
    if (saved && typeof saved === 'object')
      for (const a of SHORTCUT_ACTIONS) {
        const v = (saved as Record<string, unknown>)[a]
        if (typeof v === 'string' && v.length <= 64) {
          out[a] = v
          own.add(a)
        }
      }
  } catch {
    // 隐私模式或被禁用的存储：用默认值
  }
  for (const a of SHORTCUT_ACTIONS)
    if (!own.has(a) && [...own].some((b) => out[b] === out[a])) out[a] = ''
  return out
}

/** 保存快捷键；存储不可用时只在本次页面里生效。 */
export function saveShortcuts(userId: number, map: Shortcuts): void {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(map))
  } catch {
    // 同上：写不进去就不保存
  }
}
