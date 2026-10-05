// The read-only BPMN diagram's marks: nodes, forks and fork paths as the server's progress
// says (pending: none); a join takes its fork's when done or skipped; any other flow is skipped when one end is,
// done when both are, an end event not counting. Plain objects; the diagram itself runs in Playwright
// (wf-bpmn-canvas.spec.ts, "viewer").
import { describe, expect, it } from 'vitest'
import type { WfNodeProgress } from '@qiwu/shared'
import { progressMarks, type Flow } from '@/views/workflow/bpmn/diagram'

/** `from → to` flows named `f<n>`, besides the fork paths (`[id, from, to]`) */
const line = (steps: string[], paths: [string, string, string][] = []): Flow[] => [
  ...steps.slice(1).map((to, i) => ({ id: `f${i}`, source: steps[i]!, target: to })),
  ...paths.map(([id, source, target]) => ({ id, source, target })),
]
const marks = (
  progress: Record<string, WfNodeProgress>,
  flows: Flow[],
  joins: Record<string, string> = {},
) => Object.fromEntries(progressMarks(progress, joins, flows, new Set(['end'])))

describe('progressMarks', () => {
  // begin → first → route (big: finance | small: –) → j1 → both (left: l | right: r) → j2 → last → end
  const flows: Flow[] = [
    ...line(['begin', 'first', 'route']),
    { id: 'big', source: 'route', target: 'finance' },
    { id: 'small', source: 'route', target: 'j1' },
    { id: 'g1', source: 'finance', target: 'j1' },
    { id: 'g2', source: 'j1', target: 'both' },
    { id: 'left', source: 'both', target: 'l' },
    { id: 'right', source: 'both', target: 'r' },
    { id: 'g3', source: 'l', target: 'j2' },
    { id: 'g4', source: 'r', target: 'j2' },
    { id: 'g5', source: 'j2', target: 'last' },
    { id: 'g6', source: 'last', target: 'end' },
  ]
  const joins = { j1: 'route', j2: 'both' }

  it('a running instance: the path taken lit, the one skipped grey, the rest from its ends', () => {
    const running: Record<string, WfNodeProgress> = {
      begin: 'done',
      first: 'done',
      route: 'done',
      big: 'skipped',
      finance: 'skipped',
      small: 'done',
      both: 'active',
      left: 'done',
      l: 'active',
      right: 'done',
      r: 'done',
      last: 'pending',
    }
    const m = marks(running, flows, joins)
    expect(m).toStrictEqual({
      begin: 'done',
      first: 'done',
      route: 'done',
      big: 'skipped',
      finance: 'skipped',
      small: 'done',
      both: 'active',
      left: 'done',
      l: 'active',
      right: 'done',
      r: 'done',
      // the joins: route's done (both's active: none); the inner flows (none touching an active or pending end)
      j1: 'done',
      f0: 'done',
      f1: 'done',
      g1: 'skipped',
    })
  })

  it('approved: every flow done, the one into the end too; a skipped fork skips its join', () => {
    const all = Object.fromEntries(
      ['begin', 'first', 'route', 'small', 'both', 'left', 'l', 'right', 'r', 'last'].map((id) => [
        id,
        'done' as const,
      ]),
    )
    const m = marks({ ...all, big: 'skipped', finance: 'skipped' }, flows, joins)
    for (const id of ['j1', 'j2', 'g2', 'g3', 'g4', 'g5', 'g6']) expect(m[id]).toBe('done')
    expect(m.g1).toBe('skipped')
    // a fork on a path not taken: its join skipped, so the flow out of it
    expect(marks({ both: 'skipped', last: 'done' }, flows, joins)).toMatchObject({
      j2: 'skipped',
      g5: 'skipped',
    })
  })

  it('stopped and pending ends leave a flow unmarked; begin straight to the end', () => {
    expect(
      marks({ begin: 'done', a: 'stopped', b: 'pending' }, line(['begin', 'a', 'b', 'end'])),
    ).toEqual({
      begin: 'done',
      a: 'stopped',
    })
    expect(marks({ begin: 'done' }, line(['begin', 'end']))).toEqual({ begin: 'done', f0: 'done' })
    // a path still pending: the server's word, not its ends'
    expect(
      marks({ f: 'done', p: 'pending', x: 'done' }, [{ id: 'p', source: 'f', target: 'x' }]),
    ).toEqual({
      f: 'done',
      x: 'done',
    })
  })

  it('an id the diagram lacks comes through (the viewer looks each one up)', () => {
    expect(marks({ ghost: 'active', begin: 'done' }, [])).toEqual({
      ghost: 'active',
      begin: 'done',
    })
  })
})
