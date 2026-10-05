// Vitest setup (not a spec), before every web spec file.
// happy-dom's Element#toString returns its outerHTML (a browser's says "[object HTMLDivElement]"). Popper.js,
// under every Element Plus select, tooltip and popover, calls it on each node it measures to tell a window
// from an element: every popper update serialized whole subtrees, up to the page, and popper-heavy pages
// spent half their test time there (2 s of the 4 s of codegen-edit). The browser's answer, from Node
// (absent in the `node` environment specs):
if (typeof Element !== 'undefined') Element.prototype.toString = Node.prototype.toString
