import sanitizeHtml from 'sanitize-html'

/**
 * The one rich-text allow-list (XSS; see docs/design-notes.md#security): bulletin bodies and mail templates. Applied
 * when the HTML is saved, so the stored text is what `v-html` may render. Fixed on purpose (no runtime
 * config): no `style`, `class`, `id`, `on*` or other attribute beyond the few below, no script / style /
 * iframe / object / form / svg / media tags, URLs only `http` / `https` / `mailto` (images `http` /
 * `https`: no `data:`), relative URLs (our `/files/…` images) kept, protocol-relative ones (`//host`)
 * dropped. Links always get `rel="noopener noreferrer"`; `target` may only be `_blank`.
 */
const RICH_TEXT: sanitizeHtml.IOptions = {
  allowedTags: [
    'p',
    'br',
    'hr',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'blockquote',
    'pre',
    'code',
    'ul',
    'ol',
    'li',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'a',
    'img',
    'span',
    'strong',
    'b',
    'em',
    'i',
    'u',
    's',
    'del',
    'sub',
    'sup',
  ],
  allowedAttributes: {
    a: ['href', 'rel', 'target'],
    img: ['src', 'alt', 'width', 'height'],
    th: ['colspan', 'rowspan'],
    td: ['colspan', 'rowspan'],
    ol: ['start'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https'] },
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  transformTags: {
    a: (tagName, { target, ...attribs }) => ({
      tagName,
      attribs: { ...attribs, ...(target === '_blank' && { target }), rel: 'noopener noreferrer' },
    }),
  },
}

/** `html` reduced to the rich-text allow-list; the result is safe for `v-html`. */
export const sanitizeRichText = (html: string): string => sanitizeHtml(html, RICH_TEXT)

/**
 * `dto` with each of its `fields` that is a string reduced to the allow-list (a copy): the rich-text
 * columns of a write (generated services, codegen `richtext`), whatever the client sent.
 */
export function sanitizeFields<T extends object>(dto: T, fields: readonly string[]): T {
  const out = { ...dto } as Record<string, unknown>
  for (const f of fields) if (typeof out[f] === 'string') out[f] = sanitizeRichText(out[f])
  return out as T
}
