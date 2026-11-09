interface MediaButtonKey {
  key?: string
  repeat?: boolean
  defaultPrevented?: boolean
  preventDefault?(): void
}

/** uni-button 的 H5 宿主没有浏览器按钮默认动作；键盘复用原点击动作及其禁用、单飞检查。 */
export function activateImMediaButton(
  event: MediaButtonKey,
  disabled: boolean,
  action: () => unknown,
): unknown {
  if (event.defaultPrevented || (event.key !== 'Enter' && event.key !== ' ')) return
  event.preventDefault?.()
  if (disabled || event.repeat) return
  return action()
}
