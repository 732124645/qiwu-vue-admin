// core/sanitize.ts (see docs/design-notes.md#security): the fixed rich-text allow-list.
import { sanitizeRichText as clean, sanitizeFields } from '../../src/core/sanitize.js'

describe('sanitizeRichText', () => {
  it('keeps the editor formatting: headings, lists, tables, marks, links and our images', () => {
    const html =
      '<h2>T</h2><p><strong>b</strong> <em>i</em> <u>u</u> <s>s</s> <code>c</code></p>' +
      '<ol start="3"><li>x</li></ol><blockquote>q</blockquote><pre><code>code</code></pre>' +
      '<table><thead><tr><th colspan="2">h</th></tr></thead><tbody><tr><td rowspan="2">d</td></tr></tbody></table>' +
      '<p><img src="/files/2026/09/27/a.png" alt="a" width="120" /><img src="https://cdn.example.com/b.webp" /></p>' +
      '<p><a href="mailto:x@example.com">m</a></p><hr />'
    expect(clean(html)).toBe(
      html.replace('"mailto:x@example.com"', '"mailto:x@example.com" rel="noopener noreferrer"'),
    )
  })

  it('drops style, class, id, data-* and every on* attribute', () => {
    expect(
      clean(
        '<p style="color:red" class="c" id="i" data-x="1" onclick="alert(1)" onmouseover="x()">Hi</p>',
      ),
    ).toBe('<p>Hi</p>')
    expect(clean('<img src=x onerror=alert(1)>')).toBe('<img src="x" />')
    expect(clean('<span style="background:url(javascript:alert(1))">s</span>')).toBe(
      '<span>s</span>',
    )
  })

  it('drops script, style, iframe, object, form, svg and media tags with their scripts', () => {
    expect(
      clean(
        '<script>alert(1)</script><style>p{color:red}</style><iframe src="https://x.example"></iframe>' +
          '<object data="x.swf"></object><form action="/x"><input name="a"></form>' +
          '<svg onload="alert(1)"><script>alert(2)</script></svg><video src="v.mp4"></video><p>ok</p>',
      ),
    ).toBe('<p>ok</p>')
  })

  it('URLs: http, https, mailto and relative only; javascript:, data: and //host dropped', () => {
    const href = (h: string) => clean(`<a href="${h}">x</a>`)
    const none = '<a rel="noopener noreferrer">x</a>'
    for (const bad of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      'java&#x09;script:alert(1)',
      '&#106;avascript:alert(1)',
      'vbscript:msgbox(1)',
      'data:text/html,<script>alert(1)</script>',
      '//evil.example/x',
    ])
      expect(href(bad)).toBe(none)
    expect(href('https://example.com/a?b=1')).toBe(
      '<a href="https://example.com/a?b=1" rel="noopener noreferrer">x</a>',
    )
    expect(clean('<img src="data:image/png;base64,iVBORw0KGgo=" alt="d" />')).toBe(
      '<img alt="d" />',
    )
    expect(clean('<img src="//evil.example/x.png" />')).toBe('<img />')
    expect(clean('<img src="mailto:x@example.com" />')).toBe('<img />')
  })

  it('links: target only _blank, rel always noopener noreferrer (a given rel replaced)', () => {
    expect(clean('<a href="https://a.example" target="_blank" rel="opener">x</a>')).toBe(
      '<a href="https://a.example" rel="noopener noreferrer" target="_blank">x</a>',
    )
    expect(clean('<a href="https://a.example" target="_top">x</a>')).toBe(
      '<a href="https://a.example" rel="noopener noreferrer">x</a>',
    )
  })

  it('escapes text: markup in text stays text', () => {
    expect(clean('<p>&lt;script&gt;alert(1)&lt;/script&gt; 1 < 2</p>')).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt; 1 &lt; 2</p>',
    )
  })
})

it('sanitizeFields: the named string fields of a copy, the rest as they are', () => {
  const dto = { body: '<p onclick="x()">a</p><script>x()</script>', title: '<b>t</b>', note: null }
  expect(sanitizeFields(dto, ['body', 'note', 'missing'])).toEqual({
    body: '<p>a</p>',
    title: '<b>t</b>',
    note: null,
  })
  expect(dto.body).toContain('onclick')
})
