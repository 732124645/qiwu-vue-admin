// The role grant tree: link on saves checked + half-checked and echoes leaves; a granted
// parent none of whose descendants is granted echoes half-checked, so a save keeps it without its subtree.
import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { i18n } from '@/core/i18n'
import GrantTree from '@/views/platform/iam/role/grant-tree.vue'

interface Node {
  id: number
  children: Node[]
}
const n = (id: number, children: Node[] = []): Node => ({ id, children })
// 1 > (2 > (3, 4), 5); 6
const DATA = [n(1, [n(2, [n(3), n(4)]), n(5)]), n(6)]

async function grantTree(stored: number[], link: boolean) {
  const wrapper = mount(GrantTree, {
    props: {
      data: DATA,
      stored,
      label: ((x: Node) => `node ${x.id}`) as never,
      treeLabel: 'grants',
      link,
      'onUpdate:link': (on: boolean) => void wrapper.setProps({ link: on }),
    },
    global: { plugins: [ElementPlus, i18n] },
  })
  await flushPromises()
  const picked = () =>
    (wrapper.vm as unknown as { picked(): number[] }).picked().sort((a, b) => a - b)
  return { wrapper, picked }
}

describe('grant tree', () => {
  it('link on: stored leaves echo with their parents derived; a granted parent without granted descendants stays (half-checked)', async () => {
    const { picked } = await grantTree([1, 2, 3], true)
    expect(picked()).toEqual([1, 2, 3])
    // only the parent granted (children added after the grant): kept, its subtree not taken
    const lone = await grantTree([1, 2], true)
    expect(lone.picked()).toEqual([1, 2])
  })

  it('only the parent granted, switch linking on, save → the grant is kept as it was', async () => {
    const { wrapper, picked } = await grantTree([2], false)
    expect(picked()).toEqual([2])
    await wrapper.find('.el-switch').trigger('click')
    await flushPromises()
    expect(wrapper.props('link')).toBe(true)
    // the parent kept (its ancestor half-checked, as link on saves it), its children not added
    expect(picked()).toEqual([1, 2])
    // and back off: exactly what link on would save
    await wrapper.find('.el-switch').trigger('click')
    await flushPromises()
    expect(picked()).toEqual([1, 2])
  })
})
