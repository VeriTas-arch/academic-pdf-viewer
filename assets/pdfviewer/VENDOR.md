# PDF.js vendor

The runtime files under `lib/build` and `lib/web` come from the official PDF.js
6.2.108 generic distribution:

- Release: <https://github.com/mozilla/pdf.js/releases/tag/v6.2.108>
- Archive: `pdfjs-6.2.108-dist.zip`
- SHA-256: `7bf642d59582b475e8c48447da9b02b0108fad9742d7c2a35cb4ed6dd45e95ba`

`lib/pdf.css` is an extension-owned integration file and is not part of the
upstream archive. Source maps and these unused scripting/debug assets are omitted:

- `build/pdf.sandbox.mjs`
- `web/compressed.tracemonkey-pldi-09.pdf`
- `web/debugger.css`
- `web/debugger.js`
- `web/debugger.mjs`
- `web/wasm/quickjs-eval.js`
- `web/wasm/quickjs-eval.wasm`

Use the independent `npm run pdfjs:check`, `npm run pdfjs:update`, and
`npm run pdfjs:verify` commands to maintain this bundle.
