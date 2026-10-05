// The server's BPMN XML parse, no business tables. `readBpmn` (a
// draft: size, DOCTYPE / ENTITY, strict parse) and `parseBpmn` (a publish: + `bpmnToTree`, `compile`, the
// `incoming` / `outgoing` rebuilt, `toXML`). Every refusal is the 400 at `xml` / `xml.<id>`, never a 500. No
// case calls out: http / https / net / fetch are stubbed and the stubs synced into the ESM named exports
// (`syncBuiltinESMExports`: without it a named import never sees a stub and "0 calls" holds whatever happens),
// with a positive control through a named import.
import { readFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import { bpmnPrecheck, bpmnToTree, WF_BPMN_MODDLE, WF_BPMN_XML_MAX } from '@qiwu/shared'
import { BpmnModdle } from 'bpmn-moddle'
import type { MockInstance } from 'vitest'
import { ValidationException } from '../../src/core/http/validation.pipe.js'
import { parseBpmn, readBpmn } from '../../src/modules/workflow/model/wf-bpmn.js'
import { cfg, fixture, type Fx } from '../fixtures/wf/bpmn-fixture.js'
import { review } from '../fixtures/wf/flow.js'

const moddle = new BpmnModdle({ qw: WF_BPMN_MODDLE })
/** bpmn-moddle's strict parse, as the server's (the warnings returned, a failure thrown) */
const strict = (xml: string) => moddle.fromXML(xml, 'bpmn:Definitions', { lax: false })

const { id: _id, type: _type, name: _name, ...REVIEW } = review('R1')
/** start → review R1 (its name and settings) → end, full DI */
const base = (more: Partial<Fx> = {}) =>
  fixture({
    flows: 'S>R1>E1',
    ...more,
    names: { R1: 'Review', ...more.names },
    inner: { R1: cfg(REVIEW), ...more.inner },
  })
const LEAVE_XML = readFileSync(
  new URL('../fixtures/wf/bpmn-js-leave.bpmn', import.meta.url),
  'utf8',
)

/** the issues of the 400 `p` rejects with (`xml.<id>`, message key) */
async function refusal(p: Promise<unknown>) {
  const err = await p.then(
    () => new Error('accepted'),
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(ValidationException)
  expect((err as ValidationException).getStatus()).toBe(400)
  return (err as ValidationException).issues.map((i) => [i.path.join('.'), i.message])
}
const at = (path: string, code: string) => [[path, `validation.wf.${code}`]]

let spies: MockInstance[] = []
const outbound = () => spies.reduce((n, s) => n + s.mock.calls.length, 0)
/**
 * The positive control: a module Node loads itself, as it loads bpmn-moddle (the test runner turns this
 * file's own named imports into property reads, which see a stub unsynced), imported before the stubs so
 * its `request` is a live ESM binding to the real one, reached by a stub only through the sync.
 */
let native: { call: (url: string) => unknown }
beforeAll(async () => {
  const source = 'import { request } from "node:http"; export const call = (url) => request(url)'
  native = await import(`data:text/javascript,${encodeURIComponent(source)}`)
  const refuse = () => {
    throw new Error('outbound call')
  }
  spies = [
    vi.spyOn(http, 'request').mockImplementation(refuse),
    vi.spyOn(http, 'get').mockImplementation(refuse),
    vi.spyOn(https, 'request').mockImplementation(refuse),
    vi.spyOn(https, 'get').mockImplementation(refuse),
    vi.spyOn(net, 'connect').mockImplementation(refuse),
    vi.spyOn(net, 'createConnection').mockImplementation(refuse),
    vi.spyOn(globalThis, 'fetch').mockImplementation(refuse),
  ]
  syncBuiltinESMExports()
})
afterEach(() => {
  if (outbound()) throw new Error(`${outbound()} outbound call(s)`)
})
afterAll(() => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
})

describe('outbound calls', () => {
  it('positive control: a call through an ESM named import reaches the stub', () => {
    expect(() => native.call('http://127.0.0.1:9/')).toThrow('outbound call')
    // the `http.request` stub itself (unsynced, the real one runs and the `net` stub stops it)
    expect(spies[0]!.mock.calls).toHaveLength(1)
    expect(outbound()).toBe(1)
    for (const s of spies) s.mockClear()
  })
})

describe('parseBpmn: what it takes', () => {
  it('the compiled tree and the normalized XML, which publishes again as it is', async () => {
    const r = await parseBpmn(base(), {})
    expect(r.tree).toMatchObject({ id: 'S', type: 'begin', next: { id: 'R1', ...REVIEW } })
    expect(r.tree.next).not.toHaveProperty('next')
    expect(r.xml).toContain('<bpmn:outgoing>S_R1</bpmn:outgoing>')
    expect(await parseBpmn(r.xml, {})).toEqual(r)
  })

  it('a bpmn-js export: the same diagram without the formatting (bpmn-js writes incoming / outgoing itself)', async () => {
    const r = await parseBpmn(LEAVE_XML, { days: 'number' })
    const compact = (xml: string) => xml.replace(/>\s+</g, '><').trim()
    expect(compact(r.xml)).toBe(compact(LEAVE_XML))
    expect(r.xml.length).toBeLessThan(LEAVE_XML.length)
  })

  it('dangling incoming / outgoing (`__proto__`, prototype names) are rebuilt from the flows', async () => {
    const xml = base({
      inner: {
        S: '<bpmn:outgoing>__proto__</bpmn:outgoing>',
        E1: '<bpmn:incoming>constructor</bpmn:incoming><bpmn:outgoing>toString</bpmn:outgoing>',
      },
    })
    // the strict parse takes them without a warning: they resolve along the prototype chain
    expect((await strict(xml)).warnings).toEqual([])
    const r = await parseBpmn(xml, {})
    expect(r.xml).not.toContain('undefined')
    expect(r.xml).not.toMatch(/__proto__|constructor|toString/)
    expect((await strict(r.xml)).warnings).toEqual([])
    const flows = r.xml.match(/<bpmn:(incoming|outgoing)>[^<]*</g)
    expect(flows).toEqual([
      '<bpmn:outgoing>S_R1<',
      '<bpmn:incoming>S_R1<',
      '<bpmn:outgoing>R1_E1<',
      '<bpmn:incoming>R1_E1<',
    ])
  })

  it('an unprefixed `__proto__` attribute is dropped by the parse and pollutes nothing', async () => {
    const r = await parseBpmn(base({ attrs: { R1: ' __proto__="{&quot;polluted&quot;:1}"' } }), {})
    expect(r.xml).not.toContain('__proto__')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.keys(Object.prototype)).toEqual([])
  })
})

