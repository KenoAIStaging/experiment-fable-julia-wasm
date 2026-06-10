// JS host for the wasm-compiled JuliaSyntax lexer. Works in Node 22+ and any
// browser with WasmGC (Chrome 119+, Firefox 120+, Safari 18.4+).
//
// The wasm module needs four kinds of host support, all trivial:
//   - codeunit/ncodeunits: byte access on the source text (we pass the text as
//     an opaque externref wrapping {bytes: Uint8Array})
//   - egal: identity comparison of host constants (Symbols)
//   - emit_token: the token sink
//   - "julia"."const_K" externref globals: opaque host-constant tokens

import { HOSTCONSTS, IMPORTS } from "./lexer_meta.js";

export async function instantiateLexer(wasmBytes) {
  let sink = [];
  const imports = { julia: {} };

  for (const name of IMPORTS) {
    if (name.includes("emit_token")) {
      imports.julia[name] = (kind, a, b) => {
        sink.push([Number(kind), Number(a), Number(b)]);
      };
    } else if (name.includes("ncodeunits")) {
      imports.julia[name] = (s) => BigInt(s.bytes.length);
    } else if (name.includes("codeunit")) {
      imports.julia[name] = (s, i) => {
        const idx = Number(i) - 1;
        if (idx < 0 || idx >= s.bytes.length) throw new Error("codeunit OOB");
        return s.bytes[idx];
      };
    } else if (name.includes("egal")) {
      // Julia === : identity, except Strings compare by content
      imports.julia[name] = (a, b) =>
        a === b || (a?.str !== undefined && b?.str !== undefined && a.str === b.str)
          ? 1
          : 0;
    } else {
      imports.julia[name] = () => {
        throw new Error(`unexpected host import ${name}`);
      };
    }
  }
  // host constants: Strings carry their bytes (codeunit/ncodeunits work on
  // them); Symbols and other values are opaque identity tokens
  const encoder0 = new TextEncoder();
  HOSTCONSTS.forEach(([name, kind, value], k) => {
    const obj =
      kind === "string"
        ? { bytes: encoder0.encode(value), str: value }
        : { hostconst: k, sym: value };
    imports.julia[name] = new WebAssembly.Global(
      { value: "externref", mutable: false },
      obj,
    );
  });

  const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
  const lex_into = instance.exports.lex_into;
  const encoder = new TextEncoder();

  return {
    lex(text) {
      sink = [];
      const n = lex_into({ bytes: encoder.encode(text) });
      return { count: Number(n), tokens: sink };
    },
  };
}
