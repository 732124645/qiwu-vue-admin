/** Elements whose text stands apart from the next one's (`<p>a</p><p>b</p>` → `a b`). */
const BLOCKS = 'br, p, div, li, tr, td, th, h1, h2, h3, h4, h5, h6, blockquote, pre, hr'

/**
 * The text of a rich-text value (HTML the server sanitized, core/sanitize.ts): a list cell and its
 * tooltip show this, never the markup. DOMParser builds an inert document: nothing loads or runs.
 */
export function htmlText(html: string | null | undefined): string {
  if (!html) return ''
  const body = new DOMParser().parseFromString(html, 'text/html').body
  for (const el of body.querySelectorAll(BLOCKS)) el.after(' ')
  return (body.textContent ?? '').replace(/\s+/g, ' ').trim()
}
