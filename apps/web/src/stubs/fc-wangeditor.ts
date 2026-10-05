// docs/adr/004-form-create.md: stand-in for @form-create/component-wangeditor, whose
// wangeditor@4 is banned. vite.config.ts aliases the module here. Same export
// shape (default component named fcEditor, v-model on modelValue); it only shows the value in a
// disabled textarea. Rich text in forms goes through <RichEditor>.
import { defineComponent, h } from 'vue'

export default defineComponent({
  name: 'fcEditor',
  inheritAttrs: false,
  props: { modelValue: { type: String, default: '' } },
  setup: (props) => () => h('textarea', { value: props.modelValue, disabled: true }),
})
