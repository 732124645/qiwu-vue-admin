import {
  getCurrentInstance,
  onActivated,
  onDeactivated,
  onScopeDispose,
  shallowRef,
  toValue,
  type MaybeRefOrGetter,
} from 'vue'
import type { AgentContext } from '@qiwu/shared'

interface Published {
  target: string
  ids: MaybeRefOrGetter<number[]>
}

/** 当前页面公布的选中记录（同一时刻只有屏幕上的那一页）。 */
const published = shallowRef<Published | null>(null)

/** 入口按钮带过来、对话页还没取走的上下文。 */
export const pendingContext = shallowRef<AgentContext | null>(null)
/** 入口按钮所在页面的路由名：对话页据此取适合那个页面的开场提示。 */
export const pendingRoute = shallowRef<string | null>(null)

/**
 * 列表页调用它公布选中的记录（如 `useAgentContext('demo.customer', () => selection.value.map((r) => r.id))`），
 * 右下角的“智能助手”入口跳转时把页面与这些 id 一起带给智能体。页面隐藏（keep-alive）或卸载时自动撤下。
 */
export function useAgentContext(target: string, ids: MaybeRefOrGetter<number[]>): void {
  const entry: Published = { target, ids }
  const on = () => void (published.value = entry)
  const off = () => {
    if (published.value === entry) published.value = null
  }
  on()
  if (getCurrentInstance()) {
    onActivated(on)
    onDeactivated(off)
  }
  onScopeDispose(off)
}

/** 入口按钮点击时的上下文：页面路径、标题，以及该页公布的选中记录（最多 200 条，契约上限）。 */
export function currentAgentContext(route: string, title: string): AgentContext {
  const ctx: AgentContext = { route: route.slice(0, 200) }
  if (title) ctx.title = title.slice(0, 200)
  const p = published.value
  const ids = p ? toValue(p.ids).slice(0, 200) : []
  if (p && ids.length) Object.assign(ctx, { target: p.target, ids })
  return ctx
}
