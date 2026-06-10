// JS host for the wasm-compiled JuliaSyntax parser. Works in Node 22+ and any
// browser with WasmGC.
//
// Strings are wasm-GC-resident byte arrays: the host builds/reads them
// through the exported __str_new/__str_set/__str_len/__str_get accessors and
// otherwise handles opaque externref handles. Beyond the event sinks
// (emit_token/emit_node) and Symbol identity (egal), the imports are the
// _hb_* byte bridge (float-literal parsing with a strtod emulation incl.
// hexfloats) and string formatting for diagnostic messages (repr,
// print_to_string, _string) — those receive and return wasm-string handles.

import { HOSTCONSTS, IMPORTS } from "./parser_meta.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Julia Char carries its UTF-8 bytes left-aligned in 32 bits
function charBitsToString(u) {
  u = u >>> 0;
  const bytes = [];
  for (let sh = 24; sh >= 0; sh -= 8) {
    const b = (u >>> sh) & 0xff;
    if (bytes.length > 0 && b === 0) break;
    bytes.push(b);
  }
  while (bytes.length > 1 && bytes[bytes.length - 1] === 0) bytes.pop();
  return decoder.decode(new Uint8Array(bytes));
}

function reprChar(u) {
  const s = charBitsToString(u);
  const esc =
    s === "\\" ? "\\\\" : s === "'" ? "\\'" :
    s === "\n" ? "\\n" : s === "\t" ? "\\t" : s === "\r" ? "\\r" : s;
  return `'${esc}'`;
}

// strtod emulation: decimal via parseFloat, hexfloats by hand. Returns
// [value, status] with the ERANGE convention: 0 ok, 1 underflow, 2 overflow.
function strtod(s) {
  s = s.trim();
  let v;
  const hex = /^([+-]?)0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?(?:[pP]([+-]?\d+))?$/.exec(s);
  if (hex) {
    const [, sign, intpart = "", fracpart = "", exppart] = hex;
    let digits = 0n;
    for (const c of intpart + fracpart) digits = digits * 16n + BigInt(parseInt(c, 16));
    const e2 = (exppart !== undefined ? parseInt(exppart, 10) : 0) - 4 * fracpart.length;
    v = Number(digits) * Math.pow(2, e2); // Number(BigInt) rounds to nearest
    if (sign === "-") v = -v;
  } else {
    v = parseFloat(s);
  }
  const mantNonzero = /[1-9a-fA-F]/.test(s.replace(/[pPeE][+-]?\d+$/, ""));
  const status = !isFinite(v) ? 2 : v === 0 && mantNonzero ? 1 : 0;
  return [v, status];
}

export async function instantiateParser(wasmBytes) {
  let nodeSink = [];
  let hbuf = [];
  let hbStatus = 0;
  let exp = null; // instance exports, set after instantiation

  function makeString(text) {
    const bytes = typeof text === "string" ? encoder.encode(text) : text;
    const h = exp.__str_new(bytes.length);
    for (let i = 0; i < bytes.length; i++) exp.__str_set(h, i, bytes[i]);
    return h;
  }
  function readString(h) {
    const n = exp.__str_len(h);
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = exp.__str_get(h, i);
    return decoder.decode(bytes);
  }
  // an externref arg is either one of our Symbol-constant objects or an
  // opaque wasm-string handle
  const refToString = (x) =>
    x === null || x === undefined ? "nothing" :
    x.sym !== undefined ? x.sym : readString(x);

  const imports = { julia: {} };
  for (const name of IMPORTS) {
    let fn;
    if (name.includes("emit_node")) {
      fn = (a, b, c) => { nodeSink.push([Number(a), Number(b), Number(c)]); };
    } else if (name.includes("egal")) {
      fn = (a, b) => (a === b ? 1 : 0);
    } else if (name.includes("_hb_reset")) {
      fn = () => { hbuf = []; };
    } else if (name.includes("_hb_push")) {
      fn = (b) => { hbuf.push(Number(b) & 0xff); };
    } else if (name.includes("_hb_status")) {
      fn = () => hbStatus;
    } else if (name.includes("_hb_parse_f64")) {
      fn = () => {
        const [v, st] = strtod(decoder.decode(new Uint8Array(hbuf)));
        hbStatus = st;
        return v;
      };
    } else if (name.includes("_hb_parse_f32")) {
      fn = () => {
        const s = decoder.decode(new Uint8Array(hbuf));
        let [v, st] = strtod(s);
        const v32 = Math.fround(v);
        if (st === 0 && !isFinite(v32)) st = 2;
        if (st === 0 && v32 === 0 && v !== 0) st = 1;
        hbStatus = st;
        return v32;
      };
    } else if (name.includes("repr")) {
      fn = (x) =>
        makeString(typeof x === "object" && x !== null
          ? JSON.stringify(refToString(x))
          : reprChar(Number(x)));
    } else if (name.includes("print_to_string") || name.includes("_string")) {
      fn = (...args) =>
        makeString(args.map((a) =>
          typeof a === "bigint" ? a.toString() :
          typeof a === "number" ? String(a) : refToString(a)).join(""));
    } else {
      fn = () => { throw new Error(`unexpected host import ${name}`); };
    }
    imports.julia[name] = fn;
  }

  HOSTCONSTS.forEach(([name, kind, value], k) => {
    imports.julia[name] = new WebAssembly.Global(
      { value: "externref", mutable: false },
      { hostconst: k, sym: value },
    );
  });

  const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
  exp = instance.exports;
  const parse_into = exp.parse_into;

  return {
    // vminor selects the Julia syntax version v1.<vminor>
    parse(text, vminor = 14) {
      nodeSink = [];
      const n = Number(parse_into(makeString(text), BigInt(vminor)));
      return { count: n, events: nodeSink };
    },
  };
}
