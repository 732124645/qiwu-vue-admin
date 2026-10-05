import { expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import BrandMark from '@/core/layout/BrandMark.vue'

it('renders the Nested Tile glyph at both sizes as a decorative theme tile', async () => {
  const mark = mount(BrandMark, { props: { size: 16 } })
  expect(mark.attributes('aria-hidden')).toBe('true')
  expect(mark.attributes('style')).toContain('width: 16px')
  expect(mark.find('svg').attributes('viewBox')).toBe('0 0 24 24')
  expect(mark.find('path').attributes('stroke-width')).toBe('3')
  expect(mark.find('rect').attributes('fill')).toBe('currentColor')

  await mark.setProps({ size: 28 })
  expect(mark.attributes('style')).toContain('width: 28px')
  expect(mark.find('path').attributes('stroke-width')).toBe('2.5')
  expect(mark.find('rect').attributes('width')).toBe('5.5')
})
