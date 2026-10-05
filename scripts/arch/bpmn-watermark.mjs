// bpmn-js is used under the bpmn.io license, whose watermark (the logo bpmn-js renders
// at the bottom right of every diagram) must stay visible, unobscured and unchanged. Nothing in the web app
// may target it: its class, an `a`/`img` under the diagram container, a `bpmn.io` attribute selector,
// `powered` in the BPMN views' styles, or the embedded-font stylesheet. Only apps/web/src (what ships) is
// scanned: the Playwright specs in apps/web/e2e have to locate the logo to assert it. Comment-only lines pass.
// A line heuristic; a selector built at runtime from parts slips through, the Playwright watermark
// test (visibility, hit-test, opacity chain, pixel self-compare) is the backstop.
const BPMN_VIEWS = /^apps\/web\/src\/views\/workflow\/bpmn\//

const BAD = [
  [/bjs-powered-by/, 'targets the bpmn.io watermark class'],
  [
    /\.bjs-container(?![-\w])[^{},;'"`]*?[\s>~+(](?:a|img)(?![-\w])/,
    'targets an a/img under .bjs-container (the watermark)',
  ],
  [/\[[^\]]*bpmn\.io[^\]]*\]/, 'is a bpmn.io attribute selector (the watermark link)'],
  [/bpmn-embedded\.css/, 'imports bpmn-embedded.css'],
]

export default function ({ lines }) {
  const out = []
  let file = ''
  let inStyle = false
  for (const { file: f, n, line } of lines(
    'apps/web/src/**/*.{ts,tsx,js,mjs,vue,css,scss,less,html}',
  )) {
    if (f !== file) [file, inStyle] = [f, /\.(css|scss|less)$/.test(f)]
    if (f.endsWith('.vue') && /<style\b/.test(line)) inStyle = true
    for (const [re, why] of BAD) if (re.test(line)) out.push(`${f}:${n} ${why} (bpmn.io watermark)`)
    if (inStyle && BPMN_VIEWS.test(f) && /powered/i.test(line))
      out.push(`${f}:${n} styles "powered" in the BPMN views (bpmn.io watermark)`)
    if (f.endsWith('.vue') && /<\/style>/.test(line)) inStyle = false
  }
  return out
}
