import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import HtmlFrame from '@/core/components/HtmlFrame.vue'

describe('HtmlFrame', () => {
  it('keeps untrusted HTML inside a fully sandboxed srcdoc iframe', () => {
    const html = '<script>window.parent.bad = true</script><img src="x" onerror="alert(1)">'
    const wrapper = mount(HtmlFrame, { props: { html, title: 'Mail preview' } })
    const frame = wrapper.find('iframe')
    expect(frame.exists()).toBe(true)
    expect(frame.attributes()).toHaveProperty('sandbox', '')
    expect(frame.attributes('srcdoc')).toBe(html)
    expect(frame.attributes('referrerpolicy')).toBe('no-referrer')
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.find('img').exists()).toBe(false)
  })
})
