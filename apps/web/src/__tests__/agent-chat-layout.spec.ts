// The chat page layout helpers: saved widths, folding and focus per user in this browser (a broken or
// blocked storage falls back to the defaults), the side panel's upper bound, and a pane splitter dragged
// with the pointer, moved with the arrow keys within its bounds and restored on double-click.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import {
  DEFAULT_LAYOUT,
  loadLayout,
  MAIN_MIN,
  panelMax,
  saveLayout,
  usePaneResize,
  type PaneLimits,
} from '@/views/platform/agent/chat/layout'

const KEY = 'qw.agent.layout.1'

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('saved layout', () => {
  it('saves per user and reads back with defaults; a broken or blocked storage falls back', () => {
    saveLayout(1, { list: 300, panel: 500, listCollapsed: true, focus: true })
    expect(loadLayout(1)).toEqual({ list: 300, panel: 500, listCollapsed: true, focus: true })
    expect(loadLayout(2)).toEqual(DEFAULT_LAYOUT)
    localStorage.setItem(KEY, JSON.stringify({ list: 'wide', panel: 401.6, focus: 1 }))
    expect(loadLayout(1)).toEqual({ ...DEFAULT_LAYOUT, panel: 402 })
    localStorage.setItem(KEY, '{not json')
    expect(loadLayout(1)).toEqual(DEFAULT_LAYOUT)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(loadLayout(1)).toEqual(DEFAULT_LAYOUT)
    expect(() => saveLayout(1, { ...DEFAULT_LAYOUT })).not.toThrow()
  })

  it('caps the panel at 60% of the viewport and keeps the conversation readable', () => {
    expect(panelMax(1920, 0, 0)).toBe(1152)
    expect(panelMax(1920, 1600, 300)).toBe(1600 - 300 - MAIN_MIN)
    // never below its own minimum, however narrow
    expect(panelMax(400, 500, 300)).toBe(320)
  })
})

describe('pane splitter', () => {
  function makePane(start: number, limits: Partial<PaneLimits> = {}) {
    const width = ref(start)
    const scope = effectScope()
    const pane = scope.run(() =>
      usePaneResize(width, { min: 220, max: () => 420, fallback: 260, direction: 1, ...limits }),
    )!
    return { width, pane, scope }
  }
  const key = (key: string, init: KeyboardEventInit = {}) =>
    new KeyboardEvent('keydown', { key, cancelable: true, ...init })
  const pointer = (type: string, clientX: number) =>
    new MouseEvent(type, { clientX, button: 0, cancelable: true }) as PointerEvent

  it('drags within the bounds and stops on release', () => {
    const { width, pane, scope } = makePane(260)
    pane.attrs.value.onPointerdown(pointer('pointerdown', 100))
    expect(pane.dragging.value).toBe(true)
    window.dispatchEvent(pointer('pointermove', 140))
    expect(width.value).toBe(300)
    window.dispatchEvent(pointer('pointermove', 900))
    expect(width.value).toBe(420)
    window.dispatchEvent(pointer('pointermove', -900))
    expect(width.value).toBe(220)
    window.dispatchEvent(pointer('pointerup', 0))
    expect(pane.dragging.value).toBe(false)
    window.dispatchEvent(pointer('pointermove', 200))
    expect(width.value).toBe(220)
    // a right-hand pane grows when its splitter moves left
    const right = pane2()
    right.pane.attrs.value.onPointerdown(pointer('pointerdown', 500))
    window.dispatchEvent(pointer('pointermove', 450))
    expect(right.width.value).toBe(310)
    right.scope.stop()
    // unmounting mid-drag removes the window listeners
    window.dispatchEvent(pointer('pointermove', 300))
    expect(right.width.value).toBe(310)
    scope.stop()
  })
  function pane2() {
    return makePane(260, { direction: -1 })
  }

  it('moves with the arrow keys, Shift for bigger steps, Home and End to the bounds; double-click restores', () => {
    const { width, pane, scope } = makePane(260)
    const e = key('ArrowRight')
    pane.attrs.value.onKeydown(e)
    expect(e.defaultPrevented).toBe(true)
    expect(width.value).toBe(276)
    pane.attrs.value.onKeydown(key('ArrowLeft', { shiftKey: true }))
    expect(width.value).toBe(220)
    pane.attrs.value.onKeydown(key('End'))
    expect(pane.attrs.value['aria-valuenow']).toBe(420)
    pane.attrs.value.onKeydown(key('Home'))
    expect(width.value).toBe(220)
    const other = key('Enter')
    pane.attrs.value.onKeydown(other)
    expect(other.defaultPrevented).toBe(false)
    pane.attrs.value.onDblclick()
    expect(width.value).toBe(260)
    scope.stop()
  })

  it('shows a saved width clamped to the current bounds without rewriting it', () => {
    const max = ref(420)
    const { width, pane, scope } = makePane(400, { max: () => max.value })
    max.value = 330
    expect(pane.value.value).toBe(330)
    expect(pane.attrs.value['aria-valuemax']).toBe(330)
    expect(width.value).toBe(400)
    max.value = 100
    expect(pane.value.value).toBe(220)
    scope.stop()
  })
})
