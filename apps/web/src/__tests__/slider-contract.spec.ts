// Captcha contract check: the shared slider payload must render and return usable coordinates.
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { Slide } from 'go-captcha-vue'
import type { SlideData, SlidePoint } from 'go-captcha-vue/dist/components/slide/meta/data.d.ts'
import { captchaCheckBody, type CaptchaChallengeVo } from '@qiwu/shared'

type SliderPayload = Omit<Extract<CaptchaChallengeVo, { kind: 'slider' }>, 'kind' | 'id'>
type Assert<T extends true> = T
type ContractFits = Assert<SliderPayload extends SlideData ? true : false>
const payload = {
  image: 'data:image/png;base64,YmFja2dyb3VuZA==',
  thumb: 'data:image/png;base64,dGlsZQ==',
  thumbX: 14,
  thumbY: 37,
  thumbWidth: 44,
  thumbHeight: 46,
} satisfies SliderPayload
const contractFits: ContractFits = true

const size = (element: Element, width: number, left = 0) => {
  Object.defineProperties(element, {
    offsetWidth: { configurable: true, value: width },
    offsetLeft: { configurable: true, value: left },
  })
}

describe('go-captcha-vue Slide contract', () => {
  it('renders all image geometry, emits an integer point, and resets the tile', async () => {
    expect(contractFits).toBe(true)
    let reset: (() => void) | undefined
    const confirm = vi.fn<(point: SlidePoint, callback: () => void) => void>((_, callback) => {
      reset = callback
    })
    const wrapper = mount(Slide, {
      props: {
        data: payload,
        config: { width: 300, height: 220, title: 'Drag the tile' },
        events: { confirm },
      },
      attachTo: document.body,
    })
    expect(wrapper.find('.gc-header span').text()).toBe('Drag the tile')
    expect(wrapper.find<HTMLImageElement>('.gc-picture').element.src).toBe(payload.image)
    expect(wrapper.find<HTMLImageElement>('.gc-tile img').element.src).toBe(payload.thumb)
    const tile = wrapper.find<HTMLElement>('.gc-tile')
    expect(tile.attributes('style')).toContain(`width: ${payload.thumbWidth}px`)
    expect(tile.attributes('style')).toContain(`height: ${payload.thumbHeight}px`)
    expect(tile.attributes('style')).toContain(`top: ${payload.thumbY}px`)
    expect(tile.attributes('style')).toContain(`left: ${payload.thumbX}px`)

    const root = wrapper.find('.go-captcha')
    const block = wrapper.find('.gc-drag-block')
    size(wrapper.find('.gc-body').element, 300)
    size(block.element, 40, 0)
    size(tile.element, payload.thumbWidth, payload.thumbX)
    await block.trigger('mousedown', { clientX: 10 })
    // happy-dom exposes cancelBubble as getter-only; the library assigns it during dragging.
    for (const type of ['mousemove', 'mouseup']) {
      const event = new MouseEvent(type, { bubbles: true, clientX: 110 })
      Object.defineProperty(event, 'cancelBubble', {
        configurable: true,
        writable: true,
        value: false,
      })
      root.element.dispatchEvent(event)
    }
    await nextTick()
    // Library formula: tile start + drag distance * (body width - tile width - tile start) / (body width - block width).
    const expectedX = Math.trunc(
      payload.thumbX + (100 * (300 - payload.thumbWidth - payload.thumbX)) / (300 - 40),
    )
    expect(confirm).toHaveBeenCalledTimes(1)
    const point = confirm.mock.calls[0]![0]
    expect(point).toEqual({ x: expectedX, y: payload.thumbY })
    expect(captchaCheckBody.safeParse({ id: '0123456789abcdef', answer: point }).success).toBe(true)
    reset?.()
    await nextTick()
    expect(tile.attributes('style')).toContain(`left: ${payload.thumbX}px`)
    wrapper.unmount()
  })
})
