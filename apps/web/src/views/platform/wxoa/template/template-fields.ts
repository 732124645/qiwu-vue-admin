/** a data key of the template text: `{{thing3.DATA}}` (the server reads the keys the same way) */
const PLACEHOLDER = /\{\{\s*([A-Za-z_]\w*)\.DATA\s*\}\}/g

export interface WxoaTemplateField {
  key: string
  /** the text before the placeholder on its line (`Shipped at: {{time3.DATA}}` → `Shipped at`), else the key */
  label: string
}

/** The data fields of a template's text, in order, each key once. */
export function wxoaTemplateFields(content: string): WxoaTemplateField[] {
  const fields = new Map<string, WxoaTemplateField>()
  for (const line of content.split('\n')) {
    let from = 0
    for (const m of line.matchAll(PLACEHOLDER)) {
      const key = m[1]!
      const label = line
        .slice(from, m.index)
        // a trailing colon, ASCII or full-width
        .replace(/[\s:\uFF1A]+$/u, '')
        .trim()
      from = m.index + m[0].length
      if (!fields.has(key)) fields.set(key, { key, label: label || key })
    }
  }
  return [...fields.values()]
}
