import { i18n } from '@/core/i18n'

/**
 * bpmn-js's `translate` service in the app's language: every template string the canvas
 * shows for the element subset (palette, context pad, change-type menu, search) → its `wf.bpmn.*` key, read
 * from vue-i18n at call time. The designer fires `i18n.changed` on a language switch (the palette rebuilds;
 * the context pad and menus read their entries again when opened). An unmapped template (nothing this designer
 * offers) passes through with its `{placeholders}` filled, as bpmn-js's own does. The watermark and its notice
 * never go through `translate` (the license keeps them as they are).
 */
export const TEMPLATES: Record<string, string> = {
  // palette (bpmn-js's tools and start / end; ours in restrict.ts)
  'Activate hand tool': 'tool.hand',
  'Activate lasso tool': 'tool.lasso',
  'Activate create/remove space tool': 'tool.space',
  'Activate global connect tool': 'tool.connect',
  'Create start event': 'create.start',
  'Create end event': 'create.end',
  'Create review': 'create.review',
  'Create carbon copy': 'create.notify',
  'Create exclusive gateway': 'create.exclusive',
  'Create parallel gateway': 'create.parallel',
  'Create inclusive gateway': 'create.inclusive',
  // context pad
  'Append review': 'append.review',
  'Append carbon copy': 'append.notify',
  'Append end event': 'append.end',
  'Insert exclusive branch block': 'block.exclusive',
  'Insert parallel branch block': 'block.parallel',
  'Insert inclusive branch block': 'block.inclusive',
  'Connect to other element': 'edit.connect',
  'Change element': 'edit.change',
  Delete: 'edit.delete',
  'Search in diagram': 'edit.search',
  // change-type menu
  'User task': 'type.review',
  'Send task': 'type.notify',
  'Exclusive gateway': 'type.exclusive',
  'Parallel gateway': 'type.parallel',
  'Inclusive gateway': 'type.inclusive',
  'Sequence flow': 'type.flow',
  'Default flow': 'type.defaultFlow',
}

function translate(template: string, replacements: Record<string, string> = {}) {
  const key = TEMPLATES[template]
  if (key) return i18n.global.t(`wf.bpmn.${key}`, replacements)
  return template.replace(/\{([^}]+)\}/g, (_, name: string) => replacements[name] ?? `{${name}}`)
}

/** the bpmn-js module replacing its `translate` */
export default { translate: ['value', translate] }
