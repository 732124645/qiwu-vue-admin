// The part of bpmn-moddle 10 the BPMN notation uses: its root entry ships no types.
declare module 'bpmn-moddle' {
  export class BpmnModdle {
    constructor(packages?: Record<string, unknown>)
    fromXML(
      xml: string,
      type: string,
      options?: { lax?: boolean },
    ): Promise<{ rootElement: unknown; warnings: { message: string }[] }>
    toXML(element: unknown, options?: { format?: boolean }): Promise<{ xml: string }>
  }
}