describe('readBpmn / parseBpmn: the 400', () => {
  const doctypes: [string, string][] = [
    ['XXE', '<!DOCTYPE d [<!ENTITY x SYSTEM "http://127.0.0.1:9/x">]>'],
    ['an internal entity', '<!DOCTYPE d [<!ENTITY x "INJECTED">]>'],
    [
      'billion laughs',
      `<!DOCTYPE d [<!ENTITY x0 "lol">${Array.from({ length: 9 }, (_, i) => `<!ENTITY x${i + 1} "${`&x${i};`.repeat(10)}">`).join('')}]>`,
    ],
    ['a lower case doctype', '<!doctype d [<!entity x "INJECTED">]>'],
  ]
  it.each(doctypes)('%s → bpmn_doctype; the parser itself expands nothing', async (_, dtd) => {
    const last = dtd.includes('x9') ? 'x9' : 'x'
    const xml = base({ names: { R1: `&${last};` } }).replace(/^<\?xml[^>]*>/, (d) => d + dtd)
    expect(await refusal(readBpmn(xml))).toEqual(at('xml', 'bpmn_doctype'))
    expect(await refusal(parseBpmn(xml, {}))).toEqual(at('xml', 'bpmn_doctype'))
    // defense in depth, past the precheck: a warning (so `bpmn_parse` anyway), the reference left as text
    const { rootElement, warnings } = await strict(xml)
    expect(warnings.length).toBeGreaterThan(0)
    const [process] = (rootElement as { rootElements: { flowElements: { name?: string }[] }[] })
      .rootElements
    expect(process!.flowElements.map((e) => e.name)).toContain(`&${last};`)
  })

  it('more than WF_BPMN_XML_MAX UTF-8 bytes → bpmn_too_large, before any parse', async () => {
    const xml = base().replace(
      '</bpmn:process>',
      `<!--${'a'.repeat(WF_BPMN_XML_MAX)}--></bpmn:process>`,
    )
    expect(await refusal(readBpmn(xml))).toEqual(at('xml', 'bpmn_too_large'))
  })

  it('a normalized XML over the limit → bpmn_too_large (what is stored must publish again)', async () => {
    // `>` in names: raw in the input, escaped in the output. 72 reviews in 4 parallel blocks of 18 paths (as
    // one chain the tree would nest too deep for compile; with plain names the output stays within the limit)
    const ids = [1, 2, 3, 4].flatMap((b) => Array.from({ length: 18 }, (_, i) => `R${b}x${i}`))
    const name = '>'.repeat(64)
    const xml = fixture({
      flows: [
        'S>P1 PJ1>P2 PJ2>P3 PJ3>P4 PJ4>E1',
        ...ids.map((id) => `P${id[1]}>${id}>PJ${id[1]}`),
      ].join(' '),
      names: Object.fromEntries(ids.map((id) => [id, name])),
      inner: Object.fromEntries(ids.map((id) => [id, cfg(REVIEW)])),
    })
    expect(bpmnPrecheck(xml)).toBeNull()
    // the same diagram with plain names is taken
    await parseBpmn(xml.replaceAll(name, 'Review'), {})
    expect(await refusal(parseBpmn(xml, {}))).toEqual(at('xml', 'bpmn_too_large'))
  })

  it('an unknown BPMN element, a duplicate id or a warning → bpmn_parse', async () => {
    const cases = [
      base({ extra: '<bpmn:fooTask id="F1"/>' }),
      base().replace('<bpmn:endEvent id="E1"', '<bpmn:endEvent id="R1"'),
      base({ attrs: { R1: ' bpmn:__proto__="x"' } }),
      base().replace('<bpmn:definitions', '<bpmn:definitions bpmn:unknown="1"'),
      '',
      'not xml',
    ]
    for (const xml of cases) {
      expect(await refusal(readBpmn(xml))).toEqual(at('xml', 'bpmn_parse'))
      expect(await refusal(parseBpmn(xml, {}))).toEqual(at('xml', 'bpmn_parse'))
    }
  })

  it('a prefix bound to no namespace (`xmlns:p=""`: parsed, not writable back) → bpmn_parse on publish', async () => {
    const xml = base({ attrs: { R1: ' xmlns:p=""' } })
    await readBpmn(xml)
    expect(await refusal(parseBpmn(xml, {}))).toEqual(at('xml', 'bpmn_parse'))
  })

  it('a foreign `__proto__` attribute → bpmn_foreign at its element; no pollution', async () => {
    const xml = base({ attrs: { R1: ' xmlns:x="urn:x" x:__proto__="{&quot;polluted&quot;:1}"' } })
    await readBpmn(xml)
    expect(await refusal(parseBpmn(xml, {}))).toEqual(at('xml.R1', 'bpmn_foreign'))
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('a `bpmn:import` (its location is data, never fetched) → bpmn_unsupported at the definitions', async () => {
    const xml = base({
      root: '<bpmn:import location="http://127.0.0.1:9/x.bpmn" namespace="urn:x" importType="http://www.omg.org/spec/BPMN/20100524/MODEL"/>',
    })
    await readBpmn(xml)
    expect(await refusal(parseBpmn(xml, {}))).toEqual(at('xml.D', 'bpmn_unsupported'))
  })

  it('5000 levels of foreign nesting in extensionElements → bpmn_foreign (400, not a crash)', async () => {
    const deep = `<x:a xmlns:x="urn:x">${'<x:a>'.repeat(5000)}${'</x:a>'.repeat(5001)}`
    const xml = base({
      inner: { R1: cfg(REVIEW).replace('<bpmn:extensionElements>', `$&${deep}`) },
    })
    expect(bpmnPrecheck(xml)).toBeNull()
    await readBpmn(xml)
    expect(await refusal(parseBpmn(xml, {}))).toEqual(at('xml.R1', 'bpmn_foreign'))
  })

  it('converter and compile errors carry the element id; one compile error without an id is at `xml`', async () => {
    expect(await refusal(parseBpmn(fixture({ flows: 'S>T1>E1' }), {}))).toEqual(
      at('xml.T1', 'bpmn_unsupported'),
    )
    // rule ⑫: a condition on a field the form does not have
    const fork = fixture({
      flows: 'S>X1>R1>XJ>E1 X1>XJ',
      default: { X1: 'X1_XJ' },
      names: { R1: 'Review' },
      inner: {
        R1: cfg(REVIEW),
        X1_R1: `<bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" language="qw-rule">[[{"field":"nope","op":"gt","value":1}]]</bpmn:conditionExpression>`,
      },
    })
    const issues = await refusal(parseBpmn(fork, { days: 'number' }))
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.every(([path]) => path === 'xml.X1_R1')).toBe(true)
    // the converter takes it: the error is compile's
    expect(bpmnToTree((await strict(fork)).rootElement).ok).toBe(true)
    // compile's size check names no element: a chain of 100 reviews nests the tree too deep
    const chain = Array.from({ length: 100 }, (_, i) => `R${i}`)
    const deep = fixture({ flows: ['S', ...chain, 'E1'].join('>') })
    expect(await refusal(parseBpmn(deep, {}))).toEqual(at('xml', 'too_large'))
  })
})
