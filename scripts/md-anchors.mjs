// Markdown heading anchors as GitHub renders them, shared by the check hints and the AI docs check.

/** GitHub 标题锚点：去掉行内链接与标签，小写，去掉除 `-`、`_` 以外的标点（中文标点同样去掉），空格换成 `-`。 */
export const slug = (heading) =>
  heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-')

/** 一篇 Markdown 的全部锚点：代码块外的标题（重名依次加 -1、-2）与显式的 `<a id>` / `<a name>`。 */
export function anchorsOf(text) {
  const out = new Set()
  const seen = new Map()
  let fence = false
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    if (fence) continue
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) {
      const s = slug(heading[1])
      const n = seen.get(s) ?? 0
      seen.set(s, n + 1)
      out.add(n ? `${s}-${n}` : s)
    }
    for (const m of line.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) out.add(m[1])
  }
  return out
}
