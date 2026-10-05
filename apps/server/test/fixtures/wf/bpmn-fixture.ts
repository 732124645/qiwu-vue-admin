// BPMN fixtures for the specs: a diagram from chains of element ids, each element drawn with a
// shape / edge (nodes in a row, flows corner to corner), so it passes rule ⑬ unless a case says otherwise.

export const NS = [
  'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"',
  'xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"',
  'xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"',
  'xmlns:di="http://www.omg.org/spec/DD/20100524/DI"',
  'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
  'xmlns:color="http://www.omg.org/spec/BPMN/non-normative/color/1.0"',
  'xmlns:bioc="http://bpmn.io/schema/bpmn/biocolor/1.0"',
  'xmlns:qw="urn:qiwu:bpmn:1"',
].join(' ')
/** An element's tag by the first letter of its id. */
const TAG: Record<string, string> = {
  S: 'startEvent',
  E: 'endEvent',
  R: 'userTask',
  C: 'sendTask',
  X: 'exclusiveGateway',
  P: 'parallelGateway',
  I: 'inclusiveGateway',
  T: 'scriptTask',
  B: 'boundaryEvent',
}
export interface Fx {
  /** chains `S>R1>E1`, space separated; flow id `<from>_<to>` (a repeated pair gets a trailing `_`) */
  flows: string
  /** per element or flow id */
  names?: Record<string, string>
  attrs?: Record<string, string>
  inner?: Record<string, string>
  /** gateway id → its default flow id */
  default?: Record<string, string>
  /** XML before the process / inside it after the flows / on the process tag */
  root?: string
  extra?: string
  process?: string
  /** elements and flows drawn without DI; attributes on an element's DI; raw DI after the generated */
  noDi?: string[]
  diAttrs?: Record<string, string>
  diExtra?: string
}
export function fixture(fx: Fx): string {
  const nodes: string[] = []
  const flows: [string, string, string][] = []
  for (const chain of fx.flows.trim().split(/\s+/)) {
    const ids = chain.split('>')
    ids.forEach((id, i) => {
      if (!nodes.includes(id)) nodes.push(id)
      if (!i) return
      let flow = `${ids[i - 1]}_${id}`
      while (flows.some(([f]) => f === flow)) flow += '_'
      flows.push([flow, ids[i - 1], id])
    })
  }
  const named = (id: string) => (fx.names?.[id] ? ` name="${fx.names[id]}"` : '')
  const more = (id: string) =>
    `${fx.attrs?.[id] ?? ''}${fx.default?.[id] ? ` default="${fx.default[id]}"` : ''}`
  const element = (id: string) => {
    const tag = `bpmn:${TAG[id[0]]}`
    return `<${tag} id="${id}"${named(id)}${more(id)}>${fx.inner?.[id] ?? ''}</${tag}>`
  }
  const flow = ([id, from, to]: [string, string, string]) =>
    `<bpmn:sequenceFlow id="${id}"${named(id)} sourceRef="${from}" targetRef="${to}"${more(id)}>${fx.inner?.[id] ?? ''}</bpmn:sequenceFlow>`
  const drawn = (id: string) => !fx.noDi?.includes(id)
  // a node per 100 px in a row (36 × 36 at x = 100 · its index), a flow from its source's corner to its target's:
  // straight to the next node, else over the row (y -9), clear of the nodes between
  const x = (id: string) => 100 * nodes.indexOf(id)
  const shape = (id: string) =>
    `<bpmndi:BPMNShape id="${id}_di" bpmnElement="${id}"${fx.diAttrs?.[id] ?? ''}><dc:Bounds x="${x(id)}" y="0" width="36" height="36"/></bpmndi:BPMNShape>`
  const point = (x: number, y = 0) => `<di:waypoint x="${x}" y="${y}"/>`
  const edge = ([id, from, to]: [string, string, string]) => {
    const [a, b] = [x(from), x(to)]
    const over = b - a === 100 ? '' : point(a, -9) + point(b, -9)
    return `<bpmndi:BPMNEdge id="${id}_di" bpmnElement="${id}"${fx.diAttrs?.[id] ?? ''}>${point(a)}${over}${point(b)}</bpmndi:BPMNEdge>`
  }
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<bpmn:definitions ${NS} id="D" targetNamespace="urn:test">${fx.root ?? ''}`,
    `<bpmn:process id="P"${fx.process ?? ''}>`,
    ...nodes.map(element),
    ...flows.map(flow),
    fx.extra ?? '',
    `</bpmn:process>`,
    `<bpmndi:BPMNDiagram id="DG"><bpmndi:BPMNPlane id="PL" bpmnElement="P">`,
    ...nodes.filter(drawn).map(shape),
    ...flows.filter(([id]) => drawn(id)).map(edge),
    fx.diExtra ?? '',
    `</bpmndi:BPMNPlane></bpmndi:BPMNDiagram></bpmn:definitions>`,
  ].join('\n')
}

/** `qw:Config` elements (a body object as JSON, a string as it is) in an `extensionElements`. */
export const text = (body: unknown) => (typeof body === 'string' ? body : JSON.stringify(body))
export const cfg = (...bodies: unknown[]) =>
  `<bpmn:extensionElements>${bodies.map((b) => `<qw:Config>${text(b)}</qw:Config>`).join('')}</bpmn:extensionElements>`
