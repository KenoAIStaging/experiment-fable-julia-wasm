// JS host for the wasm-compiled JuliaSyntax lexer. Works in Node 22+ and any
// browser with WasmGC (Chrome 119+, Firefox 120+, Safari 18.4+).
//
// Strings are wasm-GC-resident byte arrays (no JS-string mapping): the host
// builds the input text inside wasm through the exported __str_new/__str_set
// accessors and passes the resulting opaque handle to the entry point. The
// remaining imports are the emit_token sink and `===` on Symbol constants.

import { HOSTCONSTS, IMPORTS } from "./lexer_meta.js";

export async function instantiateLexer(wasmBytes) {
  let sink = [];
  let exp = null; // instance exports, set after instantiation
  const imports = { julia: {} };

  for (const name of IMPORTS) {
    if (name.includes("emit_token")) {
      imports.julia[name] = (kind, a, b) => {
        sink.push([Number(kind), Number(a), Number(b)]);
      };
    } else if (name.includes("egal")) {
      // Julia === on host constants (Symbols): identity
      imports.julia[name] = (a, b) => (a === b ? 1 : 0);
    } else {
      imports.julia[name] = () => {
        throw new Error(`unexpected host import ${name}`);
      };
    }
  }
  // host constants: Symbols (and other opaque values) as identity tokens
  HOSTCONSTS.forEach(([name, kind, value], k) => {
    imports.julia[name] = new WebAssembly.Global(
      { value: "externref", mutable: false },
      { hostconst: k, sym: value },
    );
  });

  const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
  exp = instance.exports;
  const lex_into = exp.lex_into;
  const encoder = new TextEncoder();

  function makeString(text) {
    const bytes = encoder.encode(text);
    const h = exp.__str_new(bytes.length);
    for (let i = 0; i < bytes.length; i++) exp.__str_set(h, i, bytes[i]);
    return h;
  }

  return {
    lex(text) {
      sink = [];
      const n = lex_into(makeString(text));
      return { count: Number(n), tokens: sink };
    },
  };
}
