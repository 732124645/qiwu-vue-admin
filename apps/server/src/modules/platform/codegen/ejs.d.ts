// The part of ejs 6 (no bundled types; @types/ejs describes 3.x) the generator uses.
declare module 'ejs' {
  interface Options {
    filename?: string
    strict?: boolean
    localsName?: string
    destructuredLocals?: string[]
    escape?: (value: unknown) => string
  }
  const ejs: {
    render(template: string, data: Record<string, unknown>, options: Options): string
  }
  export default ejs
}
