# Julia lexer in the browser

`lexer.wasm` is the actual `JuliaSyntax.Tokenize` lexer, compiled from Julia's
optimized IR by WasmCodegen (no manual port). The page tokenizes as you type,
entirely client-side; unicode classification runs in-wasm (UnicodeNext tables
as wasm GC arrays). The only JS imports are `codeunit`/`ncodeunits` on the
input text, `===` on host constants, and the `emit_token` sink.

Serve over HTTP (wasm cannot be fetched from file://):

    cd examples/web && python3 -m http.server 8000
    # open http://localhost:8000  (Chrome 119+, Firefox 120+, Safari 18.4+)

Rebuild after compiler changes:

    julia --project=/workspace examples/lexer/build_web.jl
    node examples/web/test_node.mjs     # headless verification under V8
