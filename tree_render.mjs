// Shared rendering helpers for the parser demo: green-tree reconstruction
// from the wasm event streams (mirror of JuliaSyntax.build_tree) and the two
// highlight-layer renderers — per-token color cycling and nested parse-tree
// bounding boxes. DOM-free (returns HTML strings) so the node test can check
// them headlessly.

export const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

// The parser's output is a post-order array of RawGreenNode events
// [head, byteSpan, spanOrOrig]: flags bit 7 (in head >> 16) marks
// non-terminals, whose subtree occupies the preceding `spanOrOrig` entries;
// for terminals the third value is the original token kind.
export const NON_TERMINAL_FLAG = 1 << 7;
export const isNonTerminal = (head) =>
  ((head >> 16) & NON_TERMINAL_FLAG) !== 0;

// Reconstruct the green tree, mirroring JuliaSyntax's GreenTreeCursor:
// walk the post-order array backwards; TOMBSTONE entries are skipped as
// single entries contributing neither bytes nor children (their subtree
// entries surface as siblings). Byte ranges are 1-based inclusive.
export function buildTree(events, totalBytes, TOMBSTONE) {
  function build(idx, endByte) {
    const [head, byteSpan, spanOrOrig] = events[idx];
    const a = endByte - byteSpan + 1, b = endByte;
    if (!isNonTerminal(head)) return { head, a, b, leaf: true };
    const children = [];
    let i = idx - 1;
    let e = endByte;
    const stop = idx - spanOrOrig;
    while (i >= stop) {
      const [h, bs, so] = events[i];
      if ((h & 0xffff) === TOMBSTONE) { i -= 1; continue; }
      children.push(build(i, e));
      e -= bs;
      i -= 1 + (isNonTerminal(h) ? so : 0);
    }
    children.reverse();
    return { head, a, b, leaf: false, children };
  }
  const roots = [];
  let i = events.length - 1;
  let e = totalBytes;
  while (i >= 0) {
    const [h, bs, so] = events[i];
    if ((h & 0xffff) === TOMBSTONE) { i -= 1; continue; }
    roots.push(build(i, e));
    e -= bs;
    i -= 1 + (isNonTerminal(h) ? so : 0);
  }
  roots.reverse();
  return roots;
}

// terminals in source order with absolute 1-based inclusive byte ranges
// (post-order lists terminals in source order; non-terminals add no bytes)
export function tokensFromEvents(events) {
  const out = [];
  let pos = 1;
  for (const [head, byteSpan] of events) {
    if (isNonTerminal(head)) continue;
    out.push({ head, a: pos, b: pos + byteSpan - 1 });
    pos += byteSpan;
  }
  return out;
}

const NCOLORS = 6;
export const isErrName = (name) => name.startsWith("Error") || name === "error";

// tokens that don't contribute to a node's visual extent: whitespace trivia
// and the zero-width sentinels. Comments DO count — they sit inside the
// node's span, and excluding them would put box edges mid-comment.
export const isExtentSkipName = (name) =>
  name === "Whitespace" || name === "NewlineWs" ||
  name === "EndMarker" || name === "TOMBSTONE";

// pure delimiters: boxing every paren/comma/quote adds noise, not structure
const DELIMS = new Set(["(", ")", "[", "]", "{", "}", ",", ";",
                        "\"", "\"\"\"", "`", "```"]);
export const isDelimName = (name) => DELIMS.has(name);

// Mode 1: each non-whitespace token gets the next color in the palette.
// `tokens` is the output of tokensFromEvents.
export function renderTokensHTML(tokens, bytes, dec, kindName) {
  let html = "";
  let ci = 0;
  for (const t of tokens) {
    const name = kindName(t.head & 0xffff);
    if (name === "TOMBSTONE" || name === "EndMarker" || t.b < t.a) continue;
    const piece = dec.decode(bytes.subarray(t.a - 1, t.b));
    const isWs = name === "Whitespace" || name === "NewlineWs";
    let cls = "";
    if (isErrName(name)) {
      cls = "tok-error";
    } else if (!isWs) {
      cls = "c" + (ci % NCOLORS);
      ci++;
    }
    html += cls
      ? `<span class="${cls}" data-tok="${name}" title="${name}">${esc(piece)}</span>`
      : esc(piece);
  }
  return html;
}

// Mode 2: 2D bounding boxes around parse-tree nodes. This collects the flat
// paint-order list (parents before children, so deeper boxes draw on top);
// the page measures each byte range with a DOM Range and draws
// absolutely-positioned rectangles.
//
// A node's *display* range trims leading/trailing trivia (whitespace,
// newlines, comments): the green tree attaches surrounding trivia to
// interior nodes, but a box should hug the code — and a range that ends in
// a newline would measure as a full-container-width rect. Trimming also
// leaves whitespace for box edges to breathe in, so outset borders don't
// overlap neighboring glyphs.
//
// `height` is the node's distance to its deepest boxed descendant — used to
// outset enclosing boxes so chains of nodes with identical extents stay
// distinguishable.
export function collectBoxes(roots, kindName) {
  const out = [];
  // returns {h, lo, hi}: subtree box height and non-trivia byte extent
  function rec(node, depth) {
    const name = kindName(node.head & 0xffff);
    const err = isErrName(name);
    if (node.leaf) {
      if (err) out.push({ a: node.a, b: node.b, depth, height: 0, err, name });
      const trivia = isExtentSkipName(name) && !err;
      return { h: 0, lo: trivia ? null : node.a, hi: trivia ? null : node.b };
    }
    const entry = { a: node.a, b: node.b, depth, height: 0, err,
                    name: `[${name}]` };
    out.push(entry);
    let h = 0;
    let lo = null, hi = null;
    for (const c of node.children) {
      const r = rec(c, depth + 1);
      h = Math.max(h, r.h + 1);
      if (r.lo !== null) {
        if (lo === null) lo = r.lo;
        hi = r.hi;
      }
    }
    entry.height = h;
    if (lo !== null) {
      entry.a = lo;
      entry.b = hi;
    }
    return { h, lo, hi };
  }
  for (const r of roots) rec(r, 0);
  return out;
}

// map[byteOffset] = JS char (UTF-16 code unit) offset, for translating the
// parser's 1-based UTF-8 byte ranges into DOM Range endpoints
export function byteToCharMap(text) {
  const map = [0];
  let chars = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const n8 = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    chars += ch.length;
    for (let k = 1; k <= n8; k++) map.push(chars);
  }
  return map;
}
