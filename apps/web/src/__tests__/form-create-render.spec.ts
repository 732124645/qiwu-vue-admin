import { describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import formCreate from '@form-create/element-ui'
import FcDesigner from '@form-create/designer'
import FcEditorStub from '@/stubs/fc-wangeditor'

describe('form-create designer without wangeditor', () => {
  it('uses the local stub as its rich-text component', () => {
    // The designer's dist inlines its own wangeditor copy, so identity with the stub proves both
    // aliases (designer -> source, component-wangeditor -> stub) are in effect.
    expect(formCreate.component('FcEditor')).toBe(FcEditorStub)
  })

  it('renders the component panel', async () => {
    const wrapper = mount(FcDesigner, { global: { plugins: [ElementPlus, formCreate] } })
    await flushPromises()
    expect(wrapper.find('._fc-l-menu').exists()).toBe(true)
    expect(wrapper.findAll('._fc-l-item').length).toBeGreaterThan(10)
    wrapper.unmount()
  })
})
