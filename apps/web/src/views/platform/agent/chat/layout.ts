import { computed, onScopeDispose, ref, type Ref } from 'vue'

/**
 * Layout of the chat page, per user and per browser (localStorage): the widths of the conversation list and
 * the side panel, whether the list is folded into its rail, and the focus mode.
 */
export interface ChatLayout {
  list: number
  panel: number
  listCollapsed: boolean
  focus: boolean
}

export const LIST_WIDTH = { min: 220, max: 420, fallback: 260 } as const
/** the panel's upper bound is a share of the viewport, see `panelMax` */
export const PANEL_WIDTH = { min: 320, fallback: 380, viewportShare: 0.6 } as const
/** the conversation column never shrinks below this while panes are dragged wider */
export const MAIN_MIN = 520

export const DEFAULT_LAYOUT: Readonly<ChatLayout> = {
  list: LIST_WIDTH.fallback,
  panel: PANEL_WIDTH.fallback,
  listCollapsed: false,
  focus: false,
}

const storageKey = (userId: number) => `qw.agent.layout.${userId}`

/** 读本人在本浏览器保存的布局；没有、损坏或存储不可用时用默认值，逐项校验补齐。 */
export function loadLayout(userId: number): ChatLayout {
  const out = { ...DEFAULT_LAYOUT }
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(userId)) ?? 'null') as unknown
    if (saved && typeof saved === 'object') {
      const s = saved as Record<string, unknown>
      for (const k of ['list', 'panel'] as const) {
        const v = s[k]
        if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.round(v)
      }
      for (const k of ['listCollapsed', 'focus'] as const)
        if (typeof s[k] === 'boolean') out[k] = s[k]
    }
  } catch {
    // 隐私模式或被禁用的存储：用默认值
  }
  return out
}

/** 保存布局；存储不可用时只在本次页面里生效。 */
export function saveLayout(userId: number, layout: ChatLayout): void {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(layout))
  } catch {
    // 同上：写不进去就不保存
  }
}

/**
 * 右侧面板的最大宽度：不超过视口的 60%，也不把对话区挤到 `MAIN_MIN` 以下；两者都小于最小宽度时取最小宽度。
 * `others` 是同一行里其他固定宽度（会话列表或收起的窄条、分隔线）的总和。
 */
export function panelMax(viewport: number, host: number, others: number): number {
  const byViewport = viewport * PANEL_WIDTH.viewportShare
  const byHost = host > 0 ? host - others - MAIN_MIN : byViewport
  return Math.max(PANEL_WIDTH.min, Math.floor(Math.min(byViewport, byHost)))
}

export interface PaneLimits {
  min: number
  max: () => number
  /** 双击分隔线恢复的默认宽度 */
  fallback: number
  /**
   * 分隔线右移时宽度的变化方向：1 为分隔线左侧的窗格（会话列表），-1 为右侧的窗格（右侧面板）
   */
  direction: 1 | -1
  /** 方向键每次调整的像素，按住 Shift 为 4 倍 */
  step?: number
}

/**
 * 可拖动 / 键盘调宽的分隔线：拖动时按指针位移改宽，聚焦后左右方向键微调，Home / End 到最小 / 最大，
 * 双击恢复默认宽度。实际显示的宽度总是夹在当前上下限内（视口变窄时随之收窄，不改写已保存的宽度）。
 * 返回值 `attrs` 直接 `v-bind` 到分隔线元素上（`role="separator"` 与 `aria-value*`）。
 */
export function usePaneResize(width: Ref<number>, limits: PaneLimits) {
  const step = limits.step ?? 16
  const clamp = (v: number) =>
    Math.round(Math.min(Math.max(v, limits.min), Math.max(limits.min, limits.max())))
  const value = computed(() => clamp(width.value))
  const dragging = ref(false)
  let stopDrag: (() => void) | null = null

  /** 拖动：记住起点，之后每次指针移动按位移设宽；松开或取消时收尾。 */
  function onPointerdown(e: PointerEvent) {
    if (e.button !== 0) return
    e.preventDefault()
    stopDrag?.()
    const startX = e.clientX
    const start = value.value
    dragging.value = true
    const move = (ev: PointerEvent) => {
      width.value = clamp(start + limits.direction * (ev.clientX - startX))
    }
    const stop = () => {
      dragging.value = false
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      stopDrag = null
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    stopDrag = stop
  }

  /** 键盘：←/→ 按分隔线移动方向调宽，Home / End 到上下限；其他键不处理。 */
  function onKeydown(e: KeyboardEvent) {
    let next: number
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const towardRight = e.key === 'ArrowRight' ? 1 : -1
      next = value.value + towardRight * limits.direction * step * (e.shiftKey ? 4 : 1)
    } else if (e.key === 'Home') next = limits.min
    else if (e.key === 'End') next = limits.max()
    else return
    e.preventDefault()
    width.value = clamp(next)
  }

  function reset() {
    width.value = clamp(limits.fallback)
  }

  // 拖动中卸载页面时也要移除窗口上的监听
  onScopeDispose(() => stopDrag?.())

  const attrs = computed(() => ({
    role: 'separator',
    tabindex: 0,
    'aria-orientation': 'vertical' as const,
    'aria-valuenow': value.value,
    'aria-valuemin': limits.min,
    'aria-valuemax': Math.max(limits.min, Math.round(limits.max())),
    onPointerdown,
    onKeydown,
    onDblclick: reset,
  }))
  return { value, dragging, attrs, reset }
}
