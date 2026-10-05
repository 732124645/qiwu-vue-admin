import {
  bpmnPrecheck,
  bpmnToTree,
  compile,
  WF_BPMN_MODDLE,
  type WfBeginNode,
  type WfCompileError,
  type WfFields,
} from '@qiwu/shared'
import { BpmnModdle } from 'bpmn-moddle'
import type { z } from 'zod'
import { ValidationException } from '../../../core/http/validation.pipe.js'

// BPMN XML of a BPMN model: the server derives the tree from the XML, never from the
// client. The parse chain has no network or file access (a `bpmn:import` location is data, refused by the
// subset); moddle's registry is read-only, so one instance serves every request.
const moddle = new BpmnModdle({ qw: WF_BPMN_MODDLE })

type Refusal = Pick<WfCompileError, 'id' | 'message'> & { code: string }

/**
 * The 400 of a BPMN XML: each issue at `xml.<id>`, the element (or flow) the designer marks —
 * rule ⑦ keeps `.` out of ids — or at `xml` without one; text `validation.wf.<code>`, param `node`.
 */
export function invalidXml(errors: Refusal[]): ValidationException {
  const e = new ValidationException(
    errors.map(
      (err) =>
        ({
          code: 'custom',
          path: err.id === null ? ['xml'] : ['xml', err.id],
          message: err.message?.key ?? `validation.wf.${err.code}`,
          params: { ...err.message?.params, node: err.id ?? '' },
          input: undefined,
        }) as z.core.$ZodIssue,
    ),
  )
  e.domain = 'wf.model'
  return e
}
const refused = (code: string) => invalidXml([{ code, id: null }])

/**
 * What a draft gets: at most `WF_BPMN_XML_MAX` UTF-8 bytes and no DOCTYPE / ENTITY
 * (`bpmnPrecheck`), then bpmn-moddle's strict parse — unknown elements and duplicate ids fail it, any warning
 * counts as a failure (400 `bpmn_parse`). The parsed definitions.
 */
export async function readBpmn(xml: string): Promise<unknown> {
  const pre = bpmnPrecheck(xml)
  if (pre) throw refused(pre)
  try {
    const { rootElement, warnings } = await moddle.fromXML(xml, 'bpmn:Definitions', { lax: false })
    if (!warnings.length) return rootElement
  } catch {
    // unreadable whatever the reason: the same 400, never a 500
  }
  throw refused('bpmn_parse')
}

interface FlowElement {
  $type: string
  sourceRef?: FlowElement
  targetRef?: FlowElement
  incoming?: FlowElement[]
  outgoing?: FlowElement[]
}

/**
 * What a publish gets: `readBpmn` → `bpmnToTree` (rules ①–⑪) → `compile(tree, fields)` (rule
 * ⑫) → each node's `incoming` / `outgoing` rebuilt from the flows rule ⑥ checked (the parse resolves a
 * dangling reference such as `__proto__` to whatever the prototype chain holds, without a warning, and
 * `toXML` would write it as `undefined`) → `toXML`: the normalized XML the version and the draft store, with
 * the compiled tree.
 */
export async function parseBpmn(
  xml: string,
  fields: WfFields,
): Promise<{ tree: WfBeginNode; xml: string }> {
  const definitions = await readBpmn(xml)
  const r = bpmnToTree(definitions)
  if (!r.ok) throw invalidXml(r.errors)
  const c = compile(r.tree, fields)
  if (!c.ok) throw invalidXml(c.errors)
  // rule ① took exactly one process, rule ⑥ only flows between two of its nodes
  const [process] = (definitions as { rootElements: { flowElements: FlowElement[] }[] })
    .rootElements
  const flows = process!.flowElements.filter((e) => e.$type === 'bpmn:SequenceFlow')
  for (const el of process!.flowElements)
    if (el.$type !== 'bpmn:SequenceFlow') {
      el.incoming = flows.filter((f) => f.targetRef === el)
      el.outgoing = flows.filter((f) => f.sourceRef === el)
    }
  // unformatted: never larger for formatting (a bpmn-js `saveXML({ format: true })` shrinks)
  // a declaration the parse takes but the writer cannot write back (`xmlns:p=""`): a 400, never a 500
  const { xml: normalized } = await moddle.toXML(definitions).catch(() => {
    throw refused('bpmn_parse')
  })
  // escapes and the rebuilt references may still grow it: what is stored must publish again
  const again = bpmnPrecheck(normalized)
  if (again) throw refused(again)
  return { tree: c.flow.root, xml: normalized }
}
